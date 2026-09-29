import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import WebSocket from 'ws';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FastifyInstance } from 'fastify';

describe('WebSocket Endpoints', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let port: number;

  let originalFetch: typeof globalThis.fetch;

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('banned-user')) {
        return { status: 403 } as Response;
      }
      if (urlStr.includes('not-found-channel')) {
        return { status: 404 } as Response;
      }
      if (urlStr.includes('core-down-user')) {
        throw new Error('fetch failed');
      }
      if (urlStr.includes('slow-user')) {
        // Simulates a slow Core: the permission check takes a while to answer.
        await new Promise((r) => setTimeout(r, 300));
      }
      return { status: 200 } as Response;
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

  const connectWs = (channelId: string, headers: Record<string, string> = { 'x-user-id': 'user-1' }): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/channels/${channelId}/ws`, { headers });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  };

  it('should broadcast a valid message to clients in the same channel', async () => {
    const ws1 = await connectWs('channel-1');
    const ws2 = await connectWs('channel-1');

    return new Promise<void>((resolve, reject) => {
      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.content === 'Hello everyone') {
          ws1.close();
          ws2.close();
          resolve();
        } else {
          reject(new Error('Unexpected message received'));
        }
      });

      ws1.send(JSON.stringify({ authorId: 'user-1', content: 'Hello everyone' }));
    });
  });

  it('should return error for invalid JSON payload', async () => {
    const ws = await connectWs('channel-2');

    return new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const response = JSON.parse(data.toString());
        assert.strictEqual(response.error, 'Invalid JSON payload');
        assert.strictEqual(response.status, 400);
        ws.close();
        resolve();
      });

      ws.send('not-a-json-string');
    });
  });

  // Rejections now happen during the HTTP handshake (preValidation), so the
  // client gets a real HTTP status and the socket is never opened.
  const expectHandshakeRejection = (
    channelId: string,
    headers: Record<string, string>
  ): Promise<{ status: number; body: { title: string; detail: string } }> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/channels/${channelId}/ws`, { headers });
      ws.on('open', () => {
        ws.close();
        reject(new Error('Socket should not have been opened'));
      });
      ws.on('unexpected-response', (_req, res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
      });
      ws.on('error', () => {}); // 'unexpected-response' already handles the rejection
    });
  };

  it('should reject handshake with 401 without X-User-Id header', { timeout: 3000 }, async () => {
    const { status, body } = await expectHandshakeRejection('channel-test', {});
    assert.strictEqual(status, 401);
    assert.strictEqual(body.detail, 'Missing X-User-Id header');
  });

  it('should reject handshake with 403 for banned user', { timeout: 3000 }, async () => {
    const { status, body } = await expectHandshakeRejection('channel-test', { 'x-user-id': 'banned-user' });
    assert.strictEqual(status, 403);
    assert.strictEqual(body.detail, 'User does not have permission to access this channel');
  });

  it('should reject handshake with 404 for unknown channel', { timeout: 3000 }, async () => {
    const { status, body } = await expectHandshakeRejection('not-found-channel', { 'x-user-id': 'user-1' });
    assert.strictEqual(status, 404);
    assert.strictEqual(body.detail, 'Channel not found');
  });

  it('should reject handshake with 503 (not 403) when Core is unreachable', { timeout: 3000 }, async () => {
    const { status, body } = await expectHandshakeRejection('channel-test', { 'x-user-id': 'core-down-user' });
    assert.strictEqual(status, 503);
    assert.strictEqual(body.detail, 'Failed to communicate with permission service');
  });

  it('should not lose a message sent right after open, even with a slow permission check', { timeout: 5000 }, async () => {
    const ws = await connectWs('channel-slow', { 'x-user-id': 'slow-user' });
    try {
      const reply = new Promise<{ content: string; authorId: string }>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      ws.send(JSON.stringify({ content: 'sent immediately on open' }));
      const msg = await reply;
      assert.strictEqual(msg.content, 'sent immediately on open');
      assert.strictEqual(msg.authorId, 'slow-user');
    } finally {
      ws.close();
    }
  });

  it('should use X-User-Id as authorId, ignoring payload authorId', async () => {
    const ws = await connectWs('channel-7', { 'x-user-id': 'real-user' });
    
    return new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const response = JSON.parse(data.toString());
        assert.strictEqual(response.authorId, 'real-user');
        ws.close();
        resolve();
      });

      ws.send(JSON.stringify({ authorId: 'fake-user', content: 'Test' }));
    });
  });

  it('should return error if message fails Mongoose validation (empty content)', async () => {
    const ws = await connectWs('channel-5');

    return new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const response = JSON.parse(data.toString());
        assert.match(response.error, /cannot be empty|Content is required/);
        ws.close();
        resolve();
      });

      ws.send(JSON.stringify({ authorId: 'user-2', content: '   ' }));
    });
  });
  
  it('should return error if id is negative integer', async () => {
    const ws = await connectWs('channel-6');

    return new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const response = JSON.parse(data.toString());
        assert.strictEqual(response.error, 'id must be positive');
        ws.close();
        resolve();
      });

      ws.send(JSON.stringify({ id: -10, authorId: 'user-1', content: 'Test' }));
    });
  });

  it('should keep channels isolated', async () => {
    const wsA = await connectWs('channel-A');
    const wsB = await connectWs('channel-B');

    return new Promise<void>((resolve) => {
      let receivedInB = false;

      wsB.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.content === 'Message in A') {
          receivedInB = true;
        }
      });

      wsA.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.content === 'Message in A') {
          assert.strictEqual(receivedInB, false);
          wsA.close();
          wsB.close();
          resolve();
        }
      });

      wsA.send(JSON.stringify({ authorId: 'user-3', content: 'Message in A' }));
    });
  });
});
