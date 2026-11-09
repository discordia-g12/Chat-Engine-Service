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
import { ChatService } from '../src/services/ChatService';

describe('Delete Message (DELETE /channels/:channelId/messages/:messageId)', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let originalFetch: typeof globalThis.fetch;
  const channelId = 'channel-delete-test';

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('not-found-channel')) {
        return { status: 404 } as Response;
      }
      if (urlStr.includes('banned-user')) {
        return { status: 403 } as Response;
      }
      // Canonical auth check for DMs
      if (urlStr.includes('/internal/users/')) {
        const userId = urlStr.split('/internal/users/')[1].split('/')[0];
        return {
          status: 200,
          json: async () => ({
            user_id: userId,
            suspended: false,
          }),
        } as Response;
      }
      const canManageMessages = urlStr.includes('moderator-user') || urlStr.includes('admin-user');
      return {
        status: 200,
        json: async () => ({
          server_id: 'srv-1',
          can_send: true,
          muted_until: null,
          can_mention_everyone: false,
          mentionable_role_ids: [],
          can_manage_messages: canManageMessages,
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
    globalThis.fetch = originalFetch;
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Message.deleteMany({});
    await Conversation.deleteMany({});
  });

  it('allows author to soft-delete own message in server channel', async () => {
    const published: { channelId: string; payload: unknown }[] = [];
    const origPublish = PubSubService.publish;
    PubSubService.publish = async (ch: string, p: unknown) => {
      published.push({ channelId: ch, payload: p });
    };

    try {
      const msg = await Message.create({
        content: 'Original message to delete',
        authorId: 'user-author',
        channelId,
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/channels/${channelId}/messages/${msg._id.toString()}`,
        headers: {
          'x-user-id': 'user-author',
        },
      });

      assert.strictEqual(res.statusCode, 200);
      const data = res.json();
      assert.strictEqual(data.id, msg._id.toString());
      assert.strictEqual(data.content, '');
      assert.strictEqual(data.isDeleted, true);
      assert.strictEqual(data.type, 'MESSAGE_DELETED');

      // Verify PubSub publish
      assert.strictEqual(published.length, 1);
      assert.strictEqual(published[0].channelId, channelId);
      const pubPayload = published[0].payload as Record<string, unknown>;
      assert.strictEqual(pubPayload.id, msg._id.toString());
      assert.strictEqual(pubPayload.type, 'MESSAGE_DELETED');
      assert.strictEqual(pubPayload.isDeleted, true);

      // Verify DB persistence
      const dbMsg = await Message.findById(msg._id);
      assert.strictEqual(dbMsg?.isDeleted, true);
      assert.strictEqual(dbMsg?.content, '');
      assert.strictEqual(dbMsg?.attachments?.length ?? 0, 0);

      // History should return message with type: 'deleted'
      const history = await ChatService.getHistory(channelId);
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].id, msg._id.toString());
      assert.strictEqual(history[0].type, 'deleted');
      assert.strictEqual(history[0].content, '');
    } finally {
      PubSubService.publish = origPublish;
    }
  });

  it('allows moderator with can_manage_messages to delete another user message', async () => {
    const msg = await Message.create({
      content: 'User message violating rules',
      authorId: 'regular-user',
      channelId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'moderator-user',
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const data = res.json();
    assert.strictEqual(data.id, msg._id.toString());
    assert.strictEqual(data.isDeleted, true);

    const dbMsg = await Message.findById(msg._id);
    assert.strictEqual(dbMsg?.isDeleted, true);
  });

  it('rejects deletion by non-author without moderation permission with 403 Forbidden', async () => {
    const msg = await Message.create({
      content: 'Private user message',
      authorId: 'user-1',
      channelId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'user-2',
      },
    });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json().title, 'Forbidden');
    assert.strictEqual(res.json().detail, 'You do not have permission to delete this message');

    const dbMsg = await Message.findById(msg._id);
    assert.strictEqual(dbMsg?.isDeleted, false);
    assert.strictEqual(dbMsg?.content, 'Private user message');
  });

  it('handles DM message deletion and updates conversation preview if it was the last message', async () => {
    const conv = await Conversation.create({
      participantKey: 'alice:bob',
      participantIds: ['alice', 'bob'],
      status: 'accepted',
      requestedBy: 'alice',
      lastMessageAt: new Date(),
      lastMessagePreview: 'Last DM message',
    });
    const dmChannelId = `dm-${conv._id.toString()}`;

    const msg = await Message.create({
      content: 'Last DM message',
      authorId: 'alice',
      channelId: dmChannelId,
    });

    conv.lastMessageId = msg._id;
    await conv.save();

    const inboxEvents: { userId: string; payload: unknown }[] = [];
    const origPublishInbox = PubSubService.publishToInbox;
    PubSubService.publishToInbox = async (userId: string, p: unknown) => {
      inboxEvents.push({ userId, payload: p });
    };

    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/channels/${dmChannelId}/messages/${msg._id.toString()}`,
        headers: {
          'x-user-id': 'alice',
        },
      });

      assert.strictEqual(res.statusCode, 200);

      // Verify conversation preview was updated
      const updatedConv = await Conversation.findById(conv._id);
      assert.strictEqual(updatedConv?.lastMessagePreview, '/ este mensaje fue eliminado');

      // Verify inbox events were sent to both participants
      assert.strictEqual(inboxEvents.length, 2);
      assert.ok(inboxEvents.some((e) => e.userId === 'alice'));
      assert.ok(inboxEvents.some((e) => e.userId === 'bob'));
      const ev = inboxEvents[0].payload as Record<string, unknown>;
      assert.strictEqual(ev.type, 'DM_MESSAGE_DELETED');
      assert.strictEqual(ev.conversationId, dmChannelId);
    } finally {
      PubSubService.publishToInbox = origPublishInbox;
    }
  });

  it('rejects DM message deletion by another participant with 403 Forbidden', async () => {
    const conv = await Conversation.create({
      participantKey: 'alice:bob',
      participantIds: ['alice', 'bob'],
      status: 'accepted',
      requestedBy: 'alice',
      lastMessageAt: new Date(),
    });
    const dmChannelId = `dm-${conv._id.toString()}`;

    const msg = await Message.create({
      content: 'Alice message',
      authorId: 'alice',
      channelId: dmChannelId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/channels/${dmChannelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'bob',
      },
    });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json().title, 'Forbidden');
    assert.strictEqual(res.json().detail, 'Only the author can delete this message');
  });

  it('returns 404 for non-existent message or invalid ID', async () => {
    const validFakeId = new mongoose.Types.ObjectId().toString();
    const res404 = await app.inject({
      method: 'DELETE',
      url: `/channels/${channelId}/messages/${validFakeId}`,
      headers: { 'x-user-id': 'user-1' },
    });
    assert.strictEqual(res404.statusCode, 404);

    const resInvalid = await app.inject({
      method: 'DELETE',
      url: `/channels/${channelId}/messages/invalid-id`,
      headers: { 'x-user-id': 'user-1' },
    });
    assert.strictEqual(resInvalid.statusCode, 404);
  });

  it('rejects editing a deleted message with ValidationError', async () => {
    const msg = await Message.create({
      content: '',
      authorId: 'alice',
      channelId,
      isDeleted: true,
      deletedAt: new Date(),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'alice',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: 'Trying to resurrect message',
      }),
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().detail, 'Cannot edit a deleted message');
  });
});
