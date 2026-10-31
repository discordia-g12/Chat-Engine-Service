import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import WebSocket from 'ws';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { Message } from '../src/models/Message';
import { ReadState } from '../src/models/ReadState';
import { ChatService } from '../src/services/ChatService';
import { UNREAD_COUNT_CAP } from '../src/services/ReadStateService';
import { MAX_MENTIONS, parseMentions } from '../src/helpers/mentions';

describe('parseMentions', () => {
  it('finds users, roles and @everyone, without repeating', () => {
    assert.deepStrictEqual(parseMentions('hola <@auth0|ana> y <@google-oauth2|123>, <@&r-mods> <@auth0|ana> @everyone'), {
      userIds: ['auth0|ana', 'google-oauth2|123'],
      roleIds: ['r-mods'],
      everyone: true,
    });
  });

  it('does not take a role as a user', () => {
    assert.deepStrictEqual(parseMentions('<@&r-1>'), { userIds: [], roleIds: ['r-1'], everyone: false });
  });

  it('only takes @everyone as a word', () => {
    for (const text of ['mail@everyone', '@everyones', '@everyone-ish', 'everyone', '@@everyone']) {
      assert.strictEqual(parseMentions(text).everyone, false, text);
    }
    for (const text of ['@everyone', '(@everyone)', 'hola @everyone!', '@everyone, vengan']) {
      assert.strictEqual(parseMentions(text).everyone, true, text);
    }
  });

  it('ignores malformed tokens', () => {
    assert.deepStrictEqual(parseMentions('<@> <@ ana> <@&> <@a b> @ana'), { userIds: [], roleIds: [], everyone: false });
  });

  it(`keeps at most ${MAX_MENTIONS} users and roles`, () => {
    const users = Array.from({ length: 15 }, (_, i) => `<@u${i}>`).join(' ');
    const roles = Array.from({ length: 10 }, (_, i) => `<@&r${i}>`).join(' ');

    const parsed = parseMentions(`${users} ${roles}`);
    assert.strictEqual(parsed.userIds.length, 15);
    assert.deepStrictEqual(parsed.roleIds, ['r0', 'r1', 'r2', 'r3', 'r4']);
  });
});

// Core simulado: 'admin' tiene MENTION_EVERYONE; 'me' tiene el rol r-mods
const ROLES = new Map([['me', ['r-mods']]]);
const SERVER_ROLES = ['r-mods', 'r-other'];

describe('Mentions', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let port: number;
  let originalFetch: typeof globalThis.fetch;
  let coreDown = false;
  let accessCalls = 0;

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const parsed = new URL(url.toString());
      if (coreDown) throw new Error('fetch failed');
      const visible = parsed.pathname.match(/\/internal\/users\/([^/]+)\/visible-channels$/);
      if (visible) {
        const userId = decodeURIComponent(visible[1]);
        return { status: 200, json: async () => ({ channel_ids: ['general'], role_ids: ROLES.get(userId) ?? [] }) } as Response;
      }
      accessCalls++;
      const admin = parsed.searchParams.get('user_id') === 'admin';
      return {
        status: 200,
        json: async () => ({
          server_id: 'srv-1',
          can_send: true,
          muted_until: null,
          can_mention_everyone: admin,
          mentionable_role_ids: admin ? SERVER_ROLES : [],
        }),
      } as Response;
    });

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();

    app = buildApp();
    await app.listen({ port: 0 });
    port = (app.server.address() as { port: number }).port;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    coreDown = false;
    accessCalls = 0;
    await Message.deleteMany({});
    await ReadState.deleteMany({});
  });

  const send = (authorId: string, content: string) => ChatService.sendMessage(authorId, 'general', content, true);

  const unread = async (userId: string) => {
    const res = await app.inject({ method: 'GET', url: '/unread', headers: { 'x-user-id': userId } });
    assert.strictEqual(res.statusCode, 200);
    return res.json().channels as { channelId: string; unreadCount: number; mentionCount: number }[];
  };

  describe('sending', () => {
    it('saves user mentions without asking Core', async () => {
      const sent = await send('other', 'hola <@me>');

      assert.deepStrictEqual(sent.mentions, { users: ['me'], roles: [], everyone: false });
      assert.strictEqual(accessCalls, 0);
      const saved = await Message.findById(sent.id).lean();
      assert.deepStrictEqual(saved?.mentionUserIds, ['me']);
    });

    it('a message without mentions saves no mention fields', async () => {
      const sent = await send('other', 'hola');

      assert.deepStrictEqual(sent.mentions, { users: [], roles: [], everyone: false });
      const saved = await Message.findById(sent.id).lean();
      assert.strictEqual(saved?.mentionUserIds, undefined);
      assert.strictEqual(saved?.mentionRoleIds, undefined);
      assert.strictEqual(saved?.mentionEveryone, undefined);
    });

    it('with MENTION_EVERYONE, @everyone and the server roles notify', async () => {
      const sent = await send('admin', '@everyone y <@&r-mods>');

      assert.deepStrictEqual(sent.mentions, { users: [], roles: ['r-mods'], everyone: true });
      assert.strictEqual(accessCalls, 1);
    });

    it('roles of another server are left as text', async () => {
      const sent = await send('admin', '<@&r-mods> <@&r-from-another-server>');

      assert.deepStrictEqual(sent.mentions.roles, ['r-mods']);
    });

    it('without MENTION_EVERYONE, @everyone and roles are plain text (CA 4)', async () => {
      const sent = await send('other', '@everyone <@&r-mods> <@me>');

      assert.strictEqual(sent.content, '@everyone <@&r-mods> <@me>');
      assert.deepStrictEqual(sent.mentions, { users: ['me'], roles: [], everyone: false });
      const saved = await Message.findById(sent.id).lean();
      assert.strictEqual(saved?.mentionEveryone, undefined);
      assert.strictEqual(saved?.mentionRoleIds, undefined);
    });

    it('fails (503) without saving when @everyone has to be checked and Core is down', async () => {
      coreDown = true;

      await assert.rejects(send('admin', '@everyone'), { name: 'UpstreamUnavailableError' });
      assert.strictEqual(await Message.countDocuments({}), 0);
    });

    it('user mentions still work when Core is down', async () => {
      coreDown = true;

      const sent = await send('other', '<@me>');
      assert.deepStrictEqual(sent.mentions.users, ['me']);
    });

    it('the WebSocket broadcast and the history carry the mentions', async () => {
      const received = await new Promise<{ id: string; mentions: unknown }>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}/channels/general/ws`, { headers: { 'x-user-id': 'admin' } });
        ws.on('open', () => ws.send(JSON.stringify({ content: '@everyone <@me>' })));
        ws.on('message', (data) => {
          ws.close();
          resolve(JSON.parse(data.toString()));
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Timeout waiting for the sent message')), 2000);
      });
      assert.deepStrictEqual(received.mentions, { users: ['me'], roles: [], everyone: true });

      await Message.create({ channelId: 'general', authorId: 'other', content: 'mensaje anterior a #46' });
      const history = await app.inject({
        method: 'GET',
        url: '/channels/general/messages',
        headers: { 'x-user-id': 'me' },
      });
      const messages = history.json().messages as { mentions: unknown }[];
      assert.deepStrictEqual(messages[0].mentions, { users: ['me'], roles: [], everyone: true });
      assert.deepStrictEqual(messages[1].mentions, { users: [], roles: [], everyone: false });
    });
  });

  describe('mentionCount in GET /unread', () => {
    it('counts direct, @everyone and own-role mentions, not the rest', async () => {
      await unread('me');
      await send('other', 'hola <@me>');
      await send('admin', '@everyone');
      await send('admin', '<@&r-mods>');
      await send('admin', '<@&r-other>'); // rol que no tiene
      await send('other', '@everyone'); // sin permiso: texto plano
      await send('other', 'sin menciones');
      await send('me', '<@me> @everyone'); // propio: no cuenta

      assert.deepStrictEqual(await unread('me'), [{ channelId: 'general', unreadCount: 6, mentionCount: 3 }]);
    });

    it('a message with several mentions of the user counts once', async () => {
      await unread('me');
      await send('admin', '<@me> <@&r-mods> @everyone');

      assert.deepStrictEqual(await unread('me'), [{ channelId: 'general', unreadCount: 1, mentionCount: 1 }]);
    });

    it('read mentions stop counting', async () => {
      await unread('me');
      const first = await send('other', '<@me>');
      await send('other', '<@me> otra vez');

      await app.inject({
        method: 'POST',
        url: '/channels/general/read',
        headers: { 'x-user-id': 'me' },
        payload: { messageId: first.id },
      });
      assert.deepStrictEqual(await unread('me'), [{ channelId: 'general', unreadCount: 1, mentionCount: 1 }]);

      await app.inject({ method: 'POST', url: '/read-states/read-all', headers: { 'x-user-id': 'me' } });
      assert.deepStrictEqual(await unread('me'), []);
    });

    it('a user without roles only gets direct and @everyone mentions', async () => {
      await unread('nobody');
      await send('admin', '<@&r-mods>');
      await send('admin', '@everyone');

      assert.deepStrictEqual(await unread('nobody'), [{ channelId: 'general', unreadCount: 2, mentionCount: 1 }]);
    });

    it('caps the mention count like the unread count', async () => {
      await unread('me');
      await Message.insertMany(
        Array.from({ length: UNREAD_COUNT_CAP + 5 }, () => ({
          channelId: 'general',
          authorId: 'other',
          content: '<@me>',
          mentionUserIds: ['me'],
        }))
      );

      assert.deepStrictEqual(await unread('me'), [
        { channelId: 'general', unreadCount: UNREAD_COUNT_CAP, mentionCount: UNREAD_COUNT_CAP },
      ]);
    });
  });
});
