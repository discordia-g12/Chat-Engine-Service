import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { ACCOUNT_SUSPENDED_CLOSE_CODE, EventConsumer, type EventPayload } from '../src/services/EventConsumer';
import { NotFoundError, UpstreamUnavailableError } from '../src/errors';
import { ChatService } from '../src/services/ChatService';
import { PermissionService } from '../src/services/PermissionService';
import { PubSubService } from '../src/services/PubSubService';
import { SessionManager } from '../src/services/SessionManager';
import { inboxChannelId, toDmChannelId } from '../src/helpers/directMessages';
import { Types } from 'mongoose';
import type { WebSocket } from 'ws';

function createMockSocket(): WebSocket {
  const sentMessages: string[] = [];
  let closedWith: { code: number; reason: string } | null = null;

  return {
    readyState: 1,
    send: (data: string) => {
      sentMessages.push(data);
    },
    close: (code = 1000, reason = '') => {
      closedWith = { code, reason };
    },
    _sentMessages: sentMessages,
    _closedWith: () => closedWith,
  } as unknown as WebSocket;
}

describe('EventConsumer', () => {
  beforeEach(() => {
    SessionManager.clear();
    EventConsumer.clearAllTimers();
  });

  afterEach(() => {
    EventConsumer.clearAllTimers();
    mock.restoreAll();
  });

  /** Server-Roles responde si puede escribir (por usuario y canal); sin respuesta para el par, puede. */
  function mockAccess(canSendFor: (userId: string, channelId: string) => boolean = () => true) {
    return mock.method(PermissionService, 'getChannelAccess', async (userId: string, channelId: string) => ({
      allowed: true,
      canSend: canSendFor(userId, channelId),
    }));
  }

  const register = (userId: string, channelId: string, serverId: string, canSend: boolean) => {
    const socket = createMockSocket();
    SessionManager.register({ userId, channelId, serverId, socket, canSend, connectedAt: new Date() });
    return socket;
  };

  const sent = (socket: WebSocket) =>
    ((socket as unknown as { _sentMessages: string[] })._sentMessages).map((m) => JSON.parse(m));

  it('handles member.banned by disconnecting active user sessions on that server with 4003', () => {
    const ws1 = createMockSocket();
    const ws2 = createMockSocket();

    SessionManager.register({
      userId: 'bad-actor',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: ws1,
      canSend: true,
      connectedAt: new Date(),
    });

    SessionManager.register({
      userId: 'bad-actor',
      channelId: 'chan-2',
      serverId: 'srv-2',
      socket: ws2,
      canSend: true,
      connectedAt: new Date(),
    });

    EventConsumer.handleEvent('member.banned', {
      server_id: 'srv-1',
      user_id: 'bad-actor',
      reason: 'Toxic behavior',
    });

    const closed1 = (ws1 as unknown as { _closedWith: () => { code: number; reason: string } | null })._closedWith();
    const closed2 = (ws2 as unknown as { _closedWith: () => { code: number; reason: string } | null })._closedWith();

    assert.deepStrictEqual(closed1, { code: 4003, reason: 'Toxic behavior' });
    assert.strictEqual(closed2, null);
    assert.strictEqual(SessionManager.getUserSessions('bad-actor', 'srv-1').length, 0);
    assert.strictEqual(SessionManager.getUserSessions('bad-actor', 'srv-2').length, 1);
  });

  it('handles member.kicked by disconnecting active user sessions with 4002', () => {
    const ws = createMockSocket();
    SessionManager.register({
      userId: 'kicked-user',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });

    EventConsumer.handleEvent('member.kicked', {
      server_id: 'srv-1',
      user_id: 'kicked-user',
      reason: 'Inactivity',
    });

    const closed = (ws as unknown as { _closedWith: () => { code: number; reason: string } | null })._closedWith();
    assert.deepStrictEqual(closed, { code: 4002, reason: 'Inactivity' });
    assert.strictEqual(SessionManager.getUserSessions('kicked-user').length, 0);
  });

  it('handles member.left by disconnecting active user sessions with 4002', () => {
    const ws = createMockSocket();
    SessionManager.register({
      userId: 'departing-user',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });

    EventConsumer.handleEvent('member.left', {
      server_id: 'srv-1',
      user_id: 'departing-user',
    });

    const closed = (ws as unknown as { _closedWith: () => { code: number; reason: string } | null })._closedWith();
    assert.deepStrictEqual(closed, { code: 4002, reason: 'Member left server' });
    assert.strictEqual(SessionManager.getUserSessions('departing-user').length, 0);
  });

  it('handles member.muted by revoking send permission without closing socket', () => {
    const ws = createMockSocket();
    SessionManager.register({
      userId: 'spammer',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });

    EventConsumer.handleEvent('member.muted', {
      server_id: 'srv-1',
      user_id: 'spammer',
    });

    assert.strictEqual(SessionManager.canSend(ws), false);
    const closed = (ws as unknown as { _closedWith: () => { code: number; reason: string } | null })._closedWith();
    assert.strictEqual(closed, null);
  });

  it('handles temporary member.muted with expires_at by auto-unmuting after expiry', async () => {
    mockAccess();
    const ws = createMockSocket();
    SessionManager.register({
      userId: 'temp-mute-user',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });

    const shortExpiry = new Date(Date.now() + 50).toISOString();
    EventConsumer.handleEvent('member.muted', {
      server_id: 'srv-1',
      user_id: 'temp-mute-user',
      expires_at: shortExpiry,
    });

    assert.strictEqual(SessionManager.canSend(ws), false);
    assert.strictEqual(EventConsumer.pendingMuteCount, 1);

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.strictEqual(SessionManager.canSend(ws), true);
    assert.strictEqual(EventConsumer.pendingMuteCount, 0);
  });

  it('handles member.unmuted by restoring send permission and clearing timer', async () => {
    mockAccess();
    const ws = createMockSocket();
    SessionManager.register({
      userId: 'reformed-user',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: ws,
      canSend: false,
      connectedAt: new Date(),
    });

    const futureExpiry = new Date(Date.now() + 10000).toISOString();
    EventConsumer.handleEvent('member.muted', {
      server_id: 'srv-1',
      user_id: 'reformed-user',
      expires_at: futureExpiry,
    });

    assert.strictEqual(EventConsumer.pendingMuteCount, 1);

    await EventConsumer.handleEvent('member.unmuted', {
      server_id: 'srv-1',
      user_id: 'reformed-user',
    });

    assert.strictEqual(SessionManager.canSend(ws), true);
    assert.strictEqual(EventConsumer.pendingMuteCount, 0);
  });

  it('keeps a mute longer than the setTimeout limit (~24.8 days) instead of lifting it at once', async () => {
    const ws = createMockSocket();
    SessionManager.register({
      userId: 'long-mute-user',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });

    const thirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    EventConsumer.handleEvent('member.muted', { server_id: 'srv-1', user_id: 'long-mute-user', expires_at: thirtyDays });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.strictEqual(SessionManager.canSend(ws), false);
    assert.strictEqual(EventConsumer.pendingMuteCount, 1);
  });

  it('scheduleMuteExpiry enables the sessions of that user on that server only', async () => {
    mockAccess();
    const wsSrv1 = createMockSocket();
    const wsSrv2 = createMockSocket();
    SessionManager.register({ userId: 'u-sched', channelId: 'c1', serverId: 'srv-1', socket: wsSrv1, canSend: false, connectedAt: new Date() });
    SessionManager.register({ userId: 'u-sched', channelId: 'c2', serverId: 'srv-2', socket: wsSrv2, canSend: false, connectedAt: new Date() });

    EventConsumer.scheduleMuteExpiry('u-sched', 'srv-1', 20);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.strictEqual(SessionManager.canSend(wsSrv1), true);
    assert.strictEqual(SessionManager.canSend(wsSrv2), false);
    assert.strictEqual(EventConsumer.pendingMuteCount, 0);
  });

  it('member.unmuted keeps the user blocked if their role has no SEND_MESSAGES', async () => {
    mockAccess(() => false);
    const ws = register('no-send-user', 'chan-1', 'srv-1', false);

    await EventConsumer.handleEvent('member.unmuted', { server_id: 'srv-1', user_id: 'no-send-user' });

    assert.strictEqual(SessionManager.canSend(ws), false);
    assert.deepStrictEqual(sent(ws), []);
  });

  it('member.unmuted falls back to enabling the user if Server-Roles does not answer', async () => {
    mock.method(PermissionService, 'getChannelAccess', async () => {
      throw new Error('down');
    });
    const ws = register('fallback-user', 'chan-1', 'srv-1', false);

    await EventConsumer.handleEvent('member.unmuted', { server_id: 'srv-1', user_id: 'fallback-user' });

    assert.strictEqual(SessionManager.canSend(ws), true);
  });

  it('role.permissions_updated re-checks every session on that server and notifies only the ones that changed', async () => {
    // El rol perdió SEND_MESSAGES: a u-a le cambia, a u-b (que ya no podía) no
    const access = mockAccess(() => false);
    const wsA = register('u-a', 'chan-1', 'srv-roles', true);
    const wsB = register('u-b', 'chan-1', 'srv-roles', false);
    const wsOther = register('u-c', 'chan-9', 'srv-other', true);

    await EventConsumer.handleEvent('role.permissions_updated', { server_id: 'srv-roles', role_id: 'r1', permissions_bitmask: 0 });

    assert.strictEqual(SessionManager.canSend(wsA), false);
    assert.deepStrictEqual(sent(wsA), [{ type: 'PERMISSIONS_UPDATED', canSend: false, channelId: 'chan-1' }]);
    assert.deepStrictEqual(sent(wsB), []);
    assert.strictEqual(SessionManager.canSend(wsOther), true);
    assert.strictEqual(access.mock.callCount(), 2);
  });

  it('role.deleted re-checks the server sessions too', async () => {
    mockAccess(() => false);
    const ws = register('u-del', 'chan-1', 'srv-del', true);

    await EventConsumer.handleEvent('role.deleted', { server_id: 'srv-del', role_id: 'r1' });

    assert.strictEqual(SessionManager.canSend(ws), false);
  });

  it('member.role_assigned re-checks only that user on that server and can enable writing', async () => {
    mockAccess((userId) => userId === 'u-new-role');
    const ws = register('u-new-role', 'chan-1', 'srv-1', false);
    const wsOtherServer = register('u-new-role', 'chan-2', 'srv-2', false);
    const wsOtherUser = register('u-x', 'chan-1', 'srv-1', false);

    await EventConsumer.handleEvent('member.role_assigned', { server_id: 'srv-1', user_id: 'u-new-role', role_id: 'r1' });

    assert.strictEqual(SessionManager.canSend(ws), true);
    assert.deepStrictEqual(sent(ws), [{ type: 'PERMISSIONS_UPDATED', canSend: true, channelId: 'chan-1' }]);
    assert.strictEqual(SessionManager.canSend(wsOtherServer), false);
    assert.strictEqual(SessionManager.canSend(wsOtherUser), false);
  });

  it('member.role_removed can block writing, asking once per user and channel', async () => {
    const access = mockAccess(() => false);
    const tab1 = register('u-two-tabs', 'chan-1', 'srv-1', true);
    const tab2 = register('u-two-tabs', 'chan-1', 'srv-1', true);

    await EventConsumer.handleEvent('member.role_removed', { server_id: 'srv-1', user_id: 'u-two-tabs', role_id: 'r1' });

    assert.strictEqual(SessionManager.canSend(tab1), false);
    assert.strictEqual(SessionManager.canSend(tab2), false);
    assert.strictEqual(access.mock.callCount(), 1);
  });

  it('a role change leaves sessions as they were if Server-Roles does not answer', async () => {
    mock.method(PermissionService, 'getChannelAccess', async () => {
      throw new Error('down');
    });
    const ws = register('u-down', 'chan-1', 'srv-down', true);

    await EventConsumer.handleEvent('role.permissions_updated', { server_id: 'srv-down', role_id: 'r1' });

    assert.strictEqual(SessionManager.canSend(ws), true);
  });

  it('when the mute expiry fires but Server-Roles still reports the mute, schedules it again', async () => {
    // El timer se adelantó: Server-Roles todavía lo informa muteado por un instante más
    const mutedUntil = new Date(Date.now() + 5);
    mock.method(PermissionService, 'getChannelAccess', async () => ({ allowed: true, canSend: false, mutedUntil }));
    const ws = register('u-early', 'chan-1', 'srv-1', false);

    await EventConsumer.handleEvent('member.unmuted', { server_id: 'srv-1', user_id: 'u-early' });

    assert.strictEqual(SessionManager.canSend(ws), false);
    assert.strictEqual(EventConsumer.pendingMuteCount, 1);
  });

  it('ignores events with missing payload or user_id', async () => {
    await EventConsumer.handleEvent('member.banned', {} as EventPayload);
    await EventConsumer.handleEvent('unknown.event', { user_id: 'u1' });
    await EventConsumer.handleEvent('role.permissions_updated', {});
  });
});

describe('EventConsumer: cuenta suspendida (user.suspended de Auth-User)', () => {
  beforeEach(() => SessionManager.clear());

  const closedWith = (socket: WebSocket) =>
    (socket as unknown as { _closedWith: () => { code: number; reason: string } | null })._closedWith();

  const register = (userId: string, channelId: string, serverId: string) => {
    const socket = createMockSocket();
    SessionManager.register({ userId, channelId, serverId, socket, canSend: true, connectedAt: new Date() });
    return socket;
  };

  it('cierra todas las conexiones de la cuenta, en cualquier servidor, DMs y bandeja, con 4010', async () => {
    const inServer = register('auth0|u1', 'chan-1', 'srv-1');
    const inOtherServer = register('auth0|u1', 'chan-2', 'srv-2');
    const dm = register('auth0|u1', toDmChannelId(new Types.ObjectId()), '');
    const inbox = register('auth0|u1', inboxChannelId('auth0|u1'), '');
    const someoneElse = register('auth0|u2', 'chan-1', 'srv-1');

    await EventConsumer.handleEvent('user.suspended', { user_id: 'auth0|u1', identities: ['auth0|u1'] });

    for (const socket of [inServer, inOtherServer, dm, inbox]) {
      assert.deepStrictEqual(closedWith(socket), { code: ACCOUNT_SUSPENDED_CLOSE_CODE, reason: 'Account suspended' });
    }
    assert.strictEqual(closedWith(someoneElse), null);
    assert.strictEqual(SessionManager.getChannelSockets(inboxChannelId('auth0|u1')).length, 0);
    assert.strictEqual(SessionManager.getUserSessions('auth0|u1').length, 0);
  });

  it('también cierra las conexiones de sus identidades federadas', async () => {
    const federated = register('google-oauth2|9', 'chan-1', 'srv-1');

    await EventConsumer.handleEvent('user.suspended', {
      user_id: 'auth0|u1',
      identities: ['auth0|u1', 'google-oauth2|9', 42, ''],
    });

    assert.strictEqual(closedWith(federated)?.code, ACCOUNT_SUSPENDED_CLOSE_CODE);
  });

  it('ignora un evento sin identidades', async () => {
    const socket = register('auth0|u1', 'chan-1', 'srv-1');

    await EventConsumer.handleEvent('user.suspended', { identities: 'auth0|u1' });

    assert.strictEqual(closedWith(socket), null);
  });
});

describe('EventConsumer: eliminación de servidor y canal (server.deleted, channel.deleted)', () => {
  beforeEach(() => {
    SessionManager.clear();
    mock.restoreAll();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  const closedWith = (socket: WebSocket) =>
    (socket as unknown as { _closedWith: () => { code: number; reason: string } | null })._closedWith();

  const register = (userId: string, channelId: string, serverId: string) => {
    const socket = createMockSocket();
    SessionManager.register({ userId, channelId, serverId, socket, canSend: true, connectedAt: new Date() });
    return socket;
  };

  it('server.deleted desconecta todas las sesiones del servidor con 4004 y borra mensajes de sus canales', async () => {
    const srv1Socket1 = register('u1', 'chan-1', 'srv-1');
    const srv1Socket2 = register('u2', 'chan-2', 'srv-1');
    const otherSrvSocket = register('u1', 'chan-9', 'srv-2');
    const dmSocket = register('u1', toDmChannelId(new Types.ObjectId()), '');

    let deletedChannels: string[] = [];
    mock.method(ChatService, 'deleteChannelsMessages', async (ids: string[]) => {
      deletedChannels = ids;
      return ids.length;
    });

    await EventConsumer.handleEvent('server.deleted', {
      server_id: 'srv-1',
      channel_ids: ['chan-1', 'chan-2'],
    });

    assert.deepStrictEqual(closedWith(srv1Socket1), { code: 4004, reason: 'Server deleted' });
    assert.deepStrictEqual(closedWith(srv1Socket2), { code: 4004, reason: 'Server deleted' });
    assert.strictEqual(closedWith(otherSrvSocket), null);
    assert.strictEqual(closedWith(dmSocket), null);
    assert.deepStrictEqual(deletedChannels, ['chan-1', 'chan-2']);
    assert.strictEqual(SessionManager.getServerSessions('srv-1').length, 0);
  });

  it('channel.deleted desconecta todas las sesiones de ese canal con 4004 y borra sus mensajes', async () => {
    const chan1Socket1 = register('u1', 'chan-1', 'srv-1');
    const chan1Socket2 = register('u2', 'chan-1', 'srv-1');
    const chan2Socket = register('u3', 'chan-2', 'srv-1');

    let deletedChannel = '';
    mock.method(ChatService, 'deleteChannelMessages', async (id: string) => {
      deletedChannel = id;
      return 1;
    });

    await EventConsumer.handleEvent('channel.deleted', {
      server_id: 'srv-1',
      channel_id: 'chan-1',
    });

    assert.deepStrictEqual(closedWith(chan1Socket1), { code: 4004, reason: 'Channel deleted' });
    assert.deepStrictEqual(closedWith(chan1Socket2), { code: 4004, reason: 'Channel deleted' });
    assert.strictEqual(closedWith(chan2Socket), null);
    assert.strictEqual(deletedChannel, 'chan-1');
    assert.strictEqual(SessionManager.getChannelSockets('chan-1').length, 0);
  });
});


describe('EventConsumer: configuración del servidor (server.updated)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  /** Lo que se publicó en el inbox de cada usuario. */
  function captureInbox() {
    const published: Array<{ userId: string; event: unknown }> = [];
    mock.method(PubSubService, 'publishToInbox', async (userId: string, event: unknown) => {
      published.push({ userId, event });
    });
    return published;
  }

  it('avisa SERVER_UPDATED por el inbox a cada miembro del servidor, solo con el id', async () => {
    const asked: string[] = [];
    mock.method(PermissionService, 'getServerMemberIds', async (serverId: string) => {
      asked.push(serverId);
      return ['owner', 'member-1', 'member-2'];
    });
    const published = captureInbox();

    await EventConsumer.handleEvent('server.updated', { server_id: 'srv-1' });

    assert.deepStrictEqual(asked, ['srv-1']);
    assert.deepStrictEqual(published, [
      { userId: 'owner', event: { type: 'SERVER_UPDATED', serverId: 'srv-1' } },
      { userId: 'member-1', event: { type: 'SERVER_UPDATED', serverId: 'srv-1' } },
      { userId: 'member-2', event: { type: 'SERVER_UPDATED', serverId: 'srv-1' } },
    ]);
  });

  it('no avisa a nadie si el evento no trae server_id', async () => {
    const getMembers = mock.method(PermissionService, 'getServerMemberIds', async () => ['u1']);
    const published = captureInbox();

    await EventConsumer.handleEvent('server.updated', {});

    assert.strictEqual(getMembers.mock.callCount(), 0);
    assert.deepStrictEqual(published, []);
  });

  it('no hace nada si el servidor ya no existe (se borró antes de procesar el evento)', async () => {
    mock.method(PermissionService, 'getServerMemberIds', async () => {
      throw new NotFoundError('Server not found');
    });
    const published = captureInbox();

    await EventConsumer.handleEvent('server.updated', { server_id: 'srv-gone' });

    assert.deepStrictEqual(published, []);
  });

  it('si Server-Roles no responde, lo registra y descarta el aviso sin romper el consumidor', async () => {
    mock.method(PermissionService, 'getServerMemberIds', async () => {
      throw new UpstreamUnavailableError('down');
    });
    const warn = mock.method(console, 'warn', () => undefined);
    const published = captureInbox();

    await EventConsumer.handleEvent('server.updated', { server_id: 'srv-1' });

    assert.deepStrictEqual(published, []);
    assert.strictEqual(warn.mock.callCount(), 1);
  });

  it('no cierra ni toca las sesiones de chat abiertas en el servidor', async () => {
    SessionManager.clear();
    const socket = createMockSocket();
    SessionManager.register({ userId: 'u1', channelId: 'c1', serverId: 'srv-1', socket, canSend: true, connectedAt: new Date() });
    mock.method(PermissionService, 'getServerMemberIds', async () => ['u1']);
    captureInbox();

    await EventConsumer.handleEvent('server.updated', { server_id: 'srv-1' });

    assert.strictEqual(SessionManager.getServerSessions('srv-1').length, 1);
    assert.strictEqual((socket as unknown as { _closedWith: () => unknown })._closedWith(), null);
    SessionManager.clear();
  });
});
