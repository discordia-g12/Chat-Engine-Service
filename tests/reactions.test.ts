import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { Message } from '../src/models/Message';
import { Conversation } from '../src/models/Conversation';
import { PubSubService } from '../src/services/PubSubService';
import { ChatService } from '../src/services/ChatService';

describe('Message Reactions (PUT /channels/:channelId/messages/:messageId/reactions)', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let originalFetch: typeof globalThis.fetch;
  const channelId = 'channel-reaction-test';

  before(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request) => {
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
      const cannotAddReactions = urlStr.includes('no-react-user');
      return {
        status: 200,
        json: async () => ({
          server_id: 'srv-1',
          can_send: true,
          muted_until: null,
          can_mention_everyone: false,
          mentionable_role_ids: [],
          can_manage_messages: false,
          can_add_reactions: !cannotAddReactions,
        }),
      } as Response;
    };

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

  it('allows user with ADD_REACTIONS to add a reaction to a message (CA 1)', async () => {
    const msg = await Message.create({
      content: 'Hello everyone!',
      authorId: 'author-1',
      channelId,
    });

    const published: Array<{ channelId: string; payload: unknown }> = [];
    const origPublish = PubSubService.publish;
    PubSubService.publish = async (chId, payload) => {
      published.push({ channelId: chId, payload });
    };

    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/channels/${channelId}/messages/${msg._id.toString()}/reactions`,
        headers: { 'x-user-id': 'user-1' },
        payload: { emoji: '👍' },
      });

      assert.strictEqual(res.statusCode, 200);
      const data = res.json();
      assert.strictEqual(data.id, msg._id.toString());
      assert.strictEqual(data.type, 'MESSAGE_REACTION_UPDATED');
      assert.strictEqual(data.reactions.length, 1);
      assert.strictEqual(data.reactions[0].emoji, '👍');
      assert.strictEqual(data.reactions[0].count, 1);
      assert.deepStrictEqual(data.reactions[0].users, ['user-1']);

      // PubSub event
      assert.strictEqual(published.length, 1);
      assert.strictEqual(published[0].channelId, channelId);
      const pubPayload = published[0].payload as Record<string, unknown>;
      assert.strictEqual(pubPayload.type, 'MESSAGE_REACTION_UPDATED');

      // Database persistence
      const dbMsg = await Message.findById(msg._id);
      assert.strictEqual(dbMsg?.reactions?.length, 1);
      assert.strictEqual(dbMsg?.reactions?.[0]?.emoji, '👍');
      assert.strictEqual(dbMsg?.reactions?.[0]?.count, 1);

      // History returns reactions
      const history = await ChatService.getHistory(channelId);
      assert.strictEqual(history[0].reactions?.length, 1);
      assert.strictEqual(history[0].reactions?.[0]?.count, 1);
    } finally {
      PubSubService.publish = origPublish;
    }
  });

  it('allows another user to add the same reaction, incrementing count (CA 1)', async () => {
    const msg = await Message.create({
      content: 'Awesome update',
      authorId: 'author-1',
      channelId,
      reactions: [{ emoji: '🔥', count: 1, users: ['user-1'] }],
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/${msg._id.toString()}/reactions`,
      headers: { 'x-user-id': 'user-2' },
      payload: { emoji: '🔥' },
    });

    assert.strictEqual(res.statusCode, 200);
    const data = res.json();
    assert.strictEqual(data.reactions.length, 1);
    assert.strictEqual(data.reactions[0].emoji, '🔥');
    assert.strictEqual(data.reactions[0].count, 2);
    assert.deepStrictEqual(data.reactions[0].users, ['user-1', 'user-2']);
  });

  it('allows adding a different emoji reaction to the same message', async () => {
    const msg = await Message.create({
      content: 'Multiple emojis',
      authorId: 'author-1',
      channelId,
      reactions: [{ emoji: '👍', count: 1, users: ['user-1'] }],
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/${msg._id.toString()}/reactions`,
      headers: { 'x-user-id': 'user-2' },
      payload: { emoji: '❤️' },
    });

    assert.strictEqual(res.statusCode, 200);
    const data = res.json();
    assert.strictEqual(data.reactions.length, 2);
    assert.strictEqual(data.reactions[0].emoji, '👍');
    assert.strictEqual(data.reactions[1].emoji, '❤️');
    assert.strictEqual(data.reactions[1].count, 1);
  });

  it('removes user reaction when selecting the same emoji again (CA 2 - toggle)', async () => {
    const msg = await Message.create({
      content: 'Toggle reaction',
      authorId: 'author-1',
      channelId,
      reactions: [{ emoji: '🎉', count: 2, users: ['user-1', 'user-2'] }],
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/${msg._id.toString()}/reactions`,
      headers: { 'x-user-id': 'user-1' },
      payload: { emoji: '🎉' },
    });

    assert.strictEqual(res.statusCode, 200);
    const data = res.json();
    assert.strictEqual(data.reactions.length, 1);
    assert.strictEqual(data.reactions[0].count, 1);
    assert.deepStrictEqual(data.reactions[0].users, ['user-2']);
  });

  it('removes emoji completely when last user removes their reaction (CA 2)', async () => {
    const msg = await Message.create({
      content: 'Last reaction removed',
      authorId: 'author-1',
      channelId,
      reactions: [{ emoji: '🚀', count: 1, users: ['user-1'] }],
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/${msg._id.toString()}/reactions`,
      headers: { 'x-user-id': 'user-1' },
      payload: { emoji: '🚀' },
    });

    assert.strictEqual(res.statusCode, 200);
    const data = res.json();
    assert.strictEqual(data.reactions.length, 0);

    const dbMsg = await Message.findById(msg._id);
    assert.strictEqual(dbMsg?.reactions?.length ?? 0, 0);
  });

  it('rejects adding reaction when user lacks ADD_REACTIONS with 403 Forbidden (CA 3)', async () => {
    const msg = await Message.create({
      content: 'Restricted channel',
      authorId: 'author-1',
      channelId,
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/${msg._id.toString()}/reactions`,
      headers: { 'x-user-id': 'no-react-user' },
      payload: { emoji: '👍' },
    });

    assert.strictEqual(res.statusCode, 403);
    const data = res.json();
    assert.strictEqual(data.status, 403);
    assert.strictEqual(data.detail, 'User does not have permission to add reactions in this channel');

    // Message reactions should remain empty
    const dbMsg = await Message.findById(msg._id);
    assert.strictEqual(dbMsg?.reactions?.length ?? 0, 0);
  });

  it('allows user without ADD_REACTIONS to remove their preexisting reaction', async () => {
    const msg = await Message.create({
      content: 'User lost permissions later',
      authorId: 'author-1',
      channelId,
      reactions: [{ emoji: '👍', count: 1, users: ['no-react-user'] }],
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/${msg._id.toString()}/reactions`,
      headers: { 'x-user-id': 'no-react-user' },
      payload: { emoji: '👍' },
    });

    assert.strictEqual(res.statusCode, 200);
    const data = res.json();
    assert.strictEqual(data.reactions.length, 0);
  });

  it('allows reacting and removing reactions in DM conversations', async () => {
    const conv = await Conversation.create({
      participantKey: 'dm-user-1:dm-user-2',
      participantIds: ['dm-user-1', 'dm-user-2'],
      status: 'accepted',
      requestedBy: 'dm-user-1',
      lastMessagePreview: 'Hello DM',
      lastMessageAt: new Date(),
    });
    const dmChannelId = `dm-${conv._id.toString()}`;

    const msg = await Message.create({
      content: 'Private message',
      authorId: 'dm-user-1',
      channelId: dmChannelId,
    });

    const inboxEvents: Array<{ userId: string; event: unknown }> = [];
    const origPublishToInbox = PubSubService.publishToInbox;
    PubSubService.publishToInbox = async (uId, event) => {
      inboxEvents.push({ userId: uId, event });
    };

    try {
      // Add reaction in DM
      const res1 = await app.inject({
        method: 'PUT',
        url: `/channels/${dmChannelId}/messages/${msg._id.toString()}/reactions`,
        headers: { 'x-user-id': 'dm-user-2' },
        payload: { emoji: '❤️' },
      });

      assert.strictEqual(res1.statusCode, 200);
      assert.strictEqual(res1.json().reactions.length, 1);
      assert.strictEqual(inboxEvents.length, 2);
      assert.strictEqual((inboxEvents[0].event as Record<string, unknown>).type, 'DM_MESSAGE_REACTION_UPDATED');

      // Toggle off in DM
      const res2 = await app.inject({
        method: 'PUT',
        url: `/channels/${dmChannelId}/messages/${msg._id.toString()}/reactions`,
        headers: { 'x-user-id': 'dm-user-2' },
        payload: { emoji: '❤️' },
      });

      assert.strictEqual(res2.statusCode, 200);
      assert.strictEqual(res2.json().reactions.length, 0);
    } finally {
      PubSubService.publishToInbox = origPublishToInbox;
    }
  });

  it('rejects reaction on deleted message with 400 Bad Request', async () => {
    const msg = await Message.create({
      content: '',
      authorId: 'author-1',
      channelId,
      isDeleted: true,
      deletedAt: new Date(),
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/${msg._id.toString()}/reactions`,
      headers: { 'x-user-id': 'user-1' },
      payload: { emoji: '👍' },
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().detail, 'Cannot react to a deleted message');
  });

  it('rejects invalid or empty emoji with 400 Bad Request', async () => {
    const msg = await Message.create({
      content: 'Empty emoji test',
      authorId: 'author-1',
      channelId,
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/${msg._id.toString()}/reactions`,
      headers: { 'x-user-id': 'user-1' },
      payload: { emoji: '   ' },
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().detail, 'Emoji is required');
  });

  it('returns 404 for non-existent message or invalid ID', async () => {
    const res1 = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/6af106b847e5fde5b57dc999/reactions`,
      headers: { 'x-user-id': 'user-1' },
      payload: { emoji: '👍' },
    });
    assert.strictEqual(res1.statusCode, 404);

    const res2 = await app.inject({
      method: 'PUT',
      url: `/channels/${channelId}/messages/invalid-id/reactions`,
      headers: { 'x-user-id': 'user-1' },
      payload: { emoji: '👍' },
    });
    assert.strictEqual(res2.statusCode, 404);
  });
});
