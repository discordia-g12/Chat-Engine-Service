import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import WebSocket from 'ws';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { Message } from '../src/models/Message';
import { Conversation } from '../src/models/Conversation';
import { PubSubService } from '../src/services/PubSubService';
import { EventConsumer } from '../src/services/EventConsumer';
import { ReadStateService } from '../src/services/ReadStateService';
import { MAX_THREAD_PARTICIPANTS, PREVIEW_MAX_LENGTH, THREAD_NESTED } from '../src/services/ThreadService';

describe('Threads (GET|POST /channels/:channelId/messages/:messageId/thread)', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let port: number;
  let originalFetch: typeof globalThis.fetch;
  const channelId = 'channel-threads-test';
  const serverId = 'srv-1';

  // Lo que devuelven Core y Auth en cada test
  let members: string[];
  let coreDown: boolean;
  let friends: boolean;

  let published: { channelId: string; payload: Record<string, unknown> }[];
  let inboxEvents: { userId: string; payload: Record<string, unknown> }[];
  let rabbitEvents: { routingKey: string; payload: Record<string, unknown> }[];
  const origPublish = PubSubService.publish;
  const origPublishInbox = PubSubService.publishToInbox;
  const origRabbitPublish = EventConsumer.publishConfirmed;
  // Lo que contesta RabbitMQ a cada publicación (false: no la confirmó)
  let rabbitConfirms: boolean;

  const json = (body: unknown) => ({ status: 200, json: async () => body }) as Response;

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      const canonical = url.pathname.match(/^\/internal\/users\/(.+)\/canonical$/);
      if (canonical) return json({ user_id: decodeURIComponent(canonical[1]), suspended: false });
      if (url.pathname === '/internal/relations') {
        return json({ exists: true, suspended: false, friends, blocked_by_actor: false, blocked_by_other: false });
      }
      if (url.pathname.endsWith('/member-ids')) {
        if (coreDown) throw new Error('fetch failed');
        return json({ user_ids: members });
      }
      const userId = url.searchParams.get('user_id') ?? '';
      return json({
        server_id: serverId,
        can_send: userId !== 'readonly',
        muted_until: null,
        can_mention_everyone: false,
        mentionable_role_ids: [],
        can_manage_messages: userId === 'moderator',
        can_add_reactions: true,
      });
    });

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();
    await Message.init();

    app = buildApp();
    await app.listen({ port: 0 });
    port = (app.server.address() as { port: number }).port;
  });

  after(async () => {
    PubSubService.publish = origPublish;
    PubSubService.publishToInbox = origPublishInbox;
    EventConsumer.publishConfirmed = origRabbitPublish;
    globalThis.fetch = originalFetch;
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Message.deleteMany({});
    await Conversation.deleteMany({});
    members = ['alice', 'bob', 'carol'];
    coreDown = false;
    friends = true;
    published = [];
    inboxEvents = [];
    rabbitEvents = [];
    PubSubService.publish = async (ch: string, p: unknown) => {
      published.push({ channelId: ch, payload: p as Record<string, unknown> });
    };
    PubSubService.publishToInbox = async (userId: string, p: unknown) => {
      inboxEvents.push({ userId, payload: p as Record<string, unknown> });
    };
    rabbitConfirms = true;
    EventConsumer.publishConfirmed = async (routingKey: string, payload: Record<string, unknown>) => {
      rabbitEvents.push({ routingKey, payload });
      return rabbitConfirms;
    };
  });

  const reply = (channel: string, parentId: string, userId: string, payload: object = { content: 'respuesta' }) =>
    app.inject({
      method: 'POST',
      url: `/channels/${channel}/messages/${parentId}/thread`,
      headers: { 'x-user-id': userId },
      payload,
    });

  const getThread = (channel: string, parentId: string, query = '', userId = 'alice') =>
    app.inject({
      method: 'GET',
      url: `/channels/${channel}/messages/${parentId}/thread${query}`,
      headers: { 'x-user-id': userId },
    });

  /** El aviso a Notification sale después de responder: espera a que llegue (o a que no llegue). */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  const root = (authorId = 'alice', channel = channelId) =>
    Message.create({ content: 'tema', authorId, channelId: channel });

  async function createDm() {
    const conv = await Conversation.create({
      participantKey: 'alice:bob',
      participantIds: ['alice', 'bob'],
      status: 'accepted',
      requestedBy: 'alice',
      lastMessageAt: new Date(),
      lastMessagePreview: 'antes',
    });
    return { conv, dmChannelId: `dm-${conv._id.toString()}` };
  }

  describe('responder (CA1, CA2)', () => {
    it('guarda la respuesta asociada al raíz, actualiza el resumen y publica THREAD_REPLY_CREATED', async () => {
      const parent = await root();

      const res = await reply(channelId, parent.id, 'bob', { content: 'hola <@carol>' });

      assert.strictEqual(res.statusCode, 201);
      const saved = res.json();
      assert.strictEqual(saved.threadParentId, parent.id);
      assert.strictEqual(saved.channelId, channelId);

      const dbRoot = await Message.findById(parent._id).lean();
      assert.strictEqual(dbRoot?.thread?.replyCount, 1);
      assert.strictEqual(dbRoot?.thread?.lastReplyId.toString(), saved.id);
      assert.deepStrictEqual(dbRoot?.thread?.participantIds, ['alice', 'bob', 'carol']);

      assert.strictEqual(published.length, 1);
      const event = published[0].payload;
      assert.strictEqual(published[0].channelId, channelId);
      assert.strictEqual(event.type, 'THREAD_REPLY_CREATED');
      assert.strictEqual(event.parentId, parent.id);
      assert.strictEqual((event.reply as { id: string }).id, saved.id);
      assert.strictEqual((event.thread as { replyCount: number }).replyCount, 1);
      // Una respuesta de un canal no avisa por el inbox
      assert.strictEqual(inboxEvents.length, 0);
    });

    it('acepta respuestas sobre un raíz borrado: el hilo no se pierde', async () => {
      const parent = await root();
      await Message.updateOne({ _id: parent._id }, { isDeleted: true, content: '' });

      assert.strictEqual((await reply(channelId, parent.id, 'bob')).statusCode, 201);
      const page = (await getThread(channelId, parent.id)).json();
      assert.strictEqual(page.parent.isDeleted, true);
      assert.strictEqual(page.parent.thread.replyCount, 1);
    });

    it('cuenta bien respuestas simultáneas', async () => {
      const parent = await root();

      const results = await Promise.all(['bob', 'carol', 'bob', 'alice', 'carol'].map((u) => reply(channelId, parent.id, u)));

      assert.ok(results.every((r) => r.statusCode === 201));
      const dbRoot = await Message.findById(parent._id).lean();
      assert.strictEqual(dbRoot?.thread?.replyCount, 5);
      assert.deepStrictEqual([...(dbRoot?.thread?.participantIds ?? [])].sort(), ['alice', 'bob', 'carol']);
      const lastId = results.map((r) => r.json().id).sort().at(-1);
      assert.strictEqual(dbRoot?.thread?.lastReplyId.toString(), lastId);
    });

    it('al llegar al tope de participantes conserva los que ya estaban', async () => {
      const parent = await root();
      const full = Array.from({ length: MAX_THREAD_PARTICIPANTS }, (_, i) => `u${i}`);
      await Message.updateOne(
        { _id: parent._id },
        { thread: { replyCount: 1, lastReplyAt: new Date(), lastReplyId: new mongoose.Types.ObjectId(), participantIds: full } }
      );

      assert.strictEqual((await reply(channelId, parent.id, 'bob')).statusCode, 201);

      const dbRoot = await Message.findById(parent._id).lean();
      assert.deepStrictEqual(dbRoot?.thread?.participantIds, full);
      assert.strictEqual(dbRoot?.thread?.replyCount, 2);
    });

    it('trata un id mencionado que empieza con $ como texto', async () => {
      const parent = await root();
      assert.strictEqual((await reply(channelId, parent.id, 'bob', { content: 'ojo <@$thread.replyCount>' })).statusCode, 201);
      const dbRoot = await Message.findById(parent._id).lean();
      assert.ok(dbRoot?.thread?.participantIds.includes('$thread.replyCount'));
    });

    it('responde por el WebSocket del canal con threadParentId', async () => {
      const parent = await root();
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://localhost:${port}/channels/${channelId}/ws`, { headers: { 'x-user-id': 'bob' } });
        socket.on('open', () => resolve(socket));
        socket.on('error', reject);
      });
      ws.send(JSON.stringify({ content: 'por ws', threadParentId: parent.id }));
      await settle();
      ws.close();

      const replies = await Message.find({ threadParentId: parent._id }).lean();
      assert.strictEqual(replies.length, 1);
      assert.strictEqual(replies[0].content, 'por ws');
      assert.strictEqual(published[0].payload.type, 'THREAD_REPLY_CREATED');
    });

    it('el WebSocket rechaza un threadParentId que no es texto', async () => {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://localhost:${port}/channels/${channelId}/ws`, { headers: { 'x-user-id': 'bob' } });
        socket.on('open', () => resolve(socket));
        socket.on('error', reject);
      });
      const answer = new Promise<Record<string, unknown>>((resolve) =>
        ws.once('message', (data) => resolve(JSON.parse(data.toString())))
      );
      ws.send(JSON.stringify({ content: 'x', threadParentId: 42 }));
      const error = await answer;
      ws.close();
      assert.strictEqual(error.status, 400);
    });
  });

  describe('validaciones', () => {
    it('400 THREAD_NESTED al responder a una respuesta', async () => {
      const parent = await root();
      const first = (await reply(channelId, parent.id, 'bob')).json();

      const res = await reply(channelId, first.id, 'carol');

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.json().code, THREAD_NESTED);
    });

    it('400 sobre un mensaje del sistema', async () => {
      const system = await Message.create({ content: '', authorId: 'bob', channelId, systemEvent: 'member_join' });
      assert.strictEqual((await reply(channelId, system.id, 'carol')).statusCode, 400);
    });

    it('404 si el raíz es de otro canal, no existe o el id no es válido', async () => {
      const other = await root('alice', 'otro-canal');
      assert.strictEqual((await reply(channelId, other.id, 'bob')).statusCode, 404);
      assert.strictEqual((await reply(channelId, new mongoose.Types.ObjectId().toString(), 'bob')).statusCode, 404);
      assert.strictEqual((await reply(channelId, 'no-es-un-id', 'bob')).statusCode, 404);
      assert.strictEqual(await Message.countDocuments({ threadParentId: { $exists: true } }), 0);
    });

    it('403 sin permiso de escribir (o silenciado)', async () => {
      const parent = await root();
      const res = await reply(channelId, parent.id, 'readonly');
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(published.length, 0);
    });

    it('400 con contenido vacío', async () => {
      const parent = await root();
      assert.strictEqual((await reply(channelId, parent.id, 'bob', { content: '   ' })).statusCode, 400);
      assert.strictEqual((await Message.findById(parent._id).lean())?.thread, undefined);
    });

    it('400 con limit o after inválidos al leer', async () => {
      const parent = await root();
      for (const query of ['?limit=0', '?limit=101', '?limit=abc', '?after=xyz']) {
        assert.strictEqual((await getThread(channelId, parent.id, query)).statusCode, 400, query);
      }
    });

    it('no deja fijar una respuesta', async () => {
      const parent = await root();
      const saved = (await reply(channelId, parent.id, 'bob')).json();
      const res = await app.inject({
        method: 'PUT',
        url: `/channels/${channelId}/messages/${saved.id}/pin`,
        headers: { 'x-user-id': 'moderator' },
      });
      assert.strictEqual(res.statusCode, 400);
    });
  });

  describe('leer el hilo (CA3, CA4)', () => {
    it('devuelve el raíz y las respuestas de la más vieja a la más nueva, paginadas con after', async () => {
      const parent = await root();
      const ids: string[] = [];
      for (const text of ['uno', 'dos', 'tres']) {
        ids.push((await reply(channelId, parent.id, 'bob', { content: text })).json().id);
      }

      const first = (await getThread(channelId, parent.id, '?limit=2')).json();
      assert.strictEqual(first.parent.id, parent.id);
      assert.strictEqual(first.parent.thread.replyCount, 3);
      assert.deepStrictEqual(first.replies.map((r: { content: string }) => r.content), ['uno', 'dos']);
      assert.strictEqual(first.hasMore, true);
      assert.strictEqual(first.nextCursor, ids[1]);

      const second = (await getThread(channelId, parent.id, `?limit=2&after=${first.nextCursor}`)).json();
      assert.deepStrictEqual(second.replies.map((r: { content: string }) => r.content), ['tres']);
      assert.strictEqual(second.hasMore, false);
      assert.strictEqual(second.nextCursor, null);
    });

    it('las respuestas no aparecen en el historial ni en la reconexión del canal, y el raíz trae el resumen', async () => {
      const parent = await root();
      await reply(channelId, parent.id, 'bob');
      const after = await Message.create({ content: 'en el canal', authorId: 'carol', channelId });

      const history = (await app.inject({
        method: 'GET',
        url: `/channels/${channelId}/messages`,
        headers: { 'x-user-id': 'alice' },
      })).json().messages;
      assert.deepStrictEqual(history.map((m: { id: string }) => m.id), [parent.id, after.id]);
      assert.strictEqual(history[0].thread.replyCount, 1);

      const { ChatService } = await import('../src/services/ChatService');
      const missed = await ChatService.getMissedMessages(channelId, parent.id);
      assert.deepStrictEqual(missed.map((m) => m.id), [after.id]);
    });

    it('las respuestas no cuentan como no leídos del canal', async () => {
      const parent = await root();
      await reply(channelId, parent.id, 'bob');
      const unread = await ReadStateService.getConversationUnread('alice', [channelId]);
      assert.strictEqual(unread.get(channelId), 0);
    });

    it('404 al leer el hilo de un mensaje de otro canal', async () => {
      const other = await root('alice', 'otro-canal');
      assert.strictEqual((await getThread(channelId, other.id)).statusCode, 404);
    });
  });

  describe('borrar una respuesta', () => {
    it('resta del contador una sola vez y publica el raíz actualizado', async () => {
      const parent = await root();
      const saved = (await reply(channelId, parent.id, 'bob')).json();
      published = [];

      const del = () =>
        app.inject({ method: 'DELETE', url: `/channels/${channelId}/messages/${saved.id}`, headers: { 'x-user-id': 'bob' } });
      assert.strictEqual((await del()).statusCode, 200);
      assert.strictEqual((await del()).statusCode, 200);

      const dbRoot = await Message.findById(parent._id).lean();
      assert.strictEqual(dbRoot?.thread?.replyCount, 0);
      // Restó en el momento: no queda nada pendiente para el relay (D4)
      assert.strictEqual((await Message.findById(saved.id).lean())?.outbox, undefined);
      const updates = published.filter((p) => p.payload.id === parent.id);
      assert.strictEqual(updates[0].payload.type, 'MESSAGE_UPDATED');
      assert.strictEqual((updates[0].payload.thread as { replyCount: number }).replyCount, 0);
    });
  });

  describe('aviso a Notification (CA5)', () => {
    it('publica chat.message.created con los participantes menos el autor', async () => {
      const parent = await root();
      await reply(channelId, parent.id, 'bob', { content: 'primera' });
      await settle();
      rabbitEvents = [];

      await reply(channelId, parent.id, 'carol', { content: '  segunda\n\nlínea  <@bob>' });
      await settle();

      assert.strictEqual(rabbitEvents.length, 1);
      const { routingKey, payload } = rabbitEvents[0];
      assert.strictEqual(routingKey, 'chat.message.created');
      assert.strictEqual(payload.event_type, 'chat.message.created');
      assert.strictEqual(payload.server_id, serverId);
      assert.strictEqual(payload.thread_id, parent.id);
      assert.strictEqual(payload.author_id, 'carol');
      assert.strictEqual(payload.is_dm, false);
      assert.deepStrictEqual(payload.thread_participant_ids, ['alice', 'bob']);
      assert.deepStrictEqual(payload.mention_user_ids, ['bob']);
      assert.strictEqual(payload.preview, 'segunda línea <@bob>');
      assert.ok(typeof payload.event_id === 'string');
    });

    it('recorta el preview', async () => {
      const parent = await root();
      await reply(channelId, parent.id, 'bob', { content: 'x'.repeat(500) });
      await settle();
      assert.strictEqual((rabbitEvents[0].payload.preview as string).length, PREVIEW_MAX_LENGTH);
    });

    it('saca a quien ya no es miembro, y no publica si no queda nadie', async () => {
      const parent = await root();
      members = ['bob'];

      await reply(channelId, parent.id, 'bob');
      await settle();

      assert.strictEqual(rabbitEvents.length, 0);
    });

    it('no publica si el único participante es el autor', async () => {
      const parent = await root('bob');
      await reply(channelId, parent.id, 'bob');
      await settle();
      assert.strictEqual(rabbitEvents.length, 0);
    });

    it('si Core no responde, la respuesta se guarda igual y el aviso queda en el outbox para reintentar', async () => {
      const parent = await root();
      coreDown = true;

      const res = await reply(channelId, parent.id, 'bob');
      await settle();

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(rabbitEvents.length, 0);
      const saved = await Message.findById(res.json().id).lean();
      assert.ok(saved?.outbox?.eventId);
      assert.strictEqual(saved?.outbox?.attempts, 1);
      assert.strictEqual(saved?.outbox?.summaryPending, undefined);
    });

    it('publicado y confirmado, la respuesta queda sin outbox', async () => {
      const parent = await root();
      const res = await reply(channelId, parent.id, 'bob');
      await settle();
      assert.strictEqual((await Message.findById(res.json().id).lean())?.outbox, undefined);
    });
  });

  describe('DMs', () => {
    it('responde en un DM: canal, inbox de los dos y aviso sin servidor, sin tocar el resumen del DM', async () => {
      const { conv, dmChannelId } = await createDm();
      const parent = await Message.create({ content: 'en el dm', authorId: 'alice', channelId: dmChannelId });

      const res = await reply(dmChannelId, parent.id, 'bob');
      await settle();

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(published[0].payload.type, 'THREAD_REPLY_CREATED');
      assert.deepStrictEqual(inboxEvents.map((e) => e.userId).sort(), ['alice', 'bob']);
      assert.strictEqual(inboxEvents[0].payload.type, 'DM_THREAD_REPLY_CREATED');
      assert.strictEqual(inboxEvents[0].payload.conversationId, dmChannelId);

      assert.strictEqual(rabbitEvents.length, 1);
      assert.strictEqual(rabbitEvents[0].payload.server_id, null);
      assert.strictEqual(rabbitEvents[0].payload.is_dm, true);
      assert.deepStrictEqual(rabbitEvents[0].payload.thread_participant_ids, ['alice']);

      const dbConv = await Conversation.findById(conv._id).lean();
      assert.strictEqual(dbConv?.lastMessagePreview, 'antes');
    });

    it('403 DM_PENDING si la conversación no está aceptada', async () => {
      const { conv, dmChannelId } = await createDm();
      await Conversation.updateOne({ _id: conv._id }, { status: 'pending' });
      const parent = await Message.create({ content: 'hola', authorId: 'alice', channelId: dmChannelId });

      const res = await reply(dmChannelId, parent.id, 'bob');

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.json().code, 'DM_PENDING');
      assert.strictEqual(published.length, 0);
    });
  });
});
