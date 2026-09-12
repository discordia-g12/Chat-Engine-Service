import { describe, it, before, after } from 'node:test';
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

  before(async () => {
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
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
  });

  it('Should load history with pagination in chronological order', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages?limit=10`
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
      url: `/channels/${channelId}/messages?limit=5&before=${oldestSeenId}`
    });

    const paginatedBody = paginatedRes.json();
    assert.strictEqual(paginatedBody.messages.length, 5);
    assert.strictEqual(paginatedBody.messages[4].content, 'Message sequence 5'); 
  });

  it('Should receive missed messages chronologically upon WS reconnection', async () => {
    const lastSeenMessageId = seededMessages[9].id.toString(); // 
    
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/channels/${channelId}/ws?last_message_id_seen=${lastSeenMessageId}`);
      
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