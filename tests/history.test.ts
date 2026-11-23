import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import WebSocket from 'ws';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Message, IMessage } from '../src/models/Message';
import { FastifyInstance } from 'fastify';
import { ChatService, MAX_HISTORY_LIMIT, MAX_MISSED_MESSAGES } from '../src/services/ChatService';

describe('History and Reconnection', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let port: number;
  const channelId = 'channel-history';
  const seededMessages: IMessage[] = [];
  let originalFetch: typeof globalThis.fetch;

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('not-found-channel')) {
        return { status: 404 } as Response;
      }
      if (urlStr.includes('banned-user')) {
        return { status: 403 } as Response;
      }
      if (urlStr.includes('core-down-user')) {
        throw new Error('fetch failed');
      }
      // Muteado: puede ver el canal aunque no pueda escribir
      const canSend = !urlStr.includes('muted-user');
      return { status: 200, json: async () => ({ server_id: 'srv-1', can_send: canSend, muted_until: null }) } as Response;
    });

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();
    
    app = buildApp();
    await app.listen({ port: 0 });
    port = (app.server.address() as { port: number }).port;

    for (let i = 1; i <= 15; i++) {
      const msg = await Message.create({
        content: `Message sequence ${i}`,
        authorId: `user-${i}`,
        channelId: channelId,
        createdAt: new Date(Date.now() - (100000 - i * 1000))
      });
      seededMessages.push(msg);
    }
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
  });

  it('Should reject history request without X-User-Id header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages?limit=10`
    });

    assert.strictEqual(res.statusCode, 401);
    assert.match(res.headers['content-type'] as string, /application\/problem\+json/);
    assert.strictEqual(res.json().title, 'Unauthorized');
    assert.strictEqual(res.json().detail, 'Missing X-User-Id header');
  });

  it('Should reject history request for banned user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages?limit=10`,
      headers: { 'x-user-id': 'banned-user' }
    });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json().title, 'Forbidden');
  });

  it('Should let a muted user read the history', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages?limit=10`,
      headers: { 'x-user-id': 'muted-user' }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().messages.length, 10);
  });

  it('Should return 404 if channel not found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/channels/not-found-channel/messages?limit=10`,
      headers: { 'x-user-id': 'user-1' }
    });

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.json().detail, 'Channel not found');
  });

  it('Should return 503 (not 403) when Core is unreachable', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages?limit=10`,
      headers: { 'x-user-id': 'core-down-user' }
    });

    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.json(), {
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'Failed to communicate with permission service',
      instance: `/channels/${channelId}/messages?limit=10`
    });
  });

  it('Should hide internal details on unexpected errors (500)', async () => {
    // Un error de la base (no del cliente): el detalle no sale en la respuesta
    const find = mock.method(Message, 'find', () => {
      throw new Error('connection pool exhausted at 10.0.1.20');
    });
    const res = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages?limit=10`,
      headers: { 'x-user-id': 'user-1' }
    });
    find.mock.restore();

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.json().detail, 'An unexpected error occurred');
  });

  describe('límites del historial (C4)', () => {
    const get = (query: string) =>
      app.inject({ method: 'GET', url: `/channels/${channelId}/messages${query}`, headers: { 'x-user-id': 'user-1' } });

    it('400 con limit fuera de rango, que no es entero o un before que no es un id', async () => {
      for (const query of ['?limit=0', `?limit=${MAX_HISTORY_LIMIT + 1}`, '?limit=1000000', '?limit=abc', '?limit=2.5', '?before=not-an-object-id', '?before=123']) {
        const res = await get(query);
        assert.strictEqual(res.statusCode, 400, query);
      }
    });

    it(`acepta hasta ${MAX_HISTORY_LIMIT} y sin limit usa el default`, async () => {
      assert.strictEqual((await get(`?limit=${MAX_HISTORY_LIMIT}`)).statusCode, 200);
      assert.strictEqual((await get('')).statusCode, 200);
    });

    it(`la reconexión repone como mucho los ${MAX_MISSED_MESSAGES} más recientes, en orden`, async () => {
      const busy = 'channel-history-busy';
      const anchor = await Message.create({ content: 'visto', authorId: 'user-2', channelId: busy });
      await Message.insertMany(
        Array.from({ length: MAX_MISSED_MESSAGES + 20 }, (_, i) => ({ content: `m${i}`, authorId: 'user-2', channelId: busy }))
      );

      const missed = await ChatService.getMissedMessages(busy, anchor.id);

      assert.strictEqual(missed.length, MAX_MISSED_MESSAGES);
      assert.strictEqual(missed[missed.length - 1].content, `m${MAX_MISSED_MESSAGES + 19}`);
      assert.ok(missed.every((m, i) => i === 0 || m.id > missed[i - 1].id));
    });

    it('un last_message_id_seen que no es un id no repone nada (antes rompía con un CastError)', async () => {
      assert.deepStrictEqual(await ChatService.getMissedMessages(channelId, 'not-an-id'), []);
    });
  });

  it('Should return problem+json 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.json().title, 'Not Found');
  });

  describe('responder citando', () => {
    const quoteChannel = 'channel-quote';
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: `/channels/${quoteChannel}/messages`, headers: { 'x-user-id': 'bob' }, payload });

    it('guarda la cita y la devuelve en el historial', async () => {
      const parent = await Message.create({ content: 'mensaje padre', authorId: 'alice', channelId: quoteChannel });

      const res = await post({ content: 'mensaje respuesta', replyToId: parent.id });
      assert.strictEqual(res.statusCode, 201);
      assert.deepStrictEqual(res.json().replyTo, { id: parent.id, authorId: 'alice', content: 'mensaje padre' });

      const history = await ChatService.getHistory(quoteChannel);
      assert.deepStrictEqual(history.at(-1)?.replyTo, { id: parent.id, authorId: 'alice', content: 'mensaje padre' });
    });

    it('rechaza citar un id inválido, un mensaje de otro canal o uno borrado', async () => {
      const elsewhere = await Message.create({ content: 'otro canal', authorId: 'alice', channelId: 'channel-other' });
      const deleted = await Message.create({ content: '', authorId: 'alice', channelId: quoteChannel, isDeleted: true });

      assert.strictEqual((await post({ content: 'x', replyToId: 'nope' })).statusCode, 400);
      assert.strictEqual((await post({ content: 'x', replyToId: elsewhere.id })).statusCode, 404);
      assert.strictEqual((await post({ content: 'x', replyToId: deleted.id })).statusCode, 404);
    });

    it('al editar o borrar el original, la cita se actualiza', async () => {
      const parent = await Message.create({ content: 'antes', authorId: 'alice', channelId: quoteChannel });
      const quote = (await post({ content: 'respuesta', replyToId: parent.id })).json();

      await ChatService.editMessage('alice', quoteChannel, parent.id, 'después');
      assert.strictEqual((await Message.findById(quote.id).lean())?.replyTo?.content, 'después');

      await ChatService.deleteMessage('alice', quoteChannel, parent.id);
      const reloaded = await Message.findById(quote.id).lean<IMessage>();
      assert.deepStrictEqual(
        { content: reloaded?.replyTo?.content, deleted: reloaded?.replyTo?.deleted },
        { content: '', deleted: true }
      );
    });
  });

  it('Should load history with pagination in chronological order', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages?limit=10`,
      headers: { 'x-user-id': 'user-1' }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    
    assert.strictEqual(body.messages.length, 10);
    
    const firstMsgTime = new Date(body.messages[0].createdAt).getTime();
    const lastMsgTime = new Date(body.messages[9].createdAt).getTime();
    assert.ok(firstMsgTime < lastMsgTime, 'Messages must be in chronological order');
    assert.strictEqual(body.messages[9].content, 'Message sequence 15'); 
    
    const oldestSeenId = body.messages[0].id;
    const paginatedRes = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages?limit=5&before=${oldestSeenId}`,
      headers: { 'x-user-id': 'user-1' }
    });

    const paginatedBody = paginatedRes.json();
    assert.strictEqual(paginatedBody.messages.length, 5);
    assert.strictEqual(paginatedBody.messages[4].content, 'Message sequence 5'); 
  });

  it('Should receive missed messages chronologically upon WS reconnection', async () => {
    const lastSeenMessageId = seededMessages[9].id.toString(); // 
    
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/channels/${channelId}/ws?last_message_id_seen=${lastSeenMessageId}`, { headers: { 'x-user-id': 'user-1' } });
      
      const receivedMessages: { content: string; createdAt: string }[] = [];
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        receivedMessages.push(msg);
        
        if (receivedMessages.length === 5) {
          try {
            assert.strictEqual(receivedMessages[0].content, 'Message sequence 11');
            assert.strictEqual(receivedMessages[4].content, 'Message sequence 15');
            
            const time1 = new Date(receivedMessages[0].createdAt).getTime();
            const time2 = new Date(receivedMessages[1].createdAt).getTime();
            assert.ok(time1 < time2, 'Recovered messages must be chronological');
            
            ws.close();
            resolve();
          } catch (err) {
            ws.close();
            reject(err);
          }
        }
      });

      ws.on('error', reject);
      
      setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for missed messages to be delivered'));
      }, 2000);
    });
  });
});