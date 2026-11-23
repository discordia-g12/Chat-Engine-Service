import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { Conversation, ConversationStatus } from '../src/models/Conversation';
import { PubSubService } from '../src/services/PubSubService';
import { RelationsService } from '../src/services/RelationsService';

type Problem = { status: number; title: string; detail: string; code?: string };

describe('Rutas internas de llamadas privadas (#50)', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let originalFetch: typeof globalThis.fetch;
  let authDown = false;
  let published: { userId: string; payload: unknown }[] = [];
  const friends = new Set<string>();
  const blocks = new Set<string>();
  const suspended = new Set<string>();
  const aliases = new Map([['google|alice', 'alice']]);
  const pair = (a: string, b: string) => [a, b].sort().join('+');

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      const json = (body: unknown) => ({ status: 200, json: async () => body }) as Response;
      if (authDown) throw new Error('fetch failed');

      const canonical = url.pathname.match(/^\/internal\/users\/(.+)\/canonical$/);
      if (canonical) {
        const id = decodeURIComponent(canonical[1]);
        if (id === 'ghost') return { status: 404 } as Response;
        const userId = aliases.get(id) ?? id;
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
    mock.method(PubSubService, 'publishToInbox', async (userId: string, payload: unknown) => {
      published.push({ userId, payload });
    });

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();
    await Conversation.init();
    app = buildApp();
    await app.ready();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    authDown = false;
    published = [];
    friends.clear();
    blocks.clear();
    suspended.clear();
    RelationsService.clearCache();
    await Conversation.deleteMany({});
  });

  afterEach(() => {
    RelationsService.clearCache();
  });

  /** Conversación alice ↔ bob, iniciada por alice. */
  const conversation = async (status: ConversationStatus = 'accepted', declinedBy?: string): Promise<string> => {
    const created = await Conversation.create({
      participantKey: JSON.stringify(['alice', 'bob']),
      participantIds: ['alice', 'bob'],
      status,
      requestedBy: 'alice',
      ...(declinedBy ? { declinedBy } : {}),
      lastMessageAt: new Date(),
    });
    return `dm-${created._id.toString()}`;
  };

  const callAccess = (id: string, userId: string | undefined, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: `/internal/conversations/${id}/call-access${userId === undefined ? '' : `?user_id=${encodeURIComponent(userId)}`}`,
      headers,
    });

  const assertProblem = (res: { statusCode: number; headers: Record<string, unknown>; json: () => unknown }, status: number, code?: string) => {
    assert.strictEqual(res.statusCode, status);
    assert.match(res.headers['content-type'] as string, /application\/problem\+json/);
    const body = res.json() as Problem;
    assert.strictEqual(body.status, status);
    assert.strictEqual(body.code, code);
  };

  describe('GET /internal/conversations/:id/call-access', () => {
    it('200 con los ids canónicos si puede escribir en la conversación', async () => {
      const id = await conversation();

      const res = await callAccess(id, 'bob');

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.json(), { conversationId: id, userId: 'bob', otherUserId: 'alice' });
    });

    it('un alias se resuelve al id canónico', async () => {
      const id = await conversation();

      const res = await callAccess(id, 'google|alice');

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.json(), { conversationId: id, userId: 'alice', otherUserId: 'bob' });
    });

    it('pendiente pero amigos: 200, como un mensaje que la aceptaría, y no cambia el estado', async () => {
      const id = await conversation('pending');
      friends.add(pair('alice', 'bob'));

      const res = await callAccess(id, 'alice');

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual((await Conversation.findOne())?.status, 'pending');
      assert.deepStrictEqual(published, []);
    });

    it('rechazada por quien llama: 200 (escribir es arrepentirse) y no cambia el estado', async () => {
      const id = await conversation('declined', 'bob');

      const res = await callAccess(id, 'bob');

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual((await Conversation.findOne())?.status, 'declined');
    });

    it('404 si la conversación no existe', async () => {
      assertProblem(await callAccess(`dm-${new Types.ObjectId().toString()}`, 'alice'), 404, 'CONVERSATION_NOT_FOUND');
    });

    it('404 si el id no es dm-…, sin preguntarle a Auth', async () => {
      authDown = true;
      assertProblem(await callAccess('general', 'alice'), 404, 'CONVERSATION_NOT_FOUND');
      assertProblem(await callAccess('dm-nope', 'alice'), 404, 'CONVERSATION_NOT_FOUND');
    });

    it('403 si no participa', async () => {
      const id = await conversation();
      assertProblem(await callAccess(id, 'carol'), 403);
    });

    it('403 DM_NOT_DELIVERABLE si hay bloqueo en cualquier sentido', async () => {
      const id = await conversation();

      blocks.add('bob>alice');
      assertProblem(await callAccess(id, 'alice'), 403, 'DM_NOT_DELIVERABLE');

      blocks.clear();
      blocks.add('alice>bob');
      assertProblem(await callAccess(id, 'alice'), 403, 'DM_NOT_DELIVERABLE');
    });

    it('403 DM_NOT_DELIVERABLE si el otro está suspendido', async () => {
      const id = await conversation();
      suspended.add('bob');
      assertProblem(await callAccess(id, 'alice'), 403, 'DM_NOT_DELIVERABLE');
    });

    it('403 DM_NOT_DELIVERABLE si quien llama no existe o está suspendido', async () => {
      const id = await conversation();
      assertProblem(await callAccess(id, 'ghost'), 403, 'DM_NOT_DELIVERABLE');

      suspended.add('alice');
      assertProblem(await callAccess(id, 'alice'), 403, 'DM_NOT_DELIVERABLE');
    });

    it('403 DM_PENDING si falta aceptar', async () => {
      const id = await conversation('pending');
      assertProblem(await callAccess(id, 'alice'), 403, 'DM_PENDING');
      assertProblem(await callAccess(id, 'bob'), 403, 'DM_PENDING');
    });

    it('503 si Auth no responde', async () => {
      const id = await conversation();
      authDown = true;
      assertProblem(await callAccess(id, 'alice'), 503);
    });

    it('400 si falta user_id o viene repetido', async () => {
      const id = await conversation();
      assertProblem(await callAccess(id, undefined), 400);
      assertProblem(await callAccess(id, ''), 400);

      const res = await app.inject({
        method: 'GET',
        url: `/internal/conversations/${id}/call-access?user_id=alice&user_id=bob`,
      });
      assertProblem(res, 400);
    });
  });

  describe('GET /internal/users/:id/canonical', () => {
    const canonical = (id: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url: `/internal/users/${encodeURIComponent(id)}/canonical`, headers });

    it('200 con el id canónico de un alias', async () => {
      const res = await canonical('google|alice');

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.json(), { userId: 'alice', suspended: false });
    });

    it('informa la suspensión', async () => {
      suspended.add('bob');
      assert.deepStrictEqual((await canonical('bob')).json(), { userId: 'bob', suspended: true });
    });

    it('usa la cache de RelationsService', async () => {
      assert.strictEqual((await canonical('bob')).statusCode, 200);
      authDown = true;
      assert.deepStrictEqual((await canonical('bob')).json(), { userId: 'bob', suspended: false });
    });

    it('404 si el usuario no existe', async () => {
      assertProblem(await canonical('ghost'), 404, 'USER_NOT_FOUND');
    });

    it('503 si Auth no responde', async () => {
      authDown = true;
      assertProblem(await canonical('bob'), 503);
    });
  });

  describe('POST /internal/inbox/events', () => {
    const ringing = { type: 'CALL_RINGING', call: { id: 'c1', status: 'ringing' } };
    const send = (payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url: '/internal/inbox/events', payload: payload as object, headers });

    it('202 y publica el evento tal cual en el inbox de cada uno', async () => {
      const res = await send({ userIds: ['alice', 'bob'], event: ringing });

      assert.strictEqual(res.statusCode, 202);
      assert.strictEqual(res.body, '');
      assert.deepStrictEqual(published, [
        { userId: 'alice', payload: ringing },
        { userId: 'bob', payload: ringing },
      ]);
    });

    it('acepta los avisos de Notification (NOTIFICATION_*)', async () => {
      const notification = { type: 'NOTIFICATION_CREATED', notification: { id: 'n1', reason: 'thread_reply' } };
      assert.strictEqual((await send({ userIds: ['alice'], event: notification })).statusCode, 202);
      assert.deepStrictEqual(published, [{ userId: 'alice', payload: notification }]);
    });

    it('un id repetido recibe el evento una sola vez', async () => {
      await send({ userIds: ['alice', 'alice'], event: ringing });
      assert.deepStrictEqual(published.map((p) => p.userId), ['alice']);
    });

    it('acepta hasta 10 ids', async () => {
      const userIds = Array.from({ length: 10 }, (_, i) => `u${i}`);
      assert.strictEqual((await send({ userIds, event: ringing })).statusCode, 202);
      assert.strictEqual(published.length, 10);
    });

    const invalid: [string, unknown][] = [
      ['sin body', undefined],
      ['body que no es objeto', ['alice']],
      ['sin userIds', { event: ringing }],
      ['userIds vacío', { userIds: [], event: ringing }],
      ['más de 10 ids', { userIds: Array.from({ length: 11 }, (_, i) => `u${i}`), event: ringing }],
      ['userIds no es lista', { userIds: 'alice', event: ringing }],
      ['un id vacío', { userIds: ['alice', ' '], event: ringing }],
      ['un id que no es texto', { userIds: ['alice', 7], event: ringing }],
      ['sin event', { userIds: ['alice'] }],
      ['event que no es objeto', { userIds: ['alice'], event: 'CALL_RINGING' }],
      ['event sin type', { userIds: ['alice'], event: { call: {} } }],
      ['type que no es CALL_ ni NOTIFICATION_',{ userIds: ['alice'], event: { type: 'DM_MESSAGE', message: {} } }],
      ['type en minúsculas', { userIds: ['alice'], event: { type: 'call_ringing' } }],
    ];

    for (const [name, payload] of invalid) {
      it(`400 si ${name}, sin publicar nada`, async () => {
        assertProblem(await send(payload), 400);
        assert.deepStrictEqual(published, []);
      });
    }

    it('413 si el evento supera los 8 KB, sin publicar nada', async () => {
      const event = { type: 'CALL_RINGING', padding: 'x'.repeat(8 * 1024) };
      assertProblem(await send({ userIds: ['alice'], event }), 413);
      assert.deepStrictEqual(published, []);
    });
  });

  it('las tres rutas responden 404 si llegan por Kong (X-User-Id o X-Forwarded-Prefix)', async () => {
    const id = await conversation();
    const requests = [
      { method: 'GET' as const, url: `/internal/conversations/${id}/call-access?user_id=alice` },
      { method: 'GET' as const, url: '/internal/users/alice/canonical' },
      {
        method: 'POST' as const,
        url: '/internal/inbox/events',
        payload: { userIds: ['alice'], event: { type: 'CALL_RINGING' } },
      },
    ];

    for (const headers of [{ 'x-user-id': 'alice' }, { 'x-forwarded-prefix': '/api/v1/chat' }]) {
      for (const request of requests) {
        const res = await app.inject({ ...request, headers });
        assert.strictEqual(res.statusCode, 404, `${request.method} ${request.url} con ${Object.keys(headers)[0]}`);
        assert.strictEqual(res.json().status, 404);
      }
    }
    assert.deepStrictEqual(published, []);
  });
});
