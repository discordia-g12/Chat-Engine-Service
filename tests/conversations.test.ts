import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import WebSocket from 'ws';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { Conversation } from '../src/models/Conversation';
import { Message } from '../src/models/Message';
import { ReadState } from '../src/models/ReadState';
import { EventConsumer } from '../src/services/EventConsumer';
import { RelationsService } from '../src/services/RelationsService';
import { StorageService } from '../src/services/StorageService';
import { PresenceService } from '../src/services/PresenceService';
import { PubSubService } from '../src/services/PubSubService';
import { SessionManager } from '../src/services/SessionManager';
import { UNREAD_COUNT_CAP } from '../src/services/ReadStateService';

type Json = Record<string, unknown>;

const waitFor = async (check: () => boolean, what: string) => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

class FakePresenceRedis {
  keys = new Map<string, string>();
  sets: string[] = [];
  failReads = false;
  failWrites = false;

  async set(key: string, value: string, _mode?: 'EX', seconds?: number) {
    if (this.failWrites) throw new Error('redis down');
    // La conexión vence a los 60 s; la preferencia no vence
    assert.strictEqual(seconds, key.startsWith('presence:pref:') ? undefined : 60);
    this.keys.set(key, value);
    this.sets.push(key);
  }

  async del(key: string) {
    if (this.failWrites) throw new Error('redis down');
    this.keys.delete(key);
  }

  async mget(keys: string[]) {
    if (this.failReads) throw new Error('redis down');
    return keys.map((key) => this.keys.get(key) ?? null);
  }
}

describe('Direct messages', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let port: number;
  let originalFetch: typeof globalThis.fetch;
  let authDown = false;
  let coreCalls: string[] = [];
  const friends = new Set<string>();
  const blocks = new Set<string>();
  const suspended = new Set<string>();
  const redis = new FakePresenceRedis();
  const openSockets: WebSocket[] = [];

  const aliases: Record<string, string> = { 'google|alice': 'alice' };
  const pair = (a: string, b: string) => [a, b].sort().join('+');

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      const json = (body: unknown) => ({ status: 200, json: async () => body }) as Response;

      if (url.pathname.startsWith('/internal/channels/')) {
        coreCalls.push(url.pathname);
        return { status: 404 } as Response;
      }
      if (authDown) throw new Error('fetch failed');

      const canonical = url.pathname.match(/^\/internal\/users\/(.+)\/canonical$/);
      if (canonical) {
        const id = decodeURIComponent(canonical[1]);
        if (id === 'ghost') return { status: 404 } as Response;
        const userId = new Map(Object.entries(aliases)).get(id) ?? id;
        return json({ user_id: userId, suspended: suspended.has(userId) });
      }
      if (url.pathname === '/internal/relations') {
        const actor = url.searchParams.get('actor') as string;
        const other = url.searchParams.get('other') as string;
        return json({
          exists: other !== 'ghost',
          suspended: suspended.has(other),
          friends: friends.has(pair(actor, other)),
          blocked_by_actor: blocks.has(`${actor}>${other}`),
          blocked_by_other: blocks.has(`${other}>${actor}`),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    PresenceService.useClient(redis);
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();
    await Conversation.init();

    app = buildApp({ wsPingIntervalMs: 20 });
    await app.listen({ port: 0 });
    port = (app.server.address() as { port: number }).port;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    PresenceService.useClient(null);
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    authDown = false;
    coreCalls = [];
    friends.clear();
    blocks.clear();
    suspended.clear();
    redis.keys.clear();
    redis.sets = [];
    redis.failReads = false;
    redis.failWrites = false;
    RelationsService.clearCache();
    await Promise.all([Conversation.deleteMany({}), Message.deleteMany({}), ReadState.deleteMany({})]);
  });

  afterEach(async () => {
    openSockets.splice(0).forEach((socket) => socket.close());
    await waitFor(() => SessionManager.getActiveChannelIds().length === 0, 'sockets to close');
  });

  const request = (userId: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { 'x-user-id': userId }, ...(payload ? { payload } : {}) });

  const start = (from: string, to: string, content = 'hola') =>
    request(from, 'POST', '/conversations', { recipientId: to, content });

  const list = async (userId: string) => {
    const res = await request(userId, 'GET', '/conversations');
    assert.strictEqual(res.statusCode, 200);
    return res.json() as Json[];
  };

  /** Crea una conversación aceptada entre dos usuarios que no quedan como amigos. */
  const acceptedConversation = async (from = 'alice', to = 'bob'): Promise<string> => {
    const id = (await start(from, to)).json().conversation.id as string;
    assert.strictEqual((await request(to, 'POST', `/conversations/${id}/accept`)).statusCode, 200);
    return id;
  };

  const postMessage = (userId: string, id: string, content = 'mensaje') =>
    request(userId, 'POST', `/channels/${id}/messages`, { content });

  const connect = (path: string, userId: string): Promise<{ ws: WebSocket; received: Json[] }> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}${path}`, { headers: { 'x-user-id': userId } });
      const received: Json[] = [];
      ws.on('message', (data) => received.push(JSON.parse(data.toString())));
      ws.on('open', () => {
        openSockets.push(ws);
        resolve({ ws, received });
      });
      ws.on('error', reject);
    });

  describe('#42 CA 1 and CA 2: sending and creating the conversation', () => {
    it('opening a chat creates nothing: the conversation is born with the first message', async () => {
      const res = await request('alice', 'PUT', '/conversations/with/bob');

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.json(), { conversation: null, canMessage: true });
      assert.strictEqual(await Conversation.countDocuments(), 0);
    });

    it('the first message between friends creates an accepted conversation available to both', async () => {
      friends.add(pair('alice', 'bob'));

      const res = await start('alice', 'bob');

      assert.strictEqual(res.statusCode, 201);
      const { conversation, message } = res.json();
      assert.match(conversation.id, /^dm-[0-9a-f]{24}$/);
      assert.strictEqual(conversation.status, 'accepted');
      assert.strictEqual(conversation.otherUserId, 'bob');
      assert.strictEqual(message.channelId, conversation.id);

      const [theirs] = await list('bob');
      assert.strictEqual(theirs.id, conversation.id);
      assert.strictEqual(theirs.otherUserId, 'alice');
      assert.strictEqual(theirs.unreadCount, 1);
      assert.deepStrictEqual(Object.keys(theirs.lastMessage as object).sort(), ['authorId', 'content', 'createdAt']);
    });

    it('delivers in real time through the inbox and the conversation channel', async () => {
      const id = await acceptedConversation();
      const inbox = await connect('/inbox/ws', 'bob');
      const senderInbox = await connect('/inbox/ws', 'alice');
      const channel = await connect(`/channels/${id}/ws`, 'bob');

      assert.strictEqual((await postMessage('alice', id, 'en vivo')).statusCode, 201);

      await waitFor(() => inbox.received.length > 0 && channel.received.length > 0, 'the message');
      await waitFor(() => senderInbox.received.length > 0, 'the message in the sender inbox');
      const event = inbox.received[0] as { type: string; conversationId: string; message: { content: string } };
      assert.strictEqual(event.type, 'DM_MESSAGE');
      assert.strictEqual(event.conversationId, id);
      assert.strictEqual(event.message.content, 'en vivo');
      assert.strictEqual(channel.received[0].content, 'en vivo');
    });

    it('publishes each message to the conversation channel and to both inboxes in Redis', async () => {
      const id = await acceptedConversation();
      const published: { channel: string; message: string }[] = [];
      const noop = async () => 1;
      const fakeRedis = {
        on: () => fakeRedis,
        removeListener: () => fakeRedis,
        subscribe: noop,
        unsubscribe: noop,
        publish: async (channel: string, message: string) => {
          published.push({ channel, message });
          return 1;
        },
      };
      const redisClient = fakeRedis as unknown as NonNullable<Parameters<typeof PubSubService.start>[0]>['publisher'];
      await PubSubService.start({
        publisher: redisClient,
        subscriber: redisClient,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      try {
        await postMessage('bob', id, 'por redis');
      } finally {
        await PubSubService.stop();
      }

      assert.deepStrictEqual(published.map((p) => p.channel).sort(), [`channel:${id}`, 'inbox:alice', 'inbox:bob']);
      const inboxEvent = JSON.parse(published.find((p) => p.channel === 'inbox:alice')?.message as string);
      assert.strictEqual(inboxEvent.type, 'DM_MESSAGE');
      assert.strictEqual(inboxEvent.conversationId, id);
    });

    it('a new conversation reaches the recipient inbox as a request, before any chat is open', async () => {
      const inbox = await connect('/inbox/ws', 'bob');

      await start('alice', 'bob', 'hola, te escribo por el TP');

      await waitFor(() => inbox.received.length >= 2, 'the conversation and the message');
      assert.deepStrictEqual(inbox.received.map((e) => e.type), ['DM_CONVERSATION', 'DM_MESSAGE']);
      const conversationEvent = inbox.received[0] as unknown as {
        conversation: { status: string; otherUserId: string; requestedBy: string; unreadCount: number };
      };
      assert.strictEqual(conversationEvent.conversation.status, 'pending');
      assert.strictEqual(conversationEvent.conversation.otherUserId, 'alice');
      assert.strictEqual(conversationEvent.conversation.requestedBy, 'alice');
      assert.strictEqual(conversationEvent.conversation.unreadCount, 1);
    });

    it('stays pending for a disconnected recipient, and reading it clears the count', async () => {
      const id = await acceptedConversation();
      await postMessage('alice', id, 'dos');
      await postMessage('alice', id, 'tres');

      const [conversation] = await list('bob');
      assert.strictEqual(conversation.unreadCount, 3);
      assert.strictEqual((conversation.lastMessage as { content: string }).content, 'tres');

      const read = await request('bob', 'POST', `/channels/${id}/read`);
      assert.strictEqual(read.statusCode, 204);
      assert.strictEqual((await list('bob'))[0].unreadCount, 0);
    });

    it('the sender does not count their own messages as unread', async () => {
      const id = await acceptedConversation();
      await postMessage('alice', id);

      assert.strictEqual((await list('alice'))[0].unreadCount, 0);
    });

    it('caps the unread count like the channels', async () => {
      const id = await acceptedConversation();
      await Message.insertMany(
        Array.from({ length: UNREAD_COUNT_CAP + 5 }, () => ({ channelId: id, authorId: 'alice', content: 'x' }))
      );

      assert.strictEqual((await list('bob'))[0].unreadCount, UNREAD_COUNT_CAP);
    });

    it('lists the most recent conversations first', async () => {
      friends.add(pair('alice', 'bob'));
      friends.add(pair('alice', 'carol'));
      const first = (await start('alice', 'bob')).json().conversation.id;
      const second = (await start('alice', 'carol')).json().conversation.id;
      assert.deepStrictEqual((await list('alice')).map((c) => c.id), [second, first]);

      await new Promise((r) => setTimeout(r, 5));
      await postMessage('alice', first);
      assert.deepStrictEqual((await list('alice')).map((c) => c.id), [first, second]);
    });

    it('reuses the conversation instead of creating another one', async () => {
      friends.add(pair('alice', 'bob'));
      const first = await start('alice', 'bob');
      const second = await start('bob', 'alice', 'respuesta');

      assert.strictEqual(second.statusCode, 201);
      assert.strictEqual(second.json().conversation.id, first.json().conversation.id);
      assert.strictEqual(await Conversation.countDocuments(), 1);
    });

    it('two simultaneous first messages between friends create one conversation and keep both messages', async () => {
      friends.add(pair('alice', 'bob'));

      const results = await Promise.all([start('alice', 'bob', 'uno'), start('bob', 'alice', 'dos')]);

      assert.deepStrictEqual(results.map((r) => r.statusCode), [201, 201]);
      assert.strictEqual(await Conversation.countDocuments(), 1);
      assert.strictEqual(await Message.countDocuments(), 2);
    });

    it('of two simultaneous first messages between strangers, only one is delivered', async () => {
      const results = await Promise.all([start('alice', 'bob', 'uno'), start('alice', 'bob', 'dos')]);

      assert.deepStrictEqual(results.map((r) => r.statusCode).sort(), [201, 403]);
      assert.strictEqual(results.find((r) => r.statusCode === 403)?.json().code, 'DM_PENDING');
      assert.strictEqual(await Conversation.countDocuments(), 1);
      assert.strictEqual(await Message.countDocuments(), 1);
    });

    it('if the upsert loses the race with a duplicate key, it reuses the conversation that won', async () => {
      friends.add(pair('alice', 'bob'));
      await start('alice', 'bob');
      const upsert = mock.method(Conversation, 'findOneAndUpdate', () => ({
        lean: async () => {
          throw Object.assign(new Error('E11000'), { code: 11000 });
        },
      }));
      let res;
      try {
        // Solo falla el upsert: acá se restaura antes de actualizar el resumen
        upsert.mock.mockImplementationOnce(() => ({
          lean: async () => {
            upsert.mock.restore();
            throw Object.assign(new Error('E11000'), { code: 11000 });
          },
        }));
        res = await start('bob', 'alice', 'segundo');
      } finally {
        upsert.mock.restore();
      }

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(await Conversation.countDocuments(), 1);
    });

    it('any other database error while creating the conversation is not swallowed', async () => {
      const upsert = mock.method(Conversation, 'findOneAndUpdate', () => ({
        lean: async () => {
          throw new Error('mongo down');
        },
      }));
      try {
        assert.strictEqual((await start('alice', 'bob')).statusCode, 500);
      } finally {
        upsert.mock.restore();
      }
    });

    it('an invalid first message does not leave an empty conversation', async () => {
      const res = await start('alice', 'bob', '   ');

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(await Conversation.countDocuments(), 0);
    });

    it('removes the conversation it created if the message could not be saved', async () => {
      const save = mock.method(Message.prototype, 'save', async () => {
        throw new Error('mongo down');
      });
      try {
        assert.strictEqual((await start('alice', 'bob')).statusCode, 500);
      } finally {
        save.mock.restore();
      }

      assert.strictEqual(await Conversation.countDocuments(), 0);
      assert.strictEqual((await start('alice', 'bob')).statusCode, 201);
    });

    it('accepts attachments in the first message and shows them in the history', async () => {
      const attachment = { id: 'a1', name: 'tp.pdf', url: '/uploads/tp.pdf', size: 10, contentType: 'application/pdf' };

      const res = await request('alice', 'POST', '/conversations', { recipientId: 'bob', attachments: [attachment] });

      assert.strictEqual(res.statusCode, 201);
      const { conversation, message } = res.json();
      assert.deepStrictEqual(message.attachments, [attachment]);
      assert.strictEqual(conversation.lastMessage.content, '');
    });

    it('validates the request', async () => {
      assert.strictEqual((await request('alice', 'POST', '/conversations', { content: 'hola' })).statusCode, 400);
      assert.strictEqual((await start('alice', 'alice')).statusCode, 400);
      assert.strictEqual((await start('google|alice', 'alice')).statusCode, 400);
      assert.strictEqual((await request('alice', 'PUT', '/conversations/with/alice')).statusCode, 400);
      assert.strictEqual((await app.inject({ method: 'GET', url: '/conversations' })).statusCode, 401);
    });

    it('does not call Core: @everyone and roles stay as text, user mentions are kept', async () => {
      const id = await acceptedConversation();

      const res = await postMessage('alice', id, '@everyone <@&role-1> <@bob>');

      assert.strictEqual(res.statusCode, 201);
      assert.deepStrictEqual(res.json().mentions, { users: ['bob'], roles: [], everyone: false });
      assert.deepStrictEqual(coreCalls, []);
    });

    it('the history and the channel socket work with a dm- id', async () => {
      const id = await acceptedConversation();
      const socket = await connect(`/channels/${id}/ws`, 'bob');
      socket.ws.send(JSON.stringify({ content: 'por socket' }));
      await waitFor(() => socket.received.length === 1, 'the message');

      const history = await request('alice', 'GET', `/channels/${id}/messages`);

      assert.deepStrictEqual(
        history.json().messages.map((m: { content: string }) => m.content),
        ['hola', 'por socket']
      );
      assert.deepStrictEqual(coreCalls, []);
    });

    it('recovers missed messages on reconnection', async () => {
      const id = await acceptedConversation();
      const lastSeen = (await postMessage('alice', id, 'visto')).json().id;
      await postMessage('alice', id, 'perdido');

      const socket = await connect(`/channels/${id}/ws?last_message_id_seen=${lastSeen}`, 'bob');

      await waitFor(() => socket.received.length === 1, 'the missed message');
      assert.strictEqual(socket.received[0].content, 'perdido');
    });

    it('does not announce a write restriction when opening a dm channel', async () => {
      const id = await acceptedConversation();
      const socket = await connect(`/channels/${id}/ws`, 'bob');
      socket.ws.send(JSON.stringify({ content: 'hola' }));

      await waitFor(() => socket.received.length === 1, 'the message');
      assert.strictEqual(socket.received[0].type, undefined);
    });
  });

  describe('message request', () => {
    it('the first message to a stranger stays pending and the requester waits', async () => {
      const res = await start('alice', 'bob');

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(res.json().conversation.status, 'pending');
      assert.strictEqual(res.json().conversation.requestedBy, 'alice');

      const again = await start('alice', 'bob', 'otro');
      assert.strictEqual(again.statusCode, 403);
      assert.strictEqual(again.json().code, 'DM_PENDING');
      assert.strictEqual(again.headers['content-type'], 'application/problem+json; charset=utf-8');

      const id = res.json().conversation.id;
      assert.strictEqual((await postMessage('alice', id)).json().code, 'DM_PENDING');
      assert.strictEqual(await Message.countDocuments(), 1);
    });

    it('the recipient sees the preview and cannot answer without accepting, by any path', async () => {
      const id = (await start('alice', 'bob', 'preview')).json().conversation.id;

      const [request] = await list('bob');
      assert.strictEqual(request.status, 'pending');
      assert.strictEqual((request.lastMessage as { content: string }).content, 'preview');

      assert.strictEqual((await start('bob', 'alice')).json().code, 'DM_PENDING');
      assert.strictEqual((await postMessage('bob', id)).json().code, 'DM_PENDING');

      const socket = await connect(`/channels/${id}/ws`, 'bob');
      socket.ws.send(JSON.stringify({ content: 'por socket' }));
      await waitFor(() => socket.received.length === 1, 'the error');
      assert.deepStrictEqual(
        { status: socket.received[0].status, code: socket.received[0].code },
        { status: 403, code: 'DM_PENDING' }
      );
      assert.strictEqual(await Message.countDocuments(), 1);
    });

    it('the first message reports the conversation as canMessage: false for both', async () => {
      await start('alice', 'bob');

      assert.strictEqual((await request('alice', 'PUT', '/conversations/with/bob')).json().canMessage, false);
      assert.strictEqual((await request('bob', 'PUT', '/conversations/with/alice')).json().canMessage, false);
    });

    it('accepting frees the conversation for both and notifies them', async () => {
      const id = (await start('alice', 'bob')).json().conversation.id;
      const inbox = await connect('/inbox/ws', 'alice');

      const res = await request('bob', 'POST', `/conversations/${id}/accept`);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json().status, 'accepted');
      await waitFor(() => inbox.received.length === 1, 'the notification');
      assert.strictEqual(inbox.received[0].type, 'DM_CONVERSATION');
      assert.strictEqual((inbox.received[0].conversation as Json).status, 'accepted');

      assert.strictEqual((await postMessage('bob', id)).statusCode, 201);
      assert.strictEqual((await postMessage('alice', id)).statusCode, 201);
      assert.strictEqual(friends.size, 0);
    });

    it('accepting twice is harmless', async () => {
      const id = await acceptedConversation();

      const res = await request('bob', 'POST', `/conversations/${id}/accept`);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json().status, 'accepted');
    });

    it('only the recipient can answer the request', async () => {
      const id = (await start('alice', 'bob')).json().conversation.id;

      assert.strictEqual((await request('alice', 'POST', `/conversations/${id}/accept`)).statusCode, 403);
      assert.strictEqual((await request('alice', 'POST', `/conversations/${id}/decline`)).statusCode, 403);
      assert.strictEqual((await request('carol', 'POST', `/conversations/${id}/accept`)).statusCode, 403);
      assert.strictEqual((await request('carol', 'POST', `/conversations/${id}/decline`)).statusCode, 403);
      assert.strictEqual((await Conversation.findOne())?.status, 'pending');
    });

    it('declining hides it from the recipient, and the requester never finds out', async () => {
      const id = (await start('alice', 'bob')).json().conversation.id;
      const requesterInbox = await connect('/inbox/ws', 'alice');
      const recipientInbox = await connect('/inbox/ws', 'bob');

      const res = await request('bob', 'POST', `/conversations/${id}/decline`);

      assert.strictEqual(res.statusCode, 204);
      assert.deepStrictEqual(await list('bob'), []);

      const [theirs] = await list('alice');
      assert.strictEqual(theirs.status, 'pending');
      const view = (await request('alice', 'PUT', '/conversations/with/bob')).json();
      assert.strictEqual(view.conversation.status, 'pending');
      assert.strictEqual(view.canMessage, false);

      await waitFor(() => recipientInbox.received.length === 1, 'the other tabs of the recipient');
      assert.strictEqual((recipientInbox.received[0].conversation as Json).status, 'declined');
      assert.deepStrictEqual(requesterInbox.received, []);

      assert.strictEqual((await start('alice', 'bob')).json().code, 'DM_PENDING');
      assert.strictEqual((await postMessage('alice', id)).json().code, 'DM_PENDING');
    });

    it('declining twice is harmless, and an accepted conversation cannot be declined', async () => {
      const id = (await start('alice', 'bob')).json().conversation.id;
      assert.strictEqual((await request('bob', 'POST', `/conversations/${id}/decline`)).statusCode, 204);
      assert.strictEqual((await request('bob', 'POST', `/conversations/${id}/decline`)).statusCode, 204);

      const accepted = await acceptedConversation('carol', 'bob');
      assert.strictEqual((await request('bob', 'POST', `/conversations/${accepted}/decline`)).statusCode, 409);
    });

    it('whoever declined can change their mind', async () => {
      const id = (await start('alice', 'bob')).json().conversation.id;
      await request('bob', 'POST', `/conversations/${id}/decline`);

      assert.strictEqual((await request('bob', 'PUT', '/conversations/with/alice')).json().conversation.status, 'declined');

      const res = await request('bob', 'POST', `/conversations/${id}/accept`);

      assert.strictEqual(res.json().status, 'accepted');
      assert.strictEqual((await list('bob')).length, 1);
      assert.strictEqual((await Conversation.findOne())?.declinedBy, undefined);
    });

    describe('whoever declined writes again', () => {
      const declined = async () => {
        const id = (await start('alice', 'bob')).json().conversation.id as string;
        assert.strictEqual((await request('bob', 'POST', `/conversations/${id}/decline`)).statusCode, 204);
        return id;
      };

      const assertReopened = async (id: string, inbox: { received: Json[] }) => {
        const stored = await Conversation.findOne();
        assert.strictEqual(stored?.status, 'accepted');
        assert.strictEqual(stored?.declinedBy, undefined);
        assert.strictEqual((await list('bob'))[0].id, id);
        assert.strictEqual((await list('alice'))[0].status, 'accepted');
        assert.strictEqual(await Message.countDocuments(), 2);

        await waitFor(() => inbox.received.length >= 2, 'the events');
        assert.strictEqual(inbox.received[0].type, 'DM_CONVERSATION');
        assert.strictEqual((inbox.received[0].conversation as Json).status, 'accepted');
        assert.strictEqual(inbox.received[1].type, 'DM_MESSAGE');

        assert.strictEqual((await postMessage('alice', id, 'gracias')).statusCode, 201);
      };

      it('opening the chat offers the composer without changing anything', async () => {
        await declined();

        const res = await request('bob', 'PUT', '/conversations/with/alice');

        assert.strictEqual(res.json().canMessage, true);
        assert.strictEqual(res.json().conversation.status, 'declined');
        assert.strictEqual((await Conversation.findOne())?.status, 'declined');
        assert.deepStrictEqual(await list('bob'), []);
      });

      it('the requester keeps waiting', async () => {
        const id = await declined();
        const socket = await connect(`/channels/${id}/ws`, 'alice');

        assert.strictEqual((await request('alice', 'PUT', '/conversations/with/bob')).json().canMessage, false);
        assert.strictEqual((await start('alice', 'bob')).json().code, 'DM_PENDING');
        assert.strictEqual((await postMessage('alice', id)).json().code, 'DM_PENDING');
        socket.ws.send(JSON.stringify({ content: 'por socket' }));
        await waitFor(() => socket.received.length === 1, 'the error');

        assert.strictEqual(socket.received[0].code, 'DM_PENDING');
        assert.strictEqual((await Conversation.findOne())?.status, 'declined');
      });

      it('POST /conversations accepts it and sends the message', async () => {
        const id = await declined();
        const inbox = await connect('/inbox/ws', 'alice');

        const res = await start('bob', 'alice', 'perdón, ahora sí');

        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(res.json().conversation.status, 'accepted');
        await assertReopened(id, inbox);
      });

      it('POST /channels/:id/messages accepts it and sends the message', async () => {
        const id = await declined();
        const inbox = await connect('/inbox/ws', 'alice');

        assert.strictEqual((await postMessage('bob', id, 'perdón, ahora sí')).statusCode, 201);
        await assertReopened(id, inbox);
      });

      it('the channel socket accepts it and sends the message', async () => {
        const id = await declined();
        const inbox = await connect('/inbox/ws', 'alice');
        const socket = await connect(`/channels/${id}/ws`, 'bob');

        socket.ws.send(JSON.stringify({ content: 'perdón, ahora sí' }));

        await waitFor(() => socket.received.length === 1, 'the message');
        assert.strictEqual(socket.received[0].content, 'perdón, ahora sí');
        await assertReopened(id, inbox);
      });

      for (const [label, block] of [
        ['a block by the requester', () => blocks.add('alice>bob')],
        ['a block by whoever declined', () => blocks.add('bob>alice')],
        ['a suspension', () => suspended.add('alice')],
      ] as const) {
        it(`${label} wins over writing again`, async () => {
          const id = await declined();
          block();

          assert.strictEqual((await request('bob', 'PUT', '/conversations/with/alice')).json().canMessage, false);
          assert.strictEqual((await start('bob', 'alice')).json().code, 'DM_NOT_DELIVERABLE');
          assert.strictEqual((await postMessage('bob', id)).json().code, 'DM_NOT_DELIVERABLE');
          assert.strictEqual((await Conversation.findOne())?.status, 'declined');
          assert.strictEqual(await Message.countDocuments(), 1);
        });
      }

      it('an invalid message does not accept the conversation', async () => {
        const id = await declined();

        assert.strictEqual((await start('bob', 'alice', '   ')).statusCode, 400);
        assert.strictEqual((await postMessage('bob', id, '   ')).statusCode, 400);
        assert.strictEqual((await Conversation.findOne())?.status, 'declined');
      });

      it('uploading an attachment is allowed, but only the message accepts the conversation', async () => {
        const id = await declined();
        const attachment = { id: 'a1', name: 'a.txt', url: '/a.txt', size: 4, contentType: 'text/plain' };
        const save = mock.method(StorageService, 'saveAttachment', async () => attachment);

        try {
          const res = await app.inject({
            method: 'POST',
            url: `/channels/${id}/attachments`,
            headers: { 'x-user-id': 'bob', 'content-type': 'multipart/form-data; boundary=x' },
            payload:
              '--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n' +
              'Content-Type: text/plain\r\n\r\nhola\r\n--x--\r\n',
          });
          assert.strictEqual(res.statusCode, 201);
        } finally {
          save.mock.restore();
        }

        assert.strictEqual((await Conversation.findOne())?.status, 'declined');
      });
    });

    for (const status of ['pending', 'declined'] as const) {
      it(`becoming friends moves a ${status} conversation to accepted when opening it`, async () => {
        const id = (await start('alice', 'bob')).json().conversation.id;
        if (status === 'declined') await request('bob', 'POST', `/conversations/${id}/decline`);
        const inbox = await connect('/inbox/ws', 'alice');
        friends.add(pair('alice', 'bob'));

        const res = await request('bob', 'PUT', '/conversations/with/alice');

        assert.strictEqual(res.json().conversation.status, 'accepted');
        assert.strictEqual(res.json().canMessage, true);
        await waitFor(() => inbox.received.length === 1, 'the notification');
        assert.strictEqual((await list('bob')).length, 1);
      });

      it(`becoming friends frees a ${status} conversation when sending`, async () => {
        const id = (await start('alice', 'bob')).json().conversation.id;
        if (status === 'declined') await request('bob', 'POST', `/conversations/${id}/decline`);
        friends.add(pair('alice', 'bob'));

        assert.strictEqual((await postMessage('alice', id)).statusCode, 201);
        assert.strictEqual((await Conversation.findOne())?.status, 'accepted');
      });
    }

    it('becoming friends also frees it through POST /conversations', async () => {
      await start('alice', 'bob');
      friends.add(pair('alice', 'bob'));

      const res = await start('alice', 'bob', 'ya somos amigos');

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(res.json().conversation.status, 'accepted');
      assert.strictEqual(res.json().conversation.lastMessage.content, 'ya somos amigos');
    });

    it('opening an accepted conversation changes nothing', async () => {
      await acceptedConversation();

      const res = await request('alice', 'PUT', '/conversations/with/bob');

      assert.strictEqual(res.json().conversation.status, 'accepted');
      assert.strictEqual(res.json().canMessage, true);
    });
  });

  describe('#42 CA 3 and #43: blocking', () => {
    const assertNotDeliverable = (res: { statusCode: number; json: () => Json }) => {
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.json().code, 'DM_NOT_DELIVERABLE');
    };

    for (const [label, blocker, blocked] of [
      ['the blocked user', 'bob', 'alice'],
      ['the user who blocked', 'alice', 'bob'],
    ]) {
      it(`${label} cannot send through REST (first message or existing conversation)`, async () => {
        const id = await acceptedConversation();
        const before = await Message.countDocuments();
        blocks.add(`${blocker}>${blocked}`);

        assertNotDeliverable(await start('alice', 'bob'));
        assertNotDeliverable(await postMessage('alice', id));
        assert.strictEqual(await Message.countDocuments(), before);
      });
    }

    it('blocks a first message without creating a conversation', async () => {
      blocks.add('bob>alice');

      assertNotDeliverable(await start('alice', 'bob'));
      assert.strictEqual(await Conversation.countDocuments(), 0);
    });

    it('a block applies to a socket opened before it, from the next message on', async () => {
      const id = await acceptedConversation();
      const socket = await connect(`/channels/${id}/ws`, 'alice');
      socket.ws.send(JSON.stringify({ content: 'antes' }));
      await waitFor(() => socket.received.length === 1, 'the message');

      blocks.add('bob>alice');
      socket.ws.send(JSON.stringify({ content: 'después' }));
      await waitFor(() => socket.received.length === 2, 'the error');

      assert.deepStrictEqual(
        { status: socket.received[1].status, code: socket.received[1].code },
        { status: 403, code: 'DM_NOT_DELIVERABLE' }
      );
      assert.strictEqual(await Message.countDocuments({ content: 'después' }), 0);
    });

    it('never tells the sender they were blocked', async () => {
      const blocked = await start('alice', 'bob-blocker');
      assert.strictEqual(blocked.statusCode, 201);
      blocks.add('bob-blocker>alice');
      const blockedError = (await postMessage('alice', blocked.json().conversation.id)).json();

      suspended.add('dave');
      const suspendedError = (await start('alice', 'dave')).json();
      const inexistentError = (await start('alice', 'ghost')).json();

      for (const error of [blockedError, suspendedError, inexistentError]) {
        assert.strictEqual(error.code, 'DM_NOT_DELIVERABLE');
        assert.strictEqual(error.detail, blockedError.detail);
        assert.doesNotMatch(JSON.stringify({ ...error, code: '' }), /block/i);
      }
    });

    it('canMessage is false, without saying why, while there is a block or the user is unavailable', async () => {
      blocks.add('bob>alice');
      suspended.add('dave');

      assert.deepStrictEqual((await request('alice', 'PUT', '/conversations/with/bob')).json(), {
        conversation: null,
        canMessage: false,
      });
      assert.strictEqual((await request('alice', 'PUT', '/conversations/with/dave')).json().canMessage, false);
      assert.deepStrictEqual((await request('alice', 'PUT', '/conversations/with/ghost')).json(), {
        conversation: null,
        canMessage: false,
      });
    });

    it('keeps the history for both (CA 2) and restores sending after unblocking (CA 3)', async () => {
      const id = await acceptedConversation();
      await postMessage('alice', id, 'previo');
      blocks.add('bob>alice');

      for (const userId of ['alice', 'bob']) {
        const history = await request(userId, 'GET', `/channels/${id}/messages`);
        assert.strictEqual(history.statusCode, 200);
        assert.strictEqual(history.json().messages.length, 2);
        assert.strictEqual((await list(userId)).length, 1);
      }

      blocks.clear();
      assert.strictEqual((await postMessage('alice', id, 'de nuevo')).statusCode, 201);
    });

    it('cannot upload an attachment while the message could not be sent', async () => {
      const id = await acceptedConversation();
      const pendingId = (await start('alice', 'carol')).json().conversation.id;
      blocks.add('bob>alice');

      const upload = (conversationId: string) =>
        app.inject({
          method: 'POST',
          url: `/channels/${conversationId}/attachments`,
          headers: { 'x-user-id': 'alice', 'content-type': 'multipart/form-data; boundary=x' },
          payload:
            '--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n' +
            'Content-Type: text/plain\r\n\r\nhola\r\n--x--\r\n',
        });

      assertNotDeliverable(await upload(id));
      assert.strictEqual((await upload(pendingId)).json().code, 'DM_PENDING');
    });
  });

  describe('access', () => {
    it('someone else is rejected from every channel route', async () => {
      const id = await acceptedConversation();

      assert.strictEqual((await request('carol', 'GET', `/channels/${id}/messages`)).statusCode, 403);
      assert.strictEqual((await postMessage('carol', id)).statusCode, 403);
      assert.strictEqual((await request('carol', 'POST', `/channels/${id}/read`)).statusCode, 403);
      assert.strictEqual((await request('carol', 'POST', `/channels/${id}/attachments`)).statusCode, 403);
      await assert.rejects(connect(`/channels/${id}/ws`, 'carol'), /Unexpected server response: 403/);
      assert.deepStrictEqual(await list('carol'), []);
    });

    it('a conversation that does not exist, or a malformed id, is a 404', async () => {
      assert.strictEqual((await request('alice', 'GET', '/channels/dm-aaaaaaaaaaaaaaaaaaaaaaaa/messages')).statusCode, 404);
      assert.strictEqual((await request('alice', 'GET', '/channels/dm-nope/messages')).statusCode, 404);
      assert.strictEqual((await request('alice', 'POST', '/conversations/dm-nope/accept')).statusCode, 404);
    });

    it('requires a user', async () => {
      assert.strictEqual((await app.inject({ method: 'GET', url: '/channels/dm-nope/messages' })).statusCode, 401);
      await assert.rejects(
        new Promise((_, reject) => new WebSocket(`ws://localhost:${port}/inbox/ws`).on('error', reject)),
        /Unexpected server response: 401/
      );
    });

    it('rejects users unknown to Auth or suspended', async () => {
      suspended.add('dave');

      assert.strictEqual((await request('dave', 'GET', '/conversations')).statusCode, 403);
      assert.strictEqual((await request('ghost', 'GET', '/conversations')).statusCode, 403);
      await assert.rejects(connect('/inbox/ws', 'dave'), /Unexpected server response: 403/);
    });

    it('an alias is the same person: same conversation, same author', async () => {
      const first = await start('google|alice', 'bob');
      const id = first.json().conversation.id;

      assert.strictEqual(first.json().message.authorId, 'alice');
      assert.deepStrictEqual((await Conversation.findOne())?.participantIds, ['alice', 'bob']);
      assert.strictEqual((await list('alice'))[0].id, id);
      assert.strictEqual((await request('google|alice', 'GET', `/channels/${id}/messages`)).statusCode, 200);

      const toAlias = await request('bob', 'PUT', `/conversations/with/${encodeURIComponent('google|alice')}`);
      assert.strictEqual(toAlias.json().conversation.id, id);
    });
  });

  describe('Auth down', () => {
    it('fails closed when starting a conversation: nothing is saved', async () => {
      authDown = true;

      const res = await start('alice', 'bob');

      assert.strictEqual(res.statusCode, 503);
      assert.strictEqual(res.headers['content-type'], 'application/problem+json; charset=utf-8');
      assert.strictEqual(await Conversation.countDocuments(), 0);
    });

    it('fails closed on every send path, even with the id cached', async () => {
      const id = await acceptedConversation();
      const socket = await connect(`/channels/${id}/ws`, 'alice');
      const before = await Message.countDocuments();
      authDown = true;

      assert.strictEqual((await postMessage('alice', id)).statusCode, 503);
      socket.ws.send(JSON.stringify({ content: 'por socket' }));
      await waitFor(() => socket.received.length === 1, 'the error');

      assert.strictEqual(socket.received[0].status, 503);
      assert.strictEqual(await Message.countDocuments(), before);
    });

    it('does not open the conversation or the inbox if the user cannot be resolved', async () => {
      authDown = true;

      assert.strictEqual((await request('alice', 'PUT', '/conversations/with/bob')).statusCode, 503);
      assert.strictEqual((await request('alice', 'GET', '/channels/dm-aaaaaaaaaaaaaaaaaaaaaaaa/messages')).statusCode, 503);
      await assert.rejects(connect('/inbox/ws', 'alice'), /Unexpected server response: 503/);
    });
  });

  describe('presence', () => {
    const presence = (userId: string, userIds: unknown) => request(userId, 'POST', '/presence', { userIds });

    it('is online while the inbox is connected and offline after the last socket closes', async () => {
      const first = await connect('/inbox/ws', 'bob');
      const second = await connect('/inbox/ws', 'bob');
      await waitFor(() => redis.keys.has('presence:bob'), 'the presence key');

      assert.deepStrictEqual((await presence('alice', ['bob', 'carol'])).json(), { bob: 'online', carol: 'offline' });

      first.ws.close();
      await waitFor(() => SessionManager.getChannelSockets('inbox:bob').length === 1, 'the first socket to close');
      assert.strictEqual((await presence('alice', ['bob'])).json().bob, 'online');

      second.ws.close();
      await waitFor(() => !redis.keys.has('presence:bob'), 'the presence key to go away');
      assert.strictEqual((await presence('alice', ['bob'])).json().bob, 'offline');
    });

    it('the heartbeat renews it', async () => {
      await connect('/inbox/ws', 'bob');

      await waitFor(() => redis.sets.filter((key) => key === 'presence:bob').length >= 3, 'presence renewals');
    });

    it('a channel socket does not count as online', async () => {
      const id = await acceptedConversation();
      await connect(`/channels/${id}/ws`, 'bob');

      assert.strictEqual((await presence('alice', ['bob'])).json().bob, 'offline');
    });

    it('answers with the requested ids, resolving aliases', async () => {
      await connect('/inbox/ws', 'google|alice');
      await waitFor(() => redis.keys.has('presence:alice'), 'the presence key');

      assert.deepStrictEqual((await presence('bob', ['google|alice'])).json(), { 'google|alice': 'online' });
    });

    it('unknown and suspended users are offline', async () => {
      redis.keys.set('presence:dave', '1');
      suspended.add('dave');

      assert.deepStrictEqual((await presence('alice', ['ghost', 'dave'])).json(), { ghost: 'offline', dave: 'offline' });
    });

    it('validates the list', async () => {
      assert.deepStrictEqual((await presence('alice', [])).json(), {});
      assert.strictEqual((await presence('alice', 'bob')).statusCode, 400);
      assert.strictEqual((await presence('alice', [1])).statusCode, 400);
      assert.strictEqual((await presence('alice', Array(101).fill('bob'))).statusCode, 400);
      assert.strictEqual((await presence('alice', Array(100).fill('bob'))).statusCode, 200);
    });

    describe('chosen status', () => {
      const getMine = (userId: string) => request(userId, 'GET', '/presence/me');
      const setMine = (userId: string, status: unknown) => request(userId, 'PUT', '/presence/me', { status });

      it('defaults to online', async () => {
        const res = await getMine('bob');
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.json(), { status: 'online' });
      });

      it('is saved and returned', async () => {
        const res = await setMine('bob', 'dnd');
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.json(), { status: 'dnd' });
        assert.strictEqual(redis.keys.get('presence:pref:bob'), 'dnd');
        assert.deepStrictEqual((await getMine('bob')).json(), { status: 'dnd' });
      });

      it('others see it while connected', async () => {
        await setMine('bob', 'idle');
        await setMine('carol', 'dnd');
        await connect('/inbox/ws', 'bob');
        await connect('/inbox/ws', 'carol');
        await waitFor(() => redis.keys.has('presence:bob') && redis.keys.has('presence:carol'), 'the presence keys');

        assert.deepStrictEqual((await presence('alice', ['bob', 'carol'])).json(), { bob: 'idle', carol: 'dnd' });
      });

      it('invisible looks offline while connected', async () => {
        await setMine('bob', 'invisible');
        await connect('/inbox/ws', 'bob');
        await waitFor(() => redis.keys.has('presence:bob'), 'the presence key');

        assert.strictEqual((await presence('alice', ['bob'])).json().bob, 'offline');
        assert.deepStrictEqual((await getMine('bob')).json(), { status: 'invisible' });
      });

      it('disconnected is offline whatever the choice, and the choice survives it', async () => {
        await setMine('bob', 'idle');
        const inbox = await connect('/inbox/ws', 'bob');
        await waitFor(() => redis.keys.has('presence:bob'), 'the presence key');

        inbox.ws.close();
        await waitFor(() => !redis.keys.has('presence:bob'), 'the presence key to go away');
        assert.strictEqual((await presence('alice', ['bob'])).json().bob, 'offline');
        assert.deepStrictEqual((await getMine('bob')).json(), { status: 'idle' });
      });

      it('resolves aliases for the owner and the readers', async () => {
        await setMine('google|alice', 'dnd');
        assert.strictEqual(redis.keys.get('presence:pref:alice'), 'dnd');

        await connect('/inbox/ws', 'alice');
        await waitFor(() => redis.keys.has('presence:alice'), 'the presence key');
        assert.deepStrictEqual((await presence('bob', ['google|alice'])).json(), { 'google|alice': 'dnd' });
      });

      it('a suspended user is offline whatever the choice', async () => {
        redis.keys.set('presence:dave', '1');
        redis.keys.set('presence:pref:dave', 'online');
        suspended.add('dave');

        assert.strictEqual((await presence('alice', ['dave'])).json().dave, 'offline');
      });

      it('an unknown stored value counts as online', async () => {
        redis.keys.set('presence:bob', '1');
        redis.keys.set('presence:pref:bob', 'busy');

        assert.strictEqual((await presence('alice', ['bob'])).json().bob, 'online');
        assert.deepStrictEqual((await getMine('bob')).json(), { status: 'online' });
      });

      it('validates the status', async () => {
        for (const status of [undefined, '', 'offline', 'busy', 1, null]) {
          assert.strictEqual((await setMine('bob', status)).statusCode, 400, String(status));
        }
        assert.strictEqual(redis.keys.has('presence:pref:bob'), false);
        assert.strictEqual((await request('bob', 'PUT', '/presence/me')).statusCode, 400);
      });

      it('a Redis failure is a 503', async () => {
        redis.failReads = true;
        assert.strictEqual((await getMine('bob')).statusCode, 503);

        redis.failWrites = true;
        assert.strictEqual((await setMine('bob', 'idle')).statusCode, 503);
      });
    });

    it('a Redis failure is a 503 for readers and does not close the inbox', async () => {
      redis.failReads = true;
      assert.strictEqual((await presence('alice', ['bob'])).statusCode, 503);

      redis.failWrites = true;
      const inbox = await connect('/inbox/ws', 'bob');
      await start('alice', 'bob');
      await waitFor(() => inbox.received.length >= 2, 'the events');
    });
  });

  describe('server events', () => {
    it('an event without server_id does not touch the DM or inbox sockets', async () => {
      const id = await acceptedConversation();
      const channel = await connect(`/channels/${id}/ws`, 'bob');
      const inbox = await connect('/inbox/ws', 'bob');

      await EventConsumer.handleEvent('member.banned', { user_id: 'bob' });
      await EventConsumer.handleEvent('member.muted', { user_id: 'bob' });
      await EventConsumer.handleEvent('member.unmuted', { user_id: 'bob' });

      // Se mira del lado del servidor: el cliente tarda en enterarse de un cierre
      assert.strictEqual(SessionManager.getChannelSockets(id).length, 1);
      assert.strictEqual(SessionManager.getChannelSockets('inbox:bob').length, 1);
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(channel.ws.readyState, WebSocket.OPEN);
      assert.strictEqual(inbox.ws.readyState, WebSocket.OPEN);
      assert.deepStrictEqual(channel.received, []);
      assert.deepStrictEqual(coreCalls, []);
    });
  });
});
