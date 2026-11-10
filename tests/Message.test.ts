import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Message } from '../src/models/Message';

describe('Message Model Validations', () => {
  it('should validate a correct message successfully', async () => {
    const msg = new Message({
      content: 'Hello, this is a valid message',
      authorId: 'user-123',
      channelId: 'channel-456'
    });
    await assert.doesNotReject(async () => {
      await msg.validate();
    });
  });

  it('should fail validation if content is missing', async () => {
    const msg = new Message({
      authorId: 'user-123',
      channelId: 'channel-456'
    });
    try {
      await msg.validate();
      assert.fail('Should have failed');
    } catch (err) {
      const error = err as { errors: Record<string, { message: string }> };
      assert.ok(error.errors['content']);
      assert.strictEqual(error.errors['content'].message, 'Content is required');
    }
  });

  it('should fail validation if content is empty or just spaces (CA 2)', async () => {
    const msg = new Message({
      content: '    ',
      authorId: 'user-123',
      channelId: 'channel-456'
    });
    try {
      await msg.validate();
      assert.fail('Should have failed');
    } catch (err) {
      const error = err as { errors: Record<string, { message: string }> };
      assert.ok(error.errors['content']);
      assert.match(error.errors['content'].message, /Content is required|cannot be empty/);
    }
  });

  it('should fail validation if content exceeds 2000 characters (CA 4)', async () => {
    const msg = new Message({
      content: 'a'.repeat(2001),
      authorId: 'user-123',
      channelId: 'channel-456'
    });
    try {
      await msg.validate();
      assert.fail('Should have failed');
    } catch (err) {
      const error = err as { errors: Record<string, { message: string }> };
      assert.ok(error.errors['content']);
      assert.match(error.errors['content'].message, /exceeds maximum length/);
    }
  });

  it('should fail validation if content contains null characters', async () => {
    const msg = new Message({
      content: 'Hello\x00World',
      authorId: 'user-123',
      channelId: 'channel-456'
    });
    try {
      await msg.validate();
      assert.fail('Should have failed');
    } catch (err) {
      const error = err as { errors: Record<string, { message: string }> };
      assert.ok(error.errors['content']);
      assert.match(error.errors['content'].message, /null characters/);
    }
  });

  it('should fail validation if authorId is missing', async () => {
    const msg = new Message({
      content: 'Test message',
      channelId: 'channel-456'
    });
    try {
      await msg.validate();
      assert.fail('Should have failed');
    } catch (err) {
      const error = err as { errors: Record<string, { message: string }> };
      assert.ok(error.errors['authorId']);
    }
  });

  it('should fail validation if channelId is missing', async () => {
    const msg = new Message({
      content: 'Test message',
      authorId: 'user-123'
    });
    try {
      await msg.validate();
      assert.fail('Should have failed');
    } catch (err) {
      const error = err as { errors: Record<string, { message: string }> };
      assert.ok(error.errors['channelId']);
    }
  });

  it('should ignore extra fields not defined in the schema', async () => {
    const msg = new Message({
      content: 'Test message',
      authorId: 'user-123',
      channelId: 'channel-456',
      hack: 'DROP DATABASE'
    } as unknown as import("../src/models/Message").IMessage);
    
    await assert.doesNotReject(async () => {
      await msg.validate();
    });
    
    const obj = msg.toObject();
    assert.strictEqual(obj.hack, undefined);
  });

  it('should validate message with attachments and empty content successfully', async () => {
    const msg = new Message({
      content: '',
      authorId: 'user-123',
      channelId: 'channel-456',
      attachments: [{
        id: 'att-1',
        name: 'photo.png',
        url: 'https://example.com/photo.png',
        size: 1024,
        contentType: 'image/png'
      }]
    });
    await assert.doesNotReject(async () => {
      await msg.validate();
    });
  });

  it('should validate message with attachments and content successfully', async () => {
    const msg = new Message({
      content: 'Here is the file',
      authorId: 'user-123',
      channelId: 'channel-456',
      attachments: [{
        id: 'att-2',
        name: 'doc.pdf',
        url: 'https://example.com/doc.pdf',
        size: 2048,
        contentType: 'application/pdf'
      }]
    });
    await assert.doesNotReject(async () => {
      await msg.validate();
    });
  });

  it('should support edited and editedAt fields', async () => {
    const now = new Date();
    const msg = new Message({
      content: 'Edited content',
      authorId: 'user-123',
      channelId: 'channel-456',
      edited: true,
      editedAt: now
    });
    await assert.doesNotReject(async () => {
      await msg.validate();
    });
    assert.strictEqual(msg.edited, true);
    assert.strictEqual(msg.editedAt, now);
  });
});
