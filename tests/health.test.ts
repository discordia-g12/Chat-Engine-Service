import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { MongoMemoryServer } from 'mongodb-memory-server';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { getRedis, disconnectRedis } from '../src/config/redis';
import type { RedisPinger } from '../src/config/readiness';

const healthyRedis: RedisPinger = { ping: async () => 'PONG' };
const downRedis: RedisPinger = {
  ping: async () => {
    throw new Error('ECONNREFUSED');
  },
};
const hangingRedis: RedisPinger = { ping: () => new Promise<string>(() => {}) };

// Assigning `undefined` to process.env stores the string "undefined", so delete instead.
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('Health endpoints', () => {
  let mongoServer: MongoMemoryServer;

  before(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();
  });

  after(async () => {
    await disconnectDB();
    await mongoServer.stop();
  });

  it('GET /livez returns ok', async () => {
    const app = buildApp({ redis: downRedis });
    const res = await app.inject({ method: 'GET', url: '/livez' });
    assert.strictEqual(res.statusCode, 200, 'liveness must not depend on Mongo/Redis');
    const body = res.json();
    assert.strictEqual(body.status, 'ok');
    assert.ok(body.timestamp);
    await app.close();
  });

  it('GET /readyz returns 200 when Mongo and Redis are up', async () => {
    const app = buildApp({ redis: healthyRedis });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { status: 'ready', checks: { mongo: 'ok', redis: 'ok', rabbitmq: 'disconnected' } });
    await app.close();
  });

  it('GET /readyz returns 503 when Redis is down', async () => {
    const app = buildApp({ redis: downRedis });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.json(), { status: 'not_ready', checks: { mongo: 'ok', redis: 'fail', rabbitmq: 'disconnected' } });
    await app.close();
  });

  it('GET /readyz returns 503 when Redis answers something other than PONG', async () => {
    const app = buildApp({ redis: { ping: async () => 'LOADING' } });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().checks.redis, 'fail');
    await app.close();
  });

  it('GET /readyz returns 503 (not hang) when Redis ping never answers', { timeout: 3000 }, async () => {
    const app = buildApp({ redis: hangingRedis, readinessTimeoutMs: 100 });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().checks.redis, 'fail');
    await app.close();
  });

  it('GET /readyz uses the shared Redis client by default (unreachable -> 503)', { timeout: 3000 }, async () => {
    const originalUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://127.0.0.1:1'; // nothing listens on port 1
    getRedis().on('error', () => {}); // silence reconnect noise in test output
    const app = buildApp({ readinessTimeoutMs: 200 });
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      assert.strictEqual(res.statusCode, 503);
      assert.strictEqual(res.json().checks.redis, 'fail');
    } finally {
      await app.close();
      await disconnectRedis();
      restoreEnv('REDIS_URL', originalUrl);
    }
  });

  it('GET /readyz returns 503 when Mongo is disconnected', async () => {
    await disconnectDB();
    const app = buildApp({ redis: healthyRedis });
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      assert.strictEqual(res.statusCode, 503);
      assert.deepStrictEqual(res.json(), { status: 'not_ready', checks: { mongo: 'fail', redis: 'ok', rabbitmq: 'disconnected' } });
    } finally {
      await app.close();
      await connectDB();
    }
  });
});

describe('Redis client lifecycle', () => {
  it('getRedis returns a singleton and disconnectRedis resets it', async () => {
    const originalUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const first = getRedis();
    first.on('error', () => {});
    assert.strictEqual(getRedis(), first);
    await disconnectRedis();
    await disconnectRedis(); // no-op when there is no client
    const second = getRedis();
    second.on('error', () => {});
    assert.notStrictEqual(second, first);
    await disconnectRedis();
    restoreEnv('REDIS_URL', originalUrl);
  });
});
