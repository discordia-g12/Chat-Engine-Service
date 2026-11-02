import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import WebSocket from 'ws';
import { Types } from 'mongoose';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { Message } from '../src/models/Message';
import { ReadState } from '../src/models/ReadState';
import { UNREAD_COUNT_CAP } from '../src/services/ReadStateService';

// Canales que Core dice que el usuario puede ver; 'hidden' existe pero no lo puede ver
const VISIBLE = ['general', 'random'];

describe('Read states (unread per channel)', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let port: number;
  let originalFetch: typeof globalThis.fetch;
  let coreDown = false;

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (coreDown) throw new Error('fetch failed');
      if (urlStr.includes('/visible-channels')) {
        return { status: 200, json: async () => ({ channel_ids: VISIBLE }) } as Response;
      }
      if (urlStr.includes('/channels/hidden/')) {
        return { status: 403 } as Response;
      }
      return { status: 200, json: async () => ({ server_id: 'srv-1', can_send: true, muted_until: null }) } as Response;
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
    await Message.deleteMany({});
    await ReadState.deleteMany({});
  });

  const getUnread = (userId: string) =>
    app.inject({ method: 'GET', url: '/unread', headers: { 'x-user-id': userId } });

  const unreadByChannel = async (userId: string) => {
    const res = await getUnread(userId);
    assert.strictEqual(res.statusCode, 200);
    return Object.fromEntries(
      (res.json().channels as { channelId: string; unreadCount: number }[]).map((c) => [c.channelId, c.unreadCount])
    );
  };

  const markRead = (userId: string, channelId: string, body?: object) =>
    app.inject({
      method: 'POST',
      url: `/channels/${channelId}/read`,
      headers: { 'x-user-id': userId },
      ...(body ? { payload: body } : {}),
    });

  const post = (channelId: string, authorId: string, content = 'hola') =>
    Message.create({ channelId, authorId, content });

  /** Desde acá se cuenta lo no leído (el usuario ya consultó los no leídos una vez). */
  const startTracking = async (userId: string) => {
    await getUnread(userId);
  };

  it('rejects requests without X-User-Id', async () => {
    assert.strictEqual((await app.inject({ method: 'GET', url: '/unread' })).statusCode, 401);
    assert.strictEqual(
      (await app.inject({ method: 'POST', url: '/read-states/read-all' })).statusCode,
      401
    );
  });

  it('a channel never seen starts with nothing unread, even with previous history', async () => {
    await post('general', 'other');
    await post('general', 'other');

    assert.deepStrictEqual(await unreadByChannel('me'), {});
  });

  it('counts the new messages of others, but not your own', async () => {
    await startTracking('me');
    await post('general', 'other');
    await post('general', 'other');
    await post('general', 'me');
    await post('random', 'other');

    const res = await getUnread('me');
    assert.deepStrictEqual(
      res.json().channels.sort((a: { channelId: string }, b: { channelId: string }) => a.channelId.localeCompare(b.channelId)),
      [
        { channelId: 'general', unreadCount: 2, mentionCount: 0 },
        { channelId: 'random', unreadCount: 1, mentionCount: 0 },
      ]
    );
  });

  it('does not count channels the user cannot see', async () => {
    await startTracking('me');
    await post('hidden', 'other');

    assert.deepStrictEqual(await unreadByChannel('me'), {});
  });

  it('caps the count', async () => {
    await startTracking('me');
    await Message.insertMany(
      Array.from({ length: UNREAD_COUNT_CAP + 5 }, (_, i) => ({ channelId: 'general', authorId: 'other', content: `m${i}` }))
    );

    assert.deepStrictEqual(await unreadByChannel('me'), { general: UNREAD_COUNT_CAP });
  });

  it('opening the channel marks it read up to the last message', async () => {
    await startTracking('me');
    await post('general', 'other');
    await post('random', 'other');

    const res = await markRead('me', 'general');

    assert.strictEqual(res.statusCode, 204);
    assert.deepStrictEqual(await unreadByChannel('me'), { random: 1 });
  });

  it('marks read up to a given message, and never goes back', async () => {
    await startTracking('me');
    const first = await post('general', 'other');
    await post('general', 'other');
    const last = await post('general', 'other');

    await markRead('me', 'general', { messageId: first.id });
    assert.deepStrictEqual(await unreadByChannel('me'), { general: 2 });

    await markRead('me', 'general', { messageId: last.id });
    // Un pedido viejo que llega tarde no vuelve a marcar como no leído
    const late = await markRead('me', 'general', { messageId: first.id });
    assert.strictEqual(late.statusCode, 204);
    assert.deepStrictEqual(await unreadByChannel('me'), {});
  });

  it('marking an empty channel read does not hide the messages that come later', async () => {
    await markRead('me', 'general');
    // Mismo segundo que la marca: igual tiene que contar
    await post('general', 'other');

    assert.deepStrictEqual(await unreadByChannel('me'), { general: 1 });
  });

  it('rejects an invalid messageId (400) or one from another channel (404)', async () => {
    const elsewhere = await post('random', 'other');

    const invalid = await markRead('me', 'general', { messageId: 'nope' });
    assert.strictEqual(invalid.statusCode, 400);

    const otherChannel = await markRead('me', 'general', { messageId: elsewhere.id });
    assert.strictEqual(otherChannel.statusCode, 404);

    const unknown = await markRead('me', 'general', { messageId: new Types.ObjectId().toString() });
    assert.strictEqual(unknown.statusCode, 404);
  });

  it('cannot mark a channel the user cannot see (403)', async () => {
    const res = await markRead('me', 'hidden');

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(await ReadState.countDocuments({ userId: 'me', channelId: 'hidden' }), 0);
  });

  it('marks every visible channel read at once', async () => {
    await startTracking('me');
    await post('general', 'other');
    await post('random', 'other');

    const res = await app.inject({ method: 'POST', url: '/read-states/read-all', headers: { 'x-user-id': 'me' } });

    assert.strictEqual(res.statusCode, 204);
    assert.deepStrictEqual(await unreadByChannel('me'), {});
  });

  it('answers 503 when Core is unreachable', async () => {
    coreDown = true;

    const res = await getUnread('me');

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().detail, 'Failed to communicate with permission service');
  });

  it('sending a message over the WebSocket marks the channel read for the sender', async () => {
    await startTracking('me');
    await post('general', 'other');

    const sent = await new Promise<{ id: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/channels/general/ws`, { headers: { 'x-user-id': 'me' } });
      ws.on('open', () => ws.send(JSON.stringify({ content: 'ya leí todo' })));
      ws.on('message', (data) => {
        ws.close();
        resolve(JSON.parse(data.toString()));
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout waiting for the sent message')), 2000);
    });

    // La actualización es en segundo plano: se espera a que se aplique
    for (let i = 0; i < 20; i++) {
      const state = await ReadState.findOne({ userId: 'me', channelId: 'general' }).lean();
      if (state?.lastReadMessageId.toString() === sent.id) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepStrictEqual(await unreadByChannel('me'), {});
  });
});
