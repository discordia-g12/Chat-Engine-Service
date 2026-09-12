import { describe, it, before, after } from 'node:test';
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

  before(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();
    
    app = buildApp();
    await app.listen({ port: 0 });
    port = (app.server.address() as any).port;
  });

  after(async () => {
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
  });

  const connectWs = (channelId: string): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/channels/${channelId}/ws`);
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
        ws.close();
        resolve();
      });

      ws.send('not-a-json-string');
    });
  });

  it('should return error if authorId is negative integer', async () => {
    const ws = await connectWs('channel-3');

    return new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const response = JSON.parse(data.toString());
        assert.strictEqual(response.error, 'authorId must be positive');
        ws.close();
        resolve();
      });

      ws.send(JSON.stringify({ authorId: -5, content: 'Test' }));
    });
  });

  // TEST USA EL MOCK DE PERMISOS PROVISORIO
  it('should return error if user is banned (Permission Mock)', async () => {
    const ws = await connectWs('channel-4');

    return new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const response = JSON.parse(data.toString());
        assert.strictEqual(response.error, 'User does not have permission to send messages in this channel');
        ws.close();
        resolve();
      });

      ws.send(JSON.stringify({ authorId: 'banned-user', content: 'Trying to spam' }));
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

    return new Promise<void>((resolve, reject) => {
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
