import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { Message } from '../src/models/Message';
import { PubSubService } from '../src/services/PubSubService';

describe('Edit Message (PATCH /channels/:channelId/messages/:messageId)', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let originalFetch: typeof globalThis.fetch;
  const channelId = 'channel-edit-test';

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
      const canSend = !urlStr.includes('muted-user');
      const canMentionEveryone = urlStr.includes('admin-user');
      return {
        status: 200,
        json: async () => ({
          server_id: 'srv-1',
          can_send: canSend,
          muted_until: null,
          can_mention_everyone: canMentionEveryone,
          mentionable_role_ids: ['role-mod'],
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
  });

  it('successfully edits own message and returns 200 with updated payload', async () => {
    const published: { channelId: string; payload: unknown }[] = [];
    const origPublish = PubSubService.publish;
    PubSubService.publish = async (ch: string, p: unknown) => {
      published.push({ channelId: ch, payload: p });
    };

    try {
      const msg = await Message.create({
        content: 'Original message',
        authorId: 'user-1',
        channelId,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/channels/${channelId}/messages/${msg._id.toString()}`,
        headers: {
          'x-user-id': 'user-1',
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          content: 'Edited message content',
        }),
      });

      assert.strictEqual(res.statusCode, 200);
      const data = res.json();
      assert.strictEqual(data.id, msg._id.toString());
      assert.strictEqual(data.content, 'Edited message content');
      assert.strictEqual(data.authorId, 'user-1');
      assert.strictEqual(data.edited, true);
      assert.ok(data.editedAt);
      assert.strictEqual(data.type, 'MESSAGE_UPDATED');

      // Verify PubSub publish
      assert.strictEqual(published.length, 1);
      assert.strictEqual(published[0].channelId, channelId);
      const pubPayload = published[0].payload as Record<string, unknown>;
      assert.strictEqual(pubPayload.id, msg._id.toString());
      assert.strictEqual(pubPayload.content, 'Edited message content');
      assert.strictEqual(pubPayload.type, 'MESSAGE_UPDATED');
      assert.strictEqual(pubPayload.edited, true);

      // Verify persistence in DB
      const dbMsg = await Message.findById(msg._id);
      assert.strictEqual(dbMsg?.content, 'Edited message content');
      assert.strictEqual(dbMsg?.edited, true);
      assert.ok(dbMsg?.editedAt);
    } finally {
      PubSubService.publish = origPublish;
    }
  });

  it('re-evaluates mentions when message is edited', async () => {
    const msg = await Message.create({
      content: 'Hello everyone without mention',
      authorId: 'admin-user',
      channelId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'admin-user',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: 'Attention @everyone and <@user-target> <@&role-mod>',
      }),
    });

    assert.strictEqual(res.statusCode, 200);
    const data = res.json();
    assert.deepStrictEqual(data.mentions, {
      users: ['user-target'],
      roles: ['role-mod'],
      everyone: true,
    });

    // Check DB
    const dbMsg = await Message.findById(msg._id);
    assert.deepStrictEqual(dbMsg?.mentionUserIds, ['user-target']);
    assert.deepStrictEqual(dbMsg?.mentionRoleIds, ['role-mod']);
    assert.strictEqual(dbMsg?.mentionEveryone, true);
  });

  it('rejects editing another user message with 403 Forbidden', async () => {
    const msg = await Message.create({
      content: 'User 1 message',
      authorId: 'user-1',
      channelId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'user-2',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: 'Malicious edit attempt',
      }),
    });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json().title, 'Forbidden');
    assert.strictEqual(res.json().detail, 'Only the author can edit this message');

    const unchanged = await Message.findById(msg._id);
    assert.strictEqual(unchanged?.content, 'User 1 message');
    assert.strictEqual(unchanged?.edited, false);
  });

  it('rejects editing when user is muted (canSend is false)', async () => {
    const msg = await Message.create({
      content: 'Muted user old message',
      authorId: 'muted-user',
      channelId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'muted-user',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: 'Trying to edit while muted',
      }),
    });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json().title, 'Forbidden');
    assert.strictEqual(res.json().detail, 'User does not have permission to edit messages in this channel');
  });

  it('returns 404 if message does not exist or invalid ObjectId', async () => {
    const nonExistentId = new mongoose.Types.ObjectId().toString();
    const res = await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/${nonExistentId}`,
      headers: {
        'x-user-id': 'user-1',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: 'Some edit',
      }),
    });

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.json().title, 'Not Found');

    const resInvalid = await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/not-valid-id`,
      headers: {
        'x-user-id': 'user-1',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: 'Some edit',
      }),
    });

    assert.strictEqual(resInvalid.statusCode, 404);
  });

  it('returns 404 if message belongs to another channel', async () => {
    const msg = await Message.create({
      content: 'Message in other channel',
      authorId: 'user-1',
      channelId: 'other-channel',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'user-1',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: 'Attempt to edit wrong channel',
      }),
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('rejects empty content when message has no attachments', async () => {
    const msg = await Message.create({
      content: 'Message without attachments',
      authorId: 'user-1',
      channelId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'user-1',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: '   ',
      }),
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().title, 'Bad Request');
  });

  it('allows empty content when message has attachments', async () => {
    const msg = await Message.create({
      content: 'Original with attachment',
      authorId: 'user-1',
      channelId,
      attachments: [
        {
          id: 'att-1',
          name: 'file.png',
          url: 'http://example.com/file.png',
          size: 100,
          contentType: 'image/png',
        },
      ],
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'user-1',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: '   ',
      }),
    });

    assert.strictEqual(res.statusCode, 200);
    const data = res.json();
    assert.strictEqual(data.content, '');
    assert.strictEqual(data.edited, true);
  });

  it('rejects content longer than 2000 characters', async () => {
    const msg = await Message.create({
      content: 'Short message',
      authorId: 'user-1',
      channelId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'user-1',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: 'a'.repeat(2001),
      }),
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().title, 'Bad Request');
  });

  it('rejects content with null byte', async () => {
    const msg = await Message.create({
      content: 'Valid content',
      authorId: 'user-1',
      channelId,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'user-1',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: 'Null \x00 byte',
      }),
    });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().title, 'Bad Request');
  });

  it('is reflected in history GET /channels/:channelId/messages', async () => {
    const msg = await Message.create({
      content: 'Message to be edited',
      authorId: 'user-1',
      channelId,
    });

    await app.inject({
      method: 'PATCH',
      url: `/channels/${channelId}/messages/${msg._id.toString()}`,
      headers: {
        'x-user-id': 'user-1',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        content: 'Now this is edited',
      }),
    });

    const historyRes = await app.inject({
      method: 'GET',
      url: `/channels/${channelId}/messages`,
      headers: {
        'x-user-id': 'user-1',
      },
    });

    assert.strictEqual(historyRes.statusCode, 200);
    const messages = historyRes.json().messages;
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].id, msg._id.toString());
    assert.strictEqual(messages[0].content, 'Now this is edited');
    assert.strictEqual(messages[0].edited, true);
    assert.ok(messages[0].editedAt);
  });
});
