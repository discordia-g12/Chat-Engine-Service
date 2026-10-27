import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import WebSocket from 'ws';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Message, IMessage } from '../src/models/Message';
import { FastifyInstance } from 'fastify';

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
    // Invalid ObjectId cursor makes Mongoose throw a CastError: not a client-safe message.
    const res = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages?before=not-an-object-id`,
      headers: { 'x-user-id': 'user-1' }
    });

    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.json().detail, 'An unexpected error occurred');
  });

  it('Should return problem+json 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.json().title, 'Not Found');
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