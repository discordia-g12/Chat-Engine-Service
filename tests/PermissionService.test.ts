import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import { PermissionService } from '../src/services/PermissionService';

describe('PermissionService', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return true for a permitted user (200 OK)', async () => {
    mock.method(globalThis, 'fetch', async () => {
      return { status: 200 } as Response;
    });

    const result = await PermissionService.canSendMessage('valid-user', 'channel-1');
    assert.strictEqual(result, true);
  });

  it('should return false for an unauthorized user (403 Forbidden)', async () => {
    mock.method(globalThis, 'fetch', async () => {
      return { status: 403 } as Response;
    });

    const result = await PermissionService.canSendMessage('banned-user', 'channel-1');
    assert.strictEqual(result, false);
  });

  it('should throw an error if the channel does not exist (404 Not Found)', async () => {
    mock.method(globalThis, 'fetch', async () => {
      return { status: 404 } as Response;
    });

    await assert.rejects(
      PermissionService.canSendMessage('user-1', 'non-existent-channel'),
      { message: 'Channel not found' }
    );
  });

  it('should throw an error if Core service returns unexpected status (500)', async () => {
    mock.method(globalThis, 'fetch', async () => {
      return { status: 500 } as Response;
    });

    await assert.rejects(
      PermissionService.canSendMessage('user-1', 'channel-1'),
      { message: 'Failed to communicate with permission service' }
    );
  });

  it('should throw an error on network failure (e.g. ECONNREFUSED)', async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('fetch failed');
    });

    await assert.rejects(
      PermissionService.canSendMessage('user-1', 'channel-1'),
      { message: 'Failed to communicate with permission service' }
    );
  });

  it('should throw an error if userId is missing', async () => {
    await assert.rejects(
      PermissionService.canSendMessage('', 'channel-1'),
      { message: 'User ID and Channel ID are required to check permissions' }
    );
  });

  it('should throw an error if channelId is missing', async () => {
    await assert.rejects(
      PermissionService.canSendMessage('user-1', ''),
      { message: 'User ID and Channel ID are required to check permissions' }
    );
  });
});
