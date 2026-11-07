import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import { PermissionService } from '../src/services/PermissionService';

const ok = (body: unknown) => ({ status: 200, json: async () => body }) as Response;

describe('PermissionService', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls /access with the channel and user', async () => {
    let calledUrl = '';
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      calledUrl = url.toString();
      return ok({ server_id: 'srv-1', can_send: true, muted_until: null });
    });

    await PermissionService.getChannelAccess('user 1', 'channel-1');
    assert.match(calledUrl, /\/internal\/channels\/channel-1\/access\?user_id=user\+1$/);
  });

  it('allows a user who can view and send (200, can_send true)', async () => {
    mock.method(globalThis, 'fetch', async () => ok({ server_id: 'srv-123', can_send: true, muted_until: null }));

    const result = await PermissionService.getChannelAccess('valid-user', 'channel-1');
    assert.deepStrictEqual(result, {
      allowed: true,
      serverId: 'srv-123',
      canSend: true,
      mutedUntil: undefined,
      canMentionEveryone: false,
      mentionableRoleIds: [],
      canManageMessages: false,
    });
  });

  it('returns whether the user can manage messages (200, can_manage_messages true)', async () => {
    mock.method(globalThis, 'fetch', async () =>
      ok({ server_id: 'srv-1', can_send: true, can_manage_messages: true })
    );

    const result = await PermissionService.getChannelAccess('moderator', 'channel-1');
    assert.strictEqual(result.canManageMessages, true);
  });

  it('returns whether the user can mention @everyone and which roles', async () => {
    mock.method(globalThis, 'fetch', async () =>
      ok({ server_id: 'srv-1', can_send: true, can_mention_everyone: true, mentionable_role_ids: ['r1', 'r2'] })
    );

    const result = await PermissionService.getChannelAccess('user-1', 'channel-1');
    assert.strictEqual(result.canMentionEveryone, true);
    assert.deepStrictEqual(result.mentionableRoleIds, ['r1', 'r2']);
  });

  it('ignores the roles without MENTION_EVERYONE or with an unexpected shape', async () => {
    mock.method(globalThis, 'fetch', async () =>
      ok({ server_id: 'srv-1', can_send: true, can_mention_everyone: false, mentionable_role_ids: ['r1'] })
    );
    assert.deepStrictEqual((await PermissionService.getChannelAccess('user-1', 'channel-1')).mentionableRoleIds, []);

    mock.method(globalThis, 'fetch', async () =>
      ok({ server_id: 'srv-1', can_send: true, can_mention_everyone: true, mentionable_role_ids: [1] })
    );
    assert.deepStrictEqual((await PermissionService.getChannelAccess('user-1', 'channel-1')).mentionableRoleIds, []);
  });

  it('allows a muted user to view but not send, with the mute expiry', async () => {
    const expiry = '2030-01-01T00:00:00.000Z';
    mock.method(globalThis, 'fetch', async () => ok({ server_id: 'srv-1', can_send: false, muted_until: expiry }));

    const result = await PermissionService.getChannelAccess('muted-user', 'channel-1');
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.canSend, false);
    assert.strictEqual(result.mutedUntil?.toISOString(), expiry);
  });

  it('ignores an invalid muted_until', async () => {
    mock.method(globalThis, 'fetch', async () => ok({ server_id: 'srv-1', can_send: false, muted_until: 'nope' }));

    const result = await PermissionService.getChannelAccess('muted-user', 'channel-1');
    assert.strictEqual(result.mutedUntil, undefined);
  });

  it('assumes the user cannot send when the body does not say so', async () => {
    mock.method(globalThis, 'fetch', async () => ({ status: 200, json: async () => { throw new Error('no body'); } }) as unknown as Response);

    const result = await PermissionService.getChannelAccess('user-1', 'channel-1');
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.canSend, false);
    assert.strictEqual(result.serverId, undefined);
  });

  it('denies access for a user who cannot view the channel (403)', async () => {
    mock.method(globalThis, 'fetch', async () => ({ status: 403 }) as Response);

    const result = await PermissionService.getChannelAccess('banned-user', 'channel-1');
    assert.deepStrictEqual(result, { allowed: false, canSend: false, canMentionEveryone: false, mentionableRoleIds: [], canManageMessages: false });
  });

  it('throws if the channel does not exist (404)', async () => {
    mock.method(globalThis, 'fetch', async () => ({ status: 404 }) as Response);

    await assert.rejects(PermissionService.getChannelAccess('user-1', 'non-existent-channel'), {
      message: 'Channel not found',
    });
  });

  it('throws if Core returns an unexpected status (500)', async () => {
    mock.method(globalThis, 'fetch', async () => ({ status: 500 }) as Response);

    await assert.rejects(PermissionService.getChannelAccess('user-1', 'channel-1'), {
      message: 'Failed to communicate with permission service',
    });
  });

  it('throws on network failure (e.g. ECONNREFUSED)', async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('fetch failed');
    });

    await assert.rejects(PermissionService.getChannelAccess('user-1', 'channel-1'), {
      message: 'Failed to communicate with permission service',
    });
  });

  it('throws if userId is missing', async () => {
    await assert.rejects(PermissionService.getChannelAccess('', 'channel-1'), {
      message: 'User ID and Channel ID are required to check permissions',
    });
  });

  it('throws if channelId is missing', async () => {
    await assert.rejects(PermissionService.getChannelAccess('user-1', ''), {
      message: 'User ID and Channel ID are required to check permissions',
    });
  });

  describe('getVisibleChannels', () => {
    it('calls /visible-channels and returns the channel ids and the user roles', async () => {
      let calledUrl = '';
      mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
        calledUrl = url.toString();
        return ok({ channel_ids: ['c1', 'c2'], role_ids: ['r1'] });
      });

      assert.deepStrictEqual(await PermissionService.getVisibleChannels('user 1'), {
        channelIds: ['c1', 'c2'],
        roleIds: ['r1'],
      });
      assert.match(calledUrl, /\/internal\/users\/user%201\/visible-channels$/);
    });

    it('takes the roles as empty when Core does not send them (before #46)', async () => {
      mock.method(globalThis, 'fetch', async () => ok({ channel_ids: ['c1'] }));
      assert.deepStrictEqual(await PermissionService.getVisibleChannels('user-1'), { channelIds: ['c1'], roleIds: [] });

      mock.method(globalThis, 'fetch', async () => ok({ channel_ids: ['c1'], role_ids: 'r1' }));
      assert.deepStrictEqual(await PermissionService.getVisibleChannels('user-1'), { channelIds: ['c1'], roleIds: [] });
    });

    it('fails as unavailable when Core cannot be reached', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new Error('fetch failed');
      });

      await assert.rejects(PermissionService.getVisibleChannels('user-1'), { name: 'UpstreamUnavailableError' });
    });

    it('fails as unavailable on an unexpected status or body', async () => {
      mock.method(globalThis, 'fetch', async () => ({ status: 500 }) as Response);
      await assert.rejects(PermissionService.getVisibleChannels('user-1'), { name: 'UpstreamUnavailableError' });

      mock.method(globalThis, 'fetch', async () => ok({ channel_ids: [1, 2] }));
      await assert.rejects(PermissionService.getVisibleChannels('user-1'), { name: 'UpstreamUnavailableError' });

      mock.method(globalThis, 'fetch', async () => ({ status: 200, json: async () => { throw new Error('no body'); } }) as unknown as Response);
      await assert.rejects(PermissionService.getVisibleChannels('user-1'), { name: 'UpstreamUnavailableError' });
    });

    it('requires a user id', async () => {
      await assert.rejects(PermissionService.getVisibleChannels(''), /User ID is required/);
    });
  });
});
