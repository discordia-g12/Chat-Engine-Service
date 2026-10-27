import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventConsumer } from '../src/services/EventConsumer';
import { SessionManager } from '../src/services/SessionManager';
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
  });

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

  it('handles member.unmuted by restoring send permission and clearing timer', () => {
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

    EventConsumer.handleEvent('member.unmuted', {
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

  it('ignores events with missing payload or user_id', () => {
    assert.doesNotThrow(() => {
      EventConsumer.handleEvent('member.banned', {} as EventPayload);
      EventConsumer.handleEvent('unknown.event', { user_id: 'u1' });
    });
  });
});
