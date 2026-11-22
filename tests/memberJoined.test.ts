import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../src/config/db';
import { Message } from '../src/models/Message';
import { EventConsumer } from '../src/services/EventConsumer';
import { ChatService } from '../src/services/ChatService';
import { MetricsService } from '../src/services/MetricsService';
import { PubSubService } from '../src/services/PubSubService';

/** "Se unió …": member.joined de Server-Roles → mensaje del sistema en el canal de bienvenida. */

const SERVER = '11111111-1111-4111-8111-111111111111';

describe('member.joined', () => {
  let mongoServer: MongoMemoryServer;
  let published: { channelId: string; payload: unknown }[] = [];

  before(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();
    await Message.init();
  });

  after(async () => {
    await disconnectDB();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Message.deleteMany({});
    published = [];
    mock.method(PubSubService, 'publish', async (channelId: string, payload: unknown) => {
      published.push({ channelId, payload });
    });
  });

  afterEach(() => mock.restoreAll());

  const joined = (channelId: string | null, userId = 'auth0|ana', messageId = 'evt-1') =>
    EventConsumer.handleEvent('member.joined', { server_id: SERVER, user_id: userId, channel_id: channelId }, { messageId });

  it('publica en vivo un mensaje del sistema en el canal de bienvenida, con quien se unió como autor', async () => {
    await joined('general');

    const stored = await Message.find({ channelId: 'general' }).lean();
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].systemEvent, 'member_join');
    assert.strictEqual(stored[0].authorId, 'auth0|ana');

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].channelId, 'general');
    const payload = published[0].payload as { type: string; system: unknown; content: string };
    assert.strictEqual(payload.type, 'system');
    assert.deepStrictEqual(payload.system, { event: 'member_join', userId: 'auth0|ana' });
    assert.strictEqual(payload.content, '');
  });

  it('el mismo evento entregado dos veces no duplica el aviso', async () => {
    await joined('general', 'auth0|ana', 'evt-1');
    await joined('general', 'auth0|ana', 'evt-1');

    assert.strictEqual(await Message.countDocuments({ channelId: 'general' }), 1);
    assert.strictEqual(published.length, 1);
  });

  it('volver a unirse (otro evento) sí avisa de nuevo', async () => {
    await joined('general', 'auth0|ana', 'evt-1');
    await joined('general', 'auth0|ana', 'evt-2');

    assert.strictEqual(await Message.countDocuments({ channelId: 'general' }), 2);
  });

  it('sin canal de bienvenida no hay aviso', async () => {
    await joined(null);

    assert.strictEqual(await Message.countDocuments({}), 0);
    assert.strictEqual(published.length, 0);
  });

  it('aparece en el historial como mensaje del sistema', async () => {
    await joined('general');

    const [message] = await ChatService.getHistory('general');
    assert.strictEqual(message.type, 'system');
    assert.deepStrictEqual(message.system, { event: 'member_join', userId: 'auth0|ana' });
  });

  it('no se puede editar ni fijar', async () => {
    await joined('general');
    const message = await Message.findOne({ channelId: 'general' });
    const id = message!._id.toString();

    await assert.rejects(ChatService.editMessage('auth0|ana', 'general', id, 'hola'), { name: 'ValidationError' });
    await assert.rejects(ChatService.setPinned('auth0|mod', 'general', id, true, true), { name: 'ValidationError' });
  });

  it('se puede saludar con una reacción', async () => {
    await joined('general');
    const message = await Message.findOne({ channelId: 'general' });

    const reacted = await ChatService.toggleReaction('auth0|beto', 'general', message!._id.toString(), '👋');

    assert.deepStrictEqual(reacted.reactions?.map((r) => r.emoji), ['👋']);
  });

  it('no cuenta en las métricas ni aparece en la búsqueda', async () => {
    await joined('general');
    await Message.create({ content: 'hola a todos', channelId: 'general', authorId: 'auth0|beto' });
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 60_000);

    assert.deepStrictEqual(await MetricsService.messageMetrics(from, to), { messages: 1, activeUsers: 1 });
    const perServer = await MetricsService.channelMessageMetrics(from, to, ['general']);
    assert.strictEqual(perServer.messages, 1);

    const byAuthor = await ChatService.searchChannelMessages('general', { authorId: 'auth0|ana' });
    assert.deepStrictEqual(byAuthor.messages, []);
  });
});
