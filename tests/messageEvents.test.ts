import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../src/config/db';
import { Conversation } from '../src/models/Conversation';
import { Message } from '../src/models/Message';
import { ChatService } from '../src/services/ChatService';
import { EventConsumer } from '../src/services/EventConsumer';
import { ThreadOutbox } from '../src/services/ThreadOutbox';
import { toDmChannelId } from '../src/helpers/directMessages';

describe('chat.message.created de DMs y canales (ADR 0017: menciones, DMs y nivel all)', () => {
  let mongoServer: MongoMemoryServer;
  const origPublish = EventConsumer.publishConfirmed;
  let published: Record<string, unknown>[];
  let confirms: boolean;
  const later = () => new Date(Date.now() + 365 * 86_400_000);

  before(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();
  });

  after(async () => {
    EventConsumer.publishConfirmed = origPublish;
    await disconnectDB();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Message.deleteMany({});
    await Conversation.deleteMany({});
    published = [];
    confirms = true;
    EventConsumer.publishConfirmed = async (_key: string, payload: Record<string, unknown>) => {
      published.push(payload);
      return confirms;
    };
  });

  /** El aviso sale en segundo plano: espera a que el mensaje no tenga nada pendiente. */
  const settled = async (messageId: string) => {
    for (let i = 0; i < 50; i++) {
      if (!(await Message.findById(messageId).lean())?.outbox) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('the outbox was not cleared');
  };

  const dm = async () => {
    const conversation = await Conversation.create({
      participantKey: 'alice:bob',
      participantIds: ['alice', 'bob'],
      status: 'accepted',
      requestedBy: 'alice',
      lastMessageAt: new Date(),
    });
    return toDmChannelId(conversation._id);
  };

  it('DM: publica con recipient_ids (la conversación menos el autor), sin servidor ni hilo', async () => {
    const channelId = await dm();
    const msg = await ChatService.sendMessage('alice', channelId, 'hola', [], true);
    await settled(msg.id);

    assert.strictEqual(published.length, 1);
    const event = published[0];
    assert.strictEqual(typeof event.event_id, 'string');
    assert.strictEqual(event.server_id, null);
    assert.strictEqual(event.thread_id, null);
    assert.strictEqual(event.is_dm, true);
    assert.strictEqual(event.channel_id, channelId);
    assert.strictEqual(event.message_id, msg.id);
    assert.deepStrictEqual(event.recipient_ids, ['bob']);
    assert.deepStrictEqual(event.thread_participant_ids, []);
    assert.strictEqual(event.preview, 'hola');
  });

  it('canal con mención: publica con mention_user_ids y sin recipient_ids', async () => {
    const msg = await ChatService.sendMessage('alice', 'channel-1', 'mirá esto <@bob>', [], true, undefined, undefined, 'srv-1');
    await settled(msg.id);

    assert.strictEqual(published.length, 1);
    const event = published[0];
    assert.strictEqual(event.server_id, 'srv-1');
    assert.strictEqual(event.thread_id, null);
    assert.strictEqual(event.is_dm, false);
    assert.deepStrictEqual(event.mention_user_ids, ['bob']);
    assert.strictEqual('recipient_ids' in event, false);
  });

  it('mensaje de servidor sin menciones también publica (nivel all)', async () => {
    const msg = await ChatService.sendMessage('alice', 'channel-1', 'buenas', [], true, undefined, undefined, 'srv-1');
    await settled(msg.id);

    assert.strictEqual(published.length, 1);
    assert.deepStrictEqual(published[0].mention_user_ids, []);
    assert.deepStrictEqual(published[0].mention_role_ids, []);
    assert.strictEqual(published[0].mention_everyone, false);
    assert.deepStrictEqual(published[0].thread_participant_ids, []);
  });

  it('roles y @everyone viajan tal como se guardaron', async () => {
    const msg = await Message.create({
      content: '@everyone <@&mods>',
      authorId: 'alice',
      channelId: 'channel-1',
      mentionRoleIds: ['mods'],
      mentionEveryone: true,
      outbox: { eventId: 'evt-roles', serverId: 'srv-1', attempts: 0, nextAttemptAt: new Date() },
    });

    assert.strictEqual(await ThreadOutbox.deliver(msg._id), true);
    assert.deepStrictEqual(published[0].mention_role_ids, ['mods']);
    assert.strictEqual(published[0].mention_everyone, true);
  });

  it('sin servidor conocido (fuera de un DM) no guarda aviso: sin server_id Notification no puede resolverlo', async () => {
    const msg = await ChatService.sendMessage('alice', 'channel-1', 'hola', [], true);
    assert.strictEqual((await Message.findById(msg.id).lean())?.outbox, undefined);
    assert.strictEqual(published.length, 0);
  });

  it('si RabbitMQ no confirma, el relay reintenta con el mismo event_id', async () => {
    confirms = false;
    const msg = await ChatService.sendMessage('alice', 'channel-1', 'hola', [], true, undefined, undefined, 'srv-1');
    // Esperar a que el primer intento deje el backoff anotado
    let pending;
    for (let i = 0; i < 50; i++) {
      pending = (await Message.findById(msg.id).lean())?.outbox;
      if (pending?.attempts === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.strictEqual(pending?.attempts, 1);

    confirms = true;
    await ThreadOutbox.processDue(later());
    assert.strictEqual(published.length, 2);
    assert.strictEqual(published[0].event_id, published[1].event_id);
    assert.strictEqual((await Message.findById(msg.id).lean())?.outbox, undefined);
  });

  it('un DM sin conversación (borrada) no se avisa', async () => {
    const msg = await Message.create({
      content: 'hola',
      authorId: 'alice',
      channelId: 'dm-000000000000000000000000',
      outbox: { eventId: 'evt-gone', serverId: '', attempts: 0, nextAttemptAt: new Date() },
    });

    assert.strictEqual(await ThreadOutbox.deliver(msg._id), true);
    assert.strictEqual(published.length, 0);
    assert.strictEqual((await Message.findById(msg._id).lean())?.outbox, undefined);
  });
});
