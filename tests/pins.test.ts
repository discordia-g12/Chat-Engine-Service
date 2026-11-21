import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { Message } from '../src/models/Message';
import { Conversation } from '../src/models/Conversation';
import { PubSubService } from '../src/services/PubSubService';
import { PINNED_LIMIT } from '../src/services/ChatService';

describe('Pinned messages (PUT|DELETE /channels/:channelId/messages/:messageId/pin, GET /channels/:channelId/pins)', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let originalFetch: typeof globalThis.fetch;
  const channelId = 'channel-pins-test';

  // Captura lo publicado al canal y a los inboxes durante cada test.
  let published: { channelId: string; payload: Record<string, unknown> }[];
  let inboxEvents: { userId: string; payload: Record<string, unknown> }[];
  const origPublish = PubSubService.publish;
  const origPublishInbox = PubSubService.publishToInbox;

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/internal/users/')) {
        const userId = urlStr.split('/internal/users/')[1].split('/')[0];
        return { status: 200, json: async () => ({ user_id: userId, suspended: false }) } as Response;
      }
      return {
        status: 200,
        json: async () => ({
          server_id: 'srv-1',
          can_send: true,
          muted_until: null,
          can_mention_everyone: false,
          mentionable_role_ids: [],
          can_manage_messages: urlStr.includes('moderator'),
          can_add_reactions: true,
        }),
      } as Response;
    });

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();

    app = buildApp();
    await app.listen({ port: 0 });
  });

  after(async () => {
    PubSubService.publish = origPublish;
    PubSubService.publishToInbox = origPublishInbox;
    globalThis.fetch = originalFetch;
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Message.deleteMany({});
    await Conversation.deleteMany({});
    published = [];
    inboxEvents = [];
    PubSubService.publish = async (ch: string, p: unknown) => {
      published.push({ channelId: ch, payload: p as Record<string, unknown> });
    };
    PubSubService.publishToInbox = async (userId: string, p: unknown) => {
      inboxEvents.push({ userId, payload: p as Record<string, unknown> });
    };
  });

  const pin = (method: 'PUT' | 'DELETE', channel: string, messageId: string, userId: string) =>
    app.inject({
      method,
      url: `/channels/${channel}/messages/${messageId}/pin`,
      headers: { 'x-user-id': userId },
    });

  async function createDm() {
    const conv = await Conversation.create({
      participantKey: 'alice:bob',
      participantIds: ['alice', 'bob'],
      status: 'accepted',
      requestedBy: 'alice',
      lastMessageAt: new Date(),
    });
    return `dm-${conv._id.toString()}`;
  }

  it('pins and unpins a server channel message with MANAGE_MESSAGES and publishes MESSAGE_UPDATED', async () => {
    const msg = await Message.create({ content: 'importante', authorId: 'user-author', channelId });
    const id = msg._id.toString();

    const resPin = await pin('PUT', channelId, id, 'moderator');
    assert.strictEqual(resPin.statusCode, 200);
    const pinned = resPin.json();
    assert.strictEqual(pinned.pinned, true);
    assert.strictEqual(pinned.pinnedBy, 'moderator');
    assert.ok(pinned.pinnedAt);
    assert.strictEqual(pinned.type, 'MESSAGE_UPDATED');
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].channelId, channelId);
    assert.strictEqual(published[0].payload.pinned, true);

    const resUnpin = await pin('DELETE', channelId, id, 'moderator');
    assert.strictEqual(resUnpin.statusCode, 200);
    assert.strictEqual(resUnpin.json().pinned, false);
    assert.strictEqual(resUnpin.json().pinnedAt, undefined);
    assert.strictEqual(published.length, 2);
    assert.strictEqual(published[1].payload.pinned, false);

    const dbMsg = await Message.findById(id);
    assert.strictEqual(dbMsg?.pinned, false);
    assert.strictEqual(dbMsg?.pinnedAt, null);
    assert.strictEqual(dbMsg?.pinnedBy, null);
    assert.strictEqual(inboxEvents.length, 0);
  });

  it('rejects pinning in a server channel without MANAGE_MESSAGES, even for the author', async () => {
    const msg = await Message.create({ content: 'mío', authorId: 'user-author', channelId });

    const res = await pin('PUT', channelId, msg._id.toString(), 'user-author');

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json().detail, 'You do not have permission to pin messages in this channel');
    assert.strictEqual((await Message.findById(msg._id))?.pinned, false);
    assert.strictEqual(published.length, 0);
  });

  it('lets any DM participant pin and unpin, notifying both inboxes', async () => {
    const dmChannelId = await createDm();
    const msg = await Message.create({ content: 'de alice', authorId: 'alice', channelId: dmChannelId });
    const id = msg._id.toString();

    const resPin = await pin('PUT', dmChannelId, id, 'bob');
    assert.strictEqual(resPin.statusCode, 200);
    assert.strictEqual(resPin.json().pinned, true);
    assert.strictEqual(resPin.json().pinnedBy, 'bob');
    assert.strictEqual(published.length, 1);
    assert.strictEqual(inboxEvents.length, 2);
    assert.deepStrictEqual(inboxEvents.map((e) => e.userId).sort(), ['alice', 'bob']);
    assert.strictEqual(inboxEvents[0].payload.type, 'DM_MESSAGE_UPDATED');
    assert.strictEqual(inboxEvents[0].payload.conversationId, dmChannelId);

    const resUnpin = await pin('DELETE', dmChannelId, id, 'alice');
    assert.strictEqual(resUnpin.statusCode, 200);
    assert.strictEqual(resUnpin.json().pinned, false);
    assert.strictEqual(inboxEvents.length, 4);
  });

  it('rejects pinning in a DM by a non participant', async () => {
    const dmChannelId = await createDm();
    const msg = await Message.create({ content: 'privado', authorId: 'alice', channelId: dmChannelId });

    const res = await pin('PUT', dmChannelId, msg._id.toString(), 'mallory');

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual((await Message.findById(msg._id))?.pinned, false);
  });

  it('returns 404 for a deleted, missing or invalid message', async () => {
    const deleted = await Message.create({ content: '', authorId: 'a', channelId, isDeleted: true });
    const missing = new mongoose.Types.ObjectId().toString();

    for (const id of [deleted._id.toString(), missing, 'not-an-id']) {
      const res = await pin('PUT', channelId, id, 'moderator');
      assert.strictEqual(res.statusCode, 404, `id ${id}`);
    }
  });

  it('is idempotent: pinning twice does not publish twice', async () => {
    const msg = await Message.create({ content: 'otra vez', authorId: 'a', channelId });
    const id = msg._id.toString();

    await pin('PUT', channelId, id, 'moderator');
    const pinnedAt = (await Message.findById(id))?.pinnedAt;
    const res = await pin('PUT', channelId, id, 'moderator');

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().pinned, true);
    assert.strictEqual(published.length, 1);
    assert.deepStrictEqual((await Message.findById(id))?.pinnedAt, pinnedAt);

    const resUnpinNotPinned = await pin('DELETE', channelId, (await Message.create({ content: 'x', authorId: 'a', channelId }))._id.toString(), 'moderator');
    assert.strictEqual(resUnpinNotPinned.statusCode, 200);
    assert.strictEqual(published.length, 1);
  });

  it(`returns 409 when the channel already has ${PINNED_LIMIT} pinned messages`, async () => {
    await Message.insertMany(
      Array.from({ length: PINNED_LIMIT }, (_, i) => ({
        content: `fijado ${i}`,
        authorId: 'a',
        channelId,
        pinned: true,
        pinnedAt: new Date(),
        pinnedBy: 'moderator',
      }))
    );
    const extra = await Message.create({ content: 'uno más', authorId: 'a', channelId });

    const res = await pin('PUT', channelId, extra._id.toString(), 'moderator');

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual((await Message.findById(extra._id))?.pinned, false);
    // El límite es por canal: otro canal sigue pudiendo fijar.
    const other = await Message.create({ content: 'otro canal', authorId: 'a', channelId: 'other-channel' });
    assert.strictEqual((await pin('PUT', 'other-channel', other._id.toString(), 'moderator')).statusCode, 200);
  });

  it('lists pinned messages of the channel, newest pin first, without deleted ones', async () => {
    const now = Date.now();
    const [older, newer] = await Message.insertMany([
      { content: 'viejo', authorId: 'a', channelId, pinned: true, pinnedAt: new Date(now - 10_000), pinnedBy: 'm' },
      { content: 'nuevo', authorId: 'a', channelId, pinned: true, pinnedAt: new Date(now), pinnedBy: 'm' },
      { content: 'sin fijar', authorId: 'a', channelId },
      { content: '', authorId: 'a', channelId, pinned: true, pinnedAt: new Date(now), isDeleted: true },
      { content: 'otro canal', authorId: 'a', channelId: 'other-channel', pinned: true, pinnedAt: new Date(now) },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/pins`,
      headers: { 'x-user-id': 'user-reader' },
    });

    assert.strictEqual(res.statusCode, 200);
    const list = res.json() as { id: string; pinned: boolean }[];
    assert.deepStrictEqual(list.map((m) => m.id), [newer._id.toString(), older._id.toString()]);
    assert.ok(list.every((m) => m.pinned));
  });

  it('unpins a message when it gets deleted', async () => {
    const msg = await Message.create({
      content: 'a borrar',
      authorId: 'user-author',
      channelId,
      pinned: true,
      pinnedAt: new Date(),
      pinnedBy: 'moderator',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: { 'x-user-id': 'user-author' },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().pinned, false);
    const dbMsg = await Message.findById(msg._id);
    assert.strictEqual(dbMsg?.pinned, false);
    assert.strictEqual(dbMsg?.pinnedAt, null);
  });
});
