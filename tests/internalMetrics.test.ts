import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { Message } from '../src/models/Message';

const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-08T00:00:00.000Z';

describe('GET /internal/metrics/messages', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;

  before(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();
    await Message.syncIndexes();
    app = buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Message.deleteMany({});
  });

  const post = (authorId: string, createdAt: string, extra: object = {}) =>
    Message.create({ channelId: 'general', authorId, content: 'hola', createdAt: new Date(createdAt), ...extra });

  const getMetrics = (query: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/internal/metrics/messages${query}`, headers });

  it('cuenta mensajes de canales y DMs, borrados incluidos, y autores distintos en [from, to)', async () => {
    await post('u1', '2026-11-01T00:00:00.000Z'); // justo en `from`: entra
    await post('u1', '2026-11-03T10:00:00.000Z');
    await post('u2', '2026-11-04T10:00:00.000Z', { channelId: 'dm-0123456789abcdef01234567' });
    await post('u3', '2026-11-05T10:00:00.000Z', { isDeleted: true, deletedAt: new Date(), content: '' });
    await post('u4', '2026-10-31T23:59:59.999Z'); // antes del rango
    await post('u5', '2026-11-08T00:00:00.000Z'); // justo en `to`: no entra

    const res = await getMetrics(`?from=${FROM}&to=${TO}`);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { from: FROM, to: TO, messages: 4, activeUsers: 3 });
  });

  it('normaliza las fechas a ISO en UTC', async () => {
    const res = await getMetrics('?from=2026-11-01&to=2026-11-01T03:00:00-03:00');

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), {
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-01T06:00:00.000Z',
      messages: 0,
      activeUsers: 0,
    });
  });

  it('rango sin mensajes: 0 y 0', async () => {
    await post('u1', '2026-10-15T10:00:00.000Z');

    const res = await getMetrics(`?from=${FROM}&to=${TO}`);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { from: FROM, to: TO, messages: 0, activeUsers: 0 });
  });

  it('usa el índice { createdAt, authorId }', async () => {
    const indexes = await Message.collection.indexes();
    assert.ok(indexes.some((i) => JSON.stringify(i.key) === JSON.stringify({ createdAt: 1, authorId: 1 })));
  });

  const invalid: [string, string][] = [
    ['falta from', `?to=${TO}`],
    ['falta to', `?from=${FROM}`],
    ['faltan los dos', ''],
    ['from vacío', `?from=&to=${TO}`],
    ['from no es fecha', `?from=ayer&to=${TO}`],
    ['to no es ISO 8601', `?from=${FROM}&to=1730419200000`],
    ['fecha imposible', `?from=2026-13-45&to=${TO}`],
    ['from repetido', `?from=${FROM}&from=${FROM}&to=${TO}`],
    ['from igual a to', `?from=${FROM}&to=${FROM}`],
    ['from posterior a to', `?from=${TO}&to=${FROM}`],
  ];

  for (const [name, query] of invalid) {
    it(`400 si ${name}`, async () => {
      const res = await getMetrics(query);

      assert.strictEqual(res.statusCode, 400);
      assert.match(res.headers['content-type'] as string, /application\/problem\+json/);
      const body = res.json();
      assert.strictEqual(body.status, 400);
      assert.strictEqual(body.title, 'Bad Request');
      assert.ok(body.detail);
    });
  }

  it('404 si llega por Kong (trae X-User-Id o X-Forwarded-Prefix)', async () => {
    for (const headers of [{ 'x-user-id': 'u1' }, { 'x-forwarded-prefix': '/api/v1/chat' }]) {
      const res = await getMetrics(`?from=${FROM}&to=${TO}`, headers);
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.json().status, 404);
    }
  });
});
