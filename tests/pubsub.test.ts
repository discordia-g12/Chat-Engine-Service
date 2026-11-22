import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { PRESENCE_CHANNEL, PubSubService, type PubSubLogger } from '../src/services/PubSubService';
import { SessionManager } from '../src/services/SessionManager';
import { getRedis, getSubscriberRedis, disconnectRedis } from '../src/config/redis';
import type { WebSocket } from 'ws';
import type Redis from 'ioredis';

const silentLogger: PubSubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeRedis extends EventEmitter {
  published: Array<{ channel: string; message: string }> = [];
  subscribedChannels = new Set<string>();
  unsubscribedChannels: string[] = [];
  status = 'ready';
  failPublish = false;
  failSubscribe = false;
  failUnsubscribe = false;

  async publish(channel: string, message: string): Promise<number> {
    if (this.failPublish) {
      throw new Error('Simulated publish failure');
    }
    this.published.push({ channel, message });
    return 1;
  }

  async subscribe(...channels: string[]): Promise<number> {
    if (this.failSubscribe) {
      throw new Error('Simulated subscribe failure');
    }
    for (const c of channels) {
      this.subscribedChannels.add(c);
    }
    return channels.length;
  }

  async unsubscribe(...channels: string[]): Promise<number> {
    if (this.failUnsubscribe) {
      throw new Error('Simulated unsubscribe failure');
    }
    for (const c of channels) {
      this.subscribedChannels.delete(c);
      this.unsubscribedChannels.push(c);
    }
    return channels.length;
  }

  async quit(): Promise<'OK'> {
    this.status = 'end';
    return 'OK';
  }

  disconnect(): void {
    this.status = 'end';
  }

  duplicate(): FakeRedis {
    return new FakeRedis();
  }
}

function createMockSocket(initialReadyState = 1): WebSocket {
  const sentMessages: string[] = [];
  let closedWith: { code: number; reason: string } | null = null;
  let readyState = initialReadyState;

  return {
    get readyState() {
      return readyState;
    },
    set readyState(val: number) {
      readyState = val;
    },
    send: (data: string) => {
      sentMessages.push(data);
    },
    close: (code = 1000, reason = '') => {
      readyState = 3;
      closedWith = { code, reason };
    },
    _sentMessages: sentMessages,
    _closedWith: () => closedWith,
  } as unknown as WebSocket;
}

describe('PubSubService and Multi-Node Redis Pub/Sub', () => {
  let fakePublisher: FakeRedis;
  let fakeSubscriber: FakeRedis;

  beforeEach(() => {
    SessionManager.clear();
    fakePublisher = new FakeRedis();
    fakeSubscriber = new FakeRedis();
  });

  afterEach(async () => {
    await PubSubService.stop();
    SessionManager.clear();
  });

  it('formats channel keys and extracts channel IDs correctly', () => {
    assert.strictEqual(PubSubService.channelKey('chan-123'), 'channel:chan-123');
    assert.strictEqual(PubSubService.channelIdFromKey('channel:chan-123'), 'chan-123');
    assert.strictEqual(PubSubService.channelIdFromKey('other:chan-123'), null);
    assert.strictEqual(PubSubService.channelIdFromKey('channel'), null);
  });

  it('starts and stops cleanly, managing lifecycle and error listeners', async () => {
    let warnCount = 0;
    const trackingLogger: PubSubLogger = {
      ...silentLogger,
      warn: () => {
        warnCount += 1;
      },
    };

    assert.strictEqual(PubSubService.isStarted(), false);
    await PubSubService.start({
      publisher: fakePublisher as unknown as Redis,
      subscriber: fakeSubscriber as unknown as Redis,
      logger: trackingLogger,
    });
    assert.strictEqual(PubSubService.isStarted(), true);

    // Starting again should be a no-op
    await PubSubService.start({
      publisher: fakePublisher as unknown as Redis,
      subscriber: fakeSubscriber as unknown as Redis,
    });
    assert.strictEqual(PubSubService.isStarted(), true);

    // Error event handling on publisher and subscriber
    fakePublisher.emit('error', new Error('Publisher test error'));
    fakeSubscriber.emit('error', new Error('Subscriber test error'));
    assert.strictEqual(warnCount, 2);

    await PubSubService.stop();
    assert.strictEqual(PubSubService.isStarted(), false);

    // Stopping again should be a no-op
    await PubSubService.stop();
    assert.strictEqual(PubSubService.isStarted(), false);
  });

  it('dynamically subscribes and unsubscribes as WebSockets connect and disconnect', async () => {
    await PubSubService.start({
      publisher: fakePublisher as unknown as Redis,
      subscriber: fakeSubscriber as unknown as Redis,
      logger: silentLogger,
    });

    const ws1 = createMockSocket();
    const ws2 = createMockSocket();

    // 1st connection in chan-1: triggers Redis SUBSCRIBE
    SessionManager.register({
      userId: 'alice',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: ws1,
      canSend: true,
      connectedAt: new Date(),
    });
    await flushAsync();

    assert.strictEqual(PubSubService.isSubscribed('chan-1'), true);
    assert.strictEqual(fakeSubscriber.subscribedChannels.has('channel:chan-1'), true);
    assert.deepStrictEqual(PubSubService.getSubscribedChannels(), ['chan-1']);

    // 2nd connection in chan-1: subscription remains, does not re-subscribe
    SessionManager.register({
      userId: 'bob',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: ws2,
      canSend: true,
      connectedAt: new Date(),
    });
    await flushAsync();

    // Una sola suscripción al canal, más la de presencia (que es de la instancia, no de un socket)
    assert.deepStrictEqual(Array.from(fakeSubscriber.subscribedChannels).sort(), ['channel:chan-1', PRESENCE_CHANNEL]);

    // Unregister ws1: chan-1 still has ws2, so remains subscribed
    SessionManager.unregister(ws1);
    await flushAsync();
    assert.strictEqual(PubSubService.isSubscribed('chan-1'), true);
    assert.strictEqual(fakeSubscriber.subscribedChannels.has('channel:chan-1'), true);

    // Unregister ws2: chan-1 has 0 sockets left, triggers Redis UNSUBSCRIBE
    SessionManager.unregister(ws2);
    await flushAsync();
    assert.strictEqual(PubSubService.isSubscribed('chan-1'), false);
    assert.strictEqual(fakeSubscriber.subscribedChannels.has('channel:chan-1'), false);
    assert.ok(fakeSubscriber.unsubscribedChannels.includes('channel:chan-1'));
  });

  it('resubscribes channels that already have active sockets when starting', async () => {
    const ws = createMockSocket();
    SessionManager.register({
      userId: 'alice',
      channelId: 'chan-pre-existing',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });

    await PubSubService.start({
      publisher: fakePublisher as unknown as Redis,
      subscriber: fakeSubscriber as unknown as Redis,
      logger: silentLogger,
    });

    assert.strictEqual(PubSubService.isSubscribed('chan-pre-existing'), true);
    assert.strictEqual(fakeSubscriber.subscribedChannels.has('channel:chan-pre-existing'), true);
  });

  it('publishes messages and distributes incoming Redis events to matching local sockets', async () => {
    await PubSubService.start({
      publisher: fakePublisher as unknown as Redis,
      subscriber: fakeSubscriber as unknown as Redis,
      logger: silentLogger,
    });

    const wsAlice = createMockSocket();
    const wsBob = createMockSocket();
    const wsClosed = createMockSocket(3); // readyState = 3 (CLOSED)
    const wsOtherChannel = createMockSocket();

    SessionManager.register({
      userId: 'alice',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: wsAlice,
      canSend: true,
      connectedAt: new Date(),
    });
    SessionManager.register({
      userId: 'bob',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: wsBob,
      canSend: true,
      connectedAt: new Date(),
    });
    SessionManager.register({
      userId: 'charlie',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: wsClosed,
      canSend: true,
      connectedAt: new Date(),
    });
    SessionManager.register({
      userId: 'dan',
      channelId: 'chan-2',
      serverId: 'srv-1',
      socket: wsOtherChannel,
      canSend: true,
      connectedAt: new Date(),
    });

    // Test publishing payload (both object and string)
    const messagePayload = { id: 'msg-1', content: 'Hello Redis', authorId: 'alice', channelId: 'chan-1' };
    await PubSubService.publish('chan-1', messagePayload);

    assert.strictEqual(fakePublisher.published.length, 1);
    assert.strictEqual(fakePublisher.published[0].channel, 'channel:chan-1');
    assert.strictEqual(fakePublisher.published[0].message, JSON.stringify(messagePayload));

    // Simulate incoming message from Redis Pub/Sub
    fakeSubscriber.emit('message', 'channel:chan-1', JSON.stringify(messagePayload));

    // Both open sockets on chan-1 received the message
    const aliceReceived = (wsAlice as unknown as { _sentMessages: string[] })._sentMessages;
    const bobReceived = (wsBob as unknown as { _sentMessages: string[] })._sentMessages;
    const closedReceived = (wsClosed as unknown as { _sentMessages: string[] })._sentMessages;
    const otherReceived = (wsOtherChannel as unknown as { _sentMessages: string[] })._sentMessages;

    assert.strictEqual(aliceReceived.length, 1);
    assert.strictEqual(JSON.parse(aliceReceived[0]).content, 'Hello Redis');
    assert.strictEqual(bobReceived.length, 1);
    assert.strictEqual(JSON.parse(bobReceived[0]).content, 'Hello Redis');

    // Sockets in other states or channels should not receive it
    assert.strictEqual(closedReceived.length, 0);
    assert.strictEqual(otherReceived.length, 0);

    // Publishing raw string
    await PubSubService.publish('chan-1', 'raw-payload');
    assert.strictEqual(fakePublisher.published[1].message, 'raw-payload');

    // Incoming message from non-channel topic is ignored safely
    fakeSubscriber.emit('message', 'other:topic', 'some data');
    assert.strictEqual(aliceReceived.length, 1);
  });

  it('simulates cross-node messaging across two independent nodes', async () => {
    // Simulated shared Redis message bus
    const sharedBus = new EventEmitter();

    const nodeAPublisher = new FakeRedis();
    const nodeASubscriber = new FakeRedis();
    nodeAPublisher.publish = async (channel: string, message: string) => {
      sharedBus.emit(channel, message);
      return 1;
    };
    sharedBus.on('channel:chan-shared', (msg) => {
      nodeASubscriber.emit('message', 'channel:chan-shared', msg);
    });

    const wsAlice = createMockSocket();

    // Start Node A
    await PubSubService.start({
      publisher: nodeAPublisher as unknown as Redis,
      subscriber: nodeASubscriber as unknown as Redis,
      logger: silentLogger,
    });

    SessionManager.register({
      userId: 'alice',
      channelId: 'chan-shared',
      serverId: 'srv-1',
      socket: wsAlice,
      canSend: true,
      connectedAt: new Date(),
    });

    // Simulate Node B publishing into the same channel
    const nodeBMessage = { id: 'msg-b', content: 'Message from Node B', authorId: 'bob', channelId: 'chan-shared' };
    sharedBus.emit('channel:chan-shared', JSON.stringify(nodeBMessage));

    // Alice on Node A receives the message from Node B
    const aliceReceived = (wsAlice as unknown as { _sentMessages: string[] })._sentMessages;
    assert.strictEqual(aliceReceived.length, 1);
    assert.strictEqual(JSON.parse(aliceReceived[0]).content, 'Message from Node B');
  });

  it('uses inbox:<userId> as the Redis key of the socket per user', () => {
    assert.strictEqual(PubSubService.channelKey('inbox:alice'), 'inbox:alice');
    assert.strictEqual(PubSubService.channelIdFromKey('inbox:alice'), 'inbox:alice');
  });

  it('delivers an inbox event once, to the node that holds the socket, with two instances', async () => {
    const sharedBus = new EventEmitter();
    const nodeA = new FakeRedis();
    const nodeB = new FakeRedis();
    const subscriber = new FakeRedis();
    for (const node of [nodeA, nodeB]) {
      node.publish = async (channel: string, message: string) => {
        node.published.push({ channel, message });
        sharedBus.emit('published', channel, message);
        return 1;
      };
    }
    // Esta instancia recibe solo lo que tiene suscripto, como en Redis
    sharedBus.on('published', (channel: string, message: string) => {
      if (subscriber.subscribedChannels.has(channel)) subscriber.emit('message', channel, message);
    });

    await PubSubService.start({
      publisher: nodeA as unknown as Redis,
      subscriber: subscriber as unknown as Redis,
      logger: silentLogger,
    });

    const ws = createMockSocket();
    SessionManager.register({
      userId: 'alice',
      channelId: 'inbox:alice',
      serverId: '',
      socket: ws,
      canSend: false,
      connectedAt: new Date(),
    });
    await flushAsync();
    assert.ok(subscriber.subscribedChannels.has('inbox:alice'));

    const received = (ws as unknown as { _sentMessages: string[] })._sentMessages;

    // Publicado por esta instancia: llega una sola vez (por Redis, no además en local)
    await PubSubService.publishToInbox('alice', { type: 'DM_MESSAGE', from: 'node-a' });
    assert.deepStrictEqual(nodeA.published.map((p) => p.channel), ['inbox:alice']);
    assert.strictEqual(received.length, 1);

    // Publicado por otra instancia
    await nodeB.publish('inbox:alice', JSON.stringify({ type: 'DM_MESSAGE', from: 'node-b' }));
    assert.strictEqual(received.length, 2);
    assert.strictEqual(JSON.parse(received[1]).from, 'node-b');

    // El inbox de otro usuario no le llega
    await nodeB.publish('inbox:bob', JSON.stringify({ type: 'DM_MESSAGE' }));
    assert.strictEqual(received.length, 2);

    SessionManager.unregister(ws);
    await flushAsync();
    assert.ok(!subscriber.subscribedChannels.has('inbox:alice'));
  });

  it('falls back to local broadcast when PubSubService is not started', async () => {
    const ws = createMockSocket();
    SessionManager.register({
      userId: 'local-user',
      channelId: 'chan-local',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });

    // PubSubService is not started
    assert.strictEqual(PubSubService.isStarted(), false);
    await PubSubService.publish('chan-local', { content: 'Direct local' });

    const received = (ws as unknown as { _sentMessages: string[] })._sentMessages;
    assert.strictEqual(received.length, 1);
    assert.strictEqual(JSON.parse(received[0]).content, 'Direct local');
  });

  it('handles publish and subscribe errors gracefully with logging and fallback', async () => {
    let errorCount = 0;
    const errorLogger: PubSubLogger = {
      ...silentLogger,
      error: () => {
        errorCount += 1;
      },
    };

    fakePublisher.failPublish = true;
    fakeSubscriber.failSubscribe = true;
    fakeSubscriber.failUnsubscribe = true;

    await PubSubService.start({
      publisher: fakePublisher as unknown as Redis,
      subscriber: fakeSubscriber as unknown as Redis,
      logger: errorLogger,
    });

    const ws = createMockSocket();
    SessionManager.register({
      userId: 'err-user',
      channelId: 'chan-err',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });
    await flushAsync();

    // Subscribe errors were logged: the presence channel (on start) and the socket's channel
    assert.strictEqual(errorCount, 2);

    // When publish fails, it logs error and falls back to local broadcast
    await PubSubService.publish('chan-err', { content: 'Fallback on error' });
    assert.strictEqual(errorCount, 3);

    const received = (ws as unknown as { _sentMessages: string[] })._sentMessages;
    assert.strictEqual(received.length, 1);
    assert.strictEqual(JSON.parse(received[0]).content, 'Fallback on error');

    // When unsubscribe is called for a channel that failed to subscribe, it cleanly returns early
    SessionManager.unregister(ws);
    await flushAsync();
    assert.strictEqual(errorCount, 3);

    // Now test unsubscribe error when unregistering a previously subscribed channel
    fakeSubscriber.failSubscribe = false;
    fakeSubscriber.failUnsubscribe = true;
    const ws2 = createMockSocket();
    SessionManager.register({
      userId: 'user-unsub',
      channelId: 'chan-unsub-fail',
      serverId: 'srv-1',
      socket: ws2,
      canSend: true,
      connectedAt: new Date(),
    });
    await flushAsync();

    SessionManager.unregister(ws2);
    await flushAsync();
    assert.strictEqual(errorCount, 4);
  });

  describe('presence channel', () => {
    afterEach(() => PubSubService.setPresenceHandler(null));

    it('each instance subscribes on start and hands what arrives to the presence handler', async () => {
      const delivered: string[] = [];
      PubSubService.setPresenceHandler((raw) => delivered.push(raw));
      await PubSubService.start({
        publisher: fakePublisher as unknown as Redis,
        subscriber: fakeSubscriber as unknown as Redis,
        logger: silentLogger,
      });
      assert.ok(fakeSubscriber.subscribedChannels.has(PRESENCE_CHANNEL));

      fakeSubscriber.emit('message', PRESENCE_CHANNEL, '{"userId":"bob","status":"idle"}');
      assert.deepStrictEqual(delivered, ['{"userId":"bob","status":"idle"}']);

      await PubSubService.stop();
      assert.ok(fakeSubscriber.unsubscribedChannels.includes(PRESENCE_CHANNEL));
    });

    it('publishes changes to Redis, and locally when Redis fails or is not started', async () => {
      const delivered: string[] = [];
      PubSubService.setPresenceHandler((raw) => delivered.push(raw));

      await PubSubService.publishPresence({ userId: 'bob', status: 'online' });
      assert.deepStrictEqual(delivered, ['{"userId":"bob","status":"online"}']);

      await PubSubService.start({
        publisher: fakePublisher as unknown as Redis,
        subscriber: fakeSubscriber as unknown as Redis,
        logger: silentLogger,
      });
      await PubSubService.publishPresence({ userId: 'bob', status: 'dnd' });
      assert.deepStrictEqual(fakePublisher.published, [{ channel: PRESENCE_CHANNEL, message: '{"userId":"bob","status":"dnd"}' }]);
      assert.strictEqual(delivered.length, 1);

      fakePublisher.failPublish = true;
      await PubSubService.publishPresence({ userId: 'bob', status: 'offline' });
      assert.deepStrictEqual(delivered.at(-1), '{"userId":"bob","status":"offline"}');
    });

    it('a failed unsubscribe on stop is only logged', async () => {
      let errors = 0;
      await PubSubService.start({
        publisher: fakePublisher as unknown as Redis,
        subscriber: fakeSubscriber as unknown as Redis,
        logger: { ...silentLogger, error: () => void errors++ },
      });
      fakeSubscriber.failUnsubscribe = true;

      await PubSubService.stop();
      assert.strictEqual(errors, 1);
    });
  });

  it('handles unsubscribeAll when stop is called with active subscriptions', async () => {
    await PubSubService.start({
      publisher: fakePublisher as unknown as Redis,
      subscriber: fakeSubscriber as unknown as Redis,
      logger: silentLogger,
    });

    const ws = createMockSocket();
    SessionManager.register({
      userId: 'alice',
      channelId: 'chan-active',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });
    await flushAsync();

    assert.strictEqual(PubSubService.isSubscribed('chan-active'), true);
    await PubSubService.stop();
    assert.strictEqual(PubSubService.isSubscribed('chan-active'), false);
    assert.ok(fakeSubscriber.unsubscribedChannels.includes('channel:chan-active'));
  });

  it('handles unsubscribeAll error gracefully', async () => {
    let errorCount = 0;
    const errorLogger: PubSubLogger = {
      ...silentLogger,
      error: () => {
        errorCount += 1;
      },
    };

    await PubSubService.start({
      publisher: fakePublisher as unknown as Redis,
      subscriber: fakeSubscriber as unknown as Redis,
      logger: errorLogger,
    });

    const ws = createMockSocket();
    SessionManager.register({
      userId: 'alice',
      channelId: 'chan-unsub-err',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });
    await flushAsync();

    fakeSubscriber.failUnsubscribe = true;
    await PubSubService.unsubscribeAll();
    assert.strictEqual(errorCount, 1);
  });

  it('verifies config/redis getSubscriberRedis and disconnectRedis', async () => {
    // When REDIS_URL points to invalid port, lazy client initializes
    const originalUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://127.0.0.1:1';

    try {
      const pub = getRedis();
      pub.on('error', () => {});
      const sub = getSubscriberRedis();
      sub.on('error', () => {});

      assert.ok(pub);
      assert.ok(sub);
      assert.notStrictEqual(pub, sub);

      // Disconnect when not ready
      await disconnectRedis();

      // Disconnect when already disconnected is safe
      await disconnectRedis();
    } finally {
      if (originalUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = originalUrl;
      }
    }
  });
});

