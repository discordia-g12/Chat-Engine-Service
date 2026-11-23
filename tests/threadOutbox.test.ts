import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/db';
import { Message } from '../src/models/Message';
import { EventConsumer } from '../src/services/EventConsumer';
import { MAX_ATTEMPTS, ThreadOutbox, retryDelayMs } from '../src/services/ThreadOutbox';

describe('ThreadOutbox (D3: avisos que no se pierden, D4: contador que se recupera)', () => {
  let mongoServer: MongoMemoryServer;
  let originalFetch: typeof globalThis.fetch;
  const origPublish = EventConsumer.publishConfirmed;
  let published: Record<string, unknown>[];
  let confirms: boolean;
  let coreDown: boolean;
  const channelId = 'channel-outbox';
  const later = () => new Date(Date.now() + 365 * 86_400_000);

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async () => {
      if (coreDown) throw new Error('fetch failed');
      return { status: 200, json: async () => ({ user_ids: ['alice', 'bob', 'carol'] }) } as Response;
    });
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();
  });

  after(async () => {
    EventConsumer.publishConfirmed = origPublish;
    globalThis.fetch = originalFetch;
    await disconnectDB();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Message.deleteMany({});
    published = [];
    confirms = true;
    coreDown = false;
    EventConsumer.publishConfirmed = async (_key: string, payload: Record<string, unknown>) => {
      published.push(payload);
      return confirms;
    };
  });

  const root = (thread?: object) =>
    Message.create({ content: 'tema', authorId: 'alice', channelId, ...(thread ? { thread } : {}) });

  /** Una respuesta tal como queda si el proceso se cae justo después de guardarla. */
  const pendingReply = (parentId: mongoose.Types.ObjectId, extra: object = {}) =>
    Message.create({
      content: 'respuesta',
      authorId: 'bob',
      channelId,
      threadParentId: parentId,
      outbox: { eventId: 'evt-1', summaryPending: true, serverId: 'srv', attempts: 0, nextAttemptAt: new Date() },
      ...extra,
    });

  it('caída antes de sumar la respuesta: el relay recuenta el hilo y publica el aviso', async () => {
    const parent = await root();
    const reply = await pendingReply(parent._id);

    assert.strictEqual(await ThreadOutbox.processDue(later()), 1);

    const dbRoot = await Message.findById(parent._id).lean();
    assert.strictEqual(dbRoot?.thread?.replyCount, 1);
    assert.strictEqual(dbRoot?.thread?.lastReplyId.toString(), reply.id);
    assert.deepStrictEqual(dbRoot?.thread?.participantIds, ['alice', 'bob']);
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].event_id, 'evt-1');
    assert.deepStrictEqual(published[0].thread_participant_ids, ['alice']);
    assert.strictEqual((await Message.findById(reply._id).lean())?.outbox, undefined);
  });

  it('caída antes de restar un borrado: el recuento deja solo las visibles', async () => {
    const parent = await root({ replyCount: 2, lastReplyAt: new Date(), lastReplyId: new mongoose.Types.ObjectId(), participantIds: ['alice', 'bob'] });
    await Message.create({ content: 'sigue', authorId: 'carol', channelId, threadParentId: parent._id });
    await pendingReply(parent._id, {
      isDeleted: true,
      content: '',
      outbox: { summaryPending: true, serverId: 'srv', attempts: 0, nextAttemptAt: new Date() },
    });

    await ThreadOutbox.processDue(later());

    const dbRoot = await Message.findById(parent._id).lean();
    assert.strictEqual(dbRoot?.thread?.replyCount, 1);
    // Los participantes no se pierden: bob respondió (aunque después borró)
    assert.deepStrictEqual([...(dbRoot?.thread?.participantIds ?? [])].sort(), ['alice', 'bob', 'carol']);
    assert.strictEqual(published.length, 0);
  });

  it('si RabbitMQ no confirma, queda pendiente con backoff y se publica con el mismo event_id', async () => {
    const parent = await root({ replyCount: 1, lastReplyAt: new Date(), lastReplyId: new mongoose.Types.ObjectId(), participantIds: ['alice', 'bob'] });
    const reply = await pendingReply(parent._id, {
      outbox: { eventId: 'evt-2', serverId: 'srv', attempts: 0, nextAttemptAt: new Date() },
    });
    confirms = false;

    assert.strictEqual(await ThreadOutbox.deliver(reply._id), false);
    const pending = (await Message.findById(reply._id).lean())?.outbox;
    assert.strictEqual(pending?.attempts, 1);
    assert.ok(pending!.nextAttemptAt.getTime() > Date.now());

    // Todavía no venció: el relay no lo toma
    assert.strictEqual(await ThreadOutbox.processDue(new Date()), 0);

    confirms = true;
    await ThreadOutbox.processDue(later());
    assert.deepStrictEqual(published.map((p) => p.event_id), ['evt-2', 'evt-2']);
    assert.strictEqual((await Message.findById(reply._id).lean())?.outbox, undefined);
  });

  it('si Server-Roles no responde, se reintenta después en vez de descartarlo', async () => {
    const parent = await root({ replyCount: 1, lastReplyAt: new Date(), lastReplyId: new mongoose.Types.ObjectId(), participantIds: ['alice', 'bob'] });
    const reply = await pendingReply(parent._id, {
      outbox: { eventId: 'evt-3', serverId: 'srv', attempts: 0, nextAttemptAt: new Date() },
    });
    coreDown = true;

    assert.strictEqual(await ThreadOutbox.deliver(reply._id), false);
    assert.strictEqual(published.length, 0);
    assert.strictEqual((await Message.findById(reply._id).lean())?.outbox?.attempts, 1);
  });

  it('una respuesta borrada antes de avisar no se avisa', async () => {
    const parent = await root({ replyCount: 0, lastReplyAt: new Date(), lastReplyId: new mongoose.Types.ObjectId(), participantIds: ['alice', 'bob'] });
    const reply = await pendingReply(parent._id, {
      isDeleted: true,
      content: '',
      outbox: { eventId: 'evt-4', serverId: 'srv', attempts: 0, nextAttemptAt: new Date() },
    });

    assert.strictEqual(await ThreadOutbox.deliver(reply._id), true);
    assert.strictEqual(published.length, 0);
    assert.strictEqual((await Message.findById(reply._id).lean())?.outbox, undefined);
  });

  it('en un DM no pregunta a Server-Roles y avisa al otro', async () => {
    const parent = await Message.create({
      content: 'hola',
      authorId: 'alice',
      channelId: 'dm-1',
      thread: { replyCount: 1, lastReplyAt: new Date(), lastReplyId: new mongoose.Types.ObjectId(), participantIds: ['alice', 'bob'] },
    });
    const reply = await pendingReply(parent._id, {
      channelId: 'dm-1',
      outbox: { eventId: 'evt-dm', serverId: '', attempts: 0, nextAttemptAt: new Date() },
    });
    coreDown = true;

    assert.strictEqual(await ThreadOutbox.deliver(reply._id), true);
    assert.strictEqual(published[0].server_id, null);
    assert.strictEqual(published[0].is_dm, true);
    assert.deepStrictEqual(published[0].thread_participant_ids, ['alice']);
  });

  it('después del máximo de intentos lo deja (queda en el log) para no reintentar para siempre', async () => {
    const parent = await root({ replyCount: 1, lastReplyAt: new Date(), lastReplyId: new mongoose.Types.ObjectId(), participantIds: ['alice', 'bob'] });
    const reply = await pendingReply(parent._id, {
      outbox: { eventId: 'evt-5', serverId: 'srv', attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date() },
    });
    confirms = false;

    assert.strictEqual(await ThreadOutbox.deliver(reply._id), true);
    assert.strictEqual((await Message.findById(reply._id).lean())?.outbox, undefined);
  });

  it('un hilo que se quedó sin respuestas pierde el resumen', async () => {
    const parent = await root({ replyCount: 3, lastReplyAt: new Date(), lastReplyId: new mongoose.Types.ObjectId(), participantIds: ['alice'] });
    await ThreadOutbox.recountSummary(parent._id);
    assert.strictEqual((await Message.findById(parent._id).lean())?.thread, undefined);
  });

  it('backoff: 30 s, 1 min, 2 min… con tope de 30 min', () => {
    assert.strictEqual(retryDelayMs(1), 30_000);
    assert.strictEqual(retryDelayMs(2), 60_000);
    assert.strictEqual(retryDelayMs(3), 120_000);
    assert.strictEqual(retryDelayMs(20), 30 * 60_000);
  });

  it('start y stop del relay', async () => {
    ThreadOutbox.start({ intervalMs: 5 });
    ThreadOutbox.start({ intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ThreadOutbox.stop();
  });
});
