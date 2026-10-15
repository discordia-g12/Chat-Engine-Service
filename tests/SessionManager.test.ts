import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
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

describe('SessionManager', () => {
  beforeEach(() => {
    SessionManager.clear();
  });

  it('registers and unregisters sessions correctly', () => {
    const ws = createMockSocket();
    SessionManager.register({
      userId: 'user-1',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });

    assert.strictEqual(SessionManager.canSend(ws), true);
    assert.strictEqual(SessionManager.getChannelSockets('chan-1').length, 1);
    assert.strictEqual(SessionManager.getUserSessions('user-1').length, 1);
    assert.strictEqual(SessionManager.getUserSessions('user-1', 'srv-1').length, 1);
    assert.strictEqual(SessionManager.getUserSessions('user-1', 'srv-other').length, 0);

    const unregistered = SessionManager.unregister(ws);
    assert.ok(unregistered);
    assert.strictEqual(SessionManager.canSend(ws), false);
    assert.strictEqual(SessionManager.getChannelSockets('chan-1').length, 0);
    assert.strictEqual(SessionManager.getUserSessions('user-1').length, 0);
  });

  it('updates user permission and notifies socket', () => {
    const ws = createMockSocket();
    SessionManager.register({
      userId: 'user-2',
      channelId: 'chan-2',
      serverId: 'srv-1',
      socket: ws,
      canSend: true,
      connectedAt: new Date(),
    });

    SessionManager.updateUserPermission('user-2', false, undefined, 'srv-1');
    assert.strictEqual(SessionManager.canSend(ws), false);

    const sent = (ws as unknown as { _sentMessages: string[] })._sentMessages;
    assert.strictEqual(sent.length, 1);
    const parsed = JSON.parse(sent[0]);
    assert.strictEqual(parsed.type, 'PERMISSIONS_UPDATED');
    assert.strictEqual(parsed.canSend, false);
  });

  it('isolates user permissions across different servers', () => {
    const wsServerA = createMockSocket();
    const wsServerB = createMockSocket();

    SessionManager.register({
      userId: 'user-multi',
      channelId: 'chan-a',
      serverId: 'srv-a',
      socket: wsServerA,
      canSend: true,
      connectedAt: new Date(),
    });

    SessionManager.register({
      userId: 'user-multi',
      channelId: 'chan-b',
      serverId: 'srv-b',
      socket: wsServerB,
      canSend: true,
      connectedAt: new Date(),
    });

    SessionManager.updateUserPermission('user-multi', false, undefined, 'srv-a');

    assert.strictEqual(SessionManager.canSend(wsServerA), false);
    assert.strictEqual(SessionManager.canSend(wsServerB), true);
  });

  it('disconnects user only from target server', () => {
    const wsServerA = createMockSocket();
    const wsServerB = createMockSocket();

    SessionManager.register({
      userId: 'user-multi-dc',
      channelId: 'chan-a',
      serverId: 'srv-a',
      socket: wsServerA,
      canSend: true,
      connectedAt: new Date(),
    });

    SessionManager.register({
      userId: 'user-multi-dc',
      channelId: 'chan-b',
      serverId: 'srv-b',
      socket: wsServerB,
      canSend: true,
      connectedAt: new Date(),
    });

    SessionManager.disconnectUser('user-multi-dc', 'Banned', 4003, undefined, 'srv-a');

    const closedA = (wsServerA as unknown as { _closedWith: () => { code: number; reason: string } | null })._closedWith();
    const closedB = (wsServerB as unknown as { _closedWith: () => { code: number; reason: string } | null })._closedWith();

    assert.deepStrictEqual(closedA, { code: 4003, reason: 'Banned' });
    assert.strictEqual(closedB, null);
    assert.strictEqual(SessionManager.getUserSessions('user-multi-dc', 'srv-a').length, 0);
    assert.strictEqual(SessionManager.getUserSessions('user-multi-dc', 'srv-b').length, 1);
  });
});
