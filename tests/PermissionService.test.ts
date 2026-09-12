import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PermissionService } from '../src/services/PermissionService';

describe('PermissionService', () => {
  it('should allow a normal user to send messages', async () => {
    const result = await PermissionService.canSendMessage('user-123', 'channel-456');
    assert.strictEqual(result, true);
  });

  it('should deny permission for a banned user', async () => {
    const result = await PermissionService.canSendMessage('banned-user', 'channel-456');
    assert.strictEqual(result, false);
  });

  it('should throw an error if userId is missing', async () => {
    await assert.rejects(
      async () => {
        await PermissionService.canSendMessage('', 'channel-456');
      },
      /User ID and Channel ID are required/
    );
  });

  it('should throw an error if channelId is missing', async () => {
    await assert.rejects(
      async () => {
        await PermissionService.canSendMessage('user-123', '');
      },
      /User ID and Channel ID are required/
    );
  });
});
