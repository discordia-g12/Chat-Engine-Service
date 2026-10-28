import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { EventConsumer } from '../src/services/EventConsumer';
import { PermissionService } from '../src/services/PermissionService';
import { SessionManager } from '../src/services/SessionManager';
import { ForbiddenError } from '../src/errors';
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

async function simulateClientSendMessage(
  socket: WebSocket,
  userId: string,
  channelId: string,
  content: string
) {
  if (!SessionManager.canSend(socket)) {
    throw new ForbiddenError('User does not have permission to send messages in this channel');
  }

  const savedPayload = {
    id: 'msg-1',
    authorId: userId,
    channelId,
    content,
    createdAt: new Date(),
  };

  const clients = SessionManager.getChannelSockets(channelId);
  const raw = JSON.stringify(savedPayload);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(raw);
    }
  }
  return savedPayload;
}

describe('Event-Driven WebSocket Lifecycle Integration', () => {
  beforeEach(() => {
    SessionManager.clear();
    EventConsumer.clearAllTimers();
  });

  it('allows message sending and broadcasts when user is active', async () => {
    const wsAlice = createMockSocket();
    const wsBob = createMockSocket();

    SessionManager.register({
      userId: 'alice',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: wsAlice,
      canSend: true,
      connectedAt: new Date(),
    });

    SessionManager.register({
      userId: 'bob',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: wsBob,
      canSend: true,
      connectedAt: new Date(),
    });

    const payload = await simulateClientSendMessage(wsAlice, 'alice', 'chan-1', 'Hello reactive world');
    assert.strictEqual(payload.content, 'Hello reactive world');

    const bobMessages = (wsBob as unknown as { _sentMessages: string[] })._sentMessages;
    assert.strictEqual(bobMessages.length, 1);
    const parsedBob = JSON.parse(bobMessages[0]);
    assert.strictEqual(parsedBob.content, 'Hello reactive world');
  });

  it('rejects message sending in memory when member.muted arrives and recovers on member.unmuted', async () => {
    const wsAlice = createMockSocket();
    SessionManager.register({
      userId: 'alice',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: wsAlice,
      canSend: true,
      connectedAt: new Date(),
    });

    await assert.doesNotReject(async () => {
      await simulateClientSendMessage(wsAlice, 'alice', 'chan-1', 'First message ok');
    });

    EventConsumer.handleEvent('member.muted', {
      server_id: 'srv-1',
      user_id: 'alice',
    });

    await assert.rejects(
      async () => {
        await simulateClientSendMessage(wsAlice, 'alice', 'chan-1', 'Should be forbidden');
      },
      {
        name: 'ForbiddenError',
        message: 'User does not have permission to send messages in this channel',
      }
    );

    // Al quitar el mute se vuelve a preguntar a Server-Roles: su rol le permite escribir
    const access = mock.method(PermissionService, 'getChannelAccess', async () => ({ allowed: true, canSend: true }));
    await EventConsumer.handleEvent('member.unmuted', {
      server_id: 'srv-1',
      user_id: 'alice',
    });
    access.mock.restore();

    await assert.doesNotReject(async () => {
      await simulateClientSendMessage(wsAlice, 'alice', 'chan-1', 'Message after unmute');
    });
  });

  it('closes WebSocket with code 4003 when member.banned arrives, keeping other servers intact', async () => {
    const wsAliceServer1 = createMockSocket();
    const wsAliceServer2 = createMockSocket();

    SessionManager.register({
      userId: 'alice',
      channelId: 'chan-1',
      serverId: 'srv-1',
      socket: wsAliceServer1,
      canSend: true,
      connectedAt: new Date(),
    });

    SessionManager.register({
      userId: 'alice',
      channelId: 'chan-2',
      serverId: 'srv-2',
      socket: wsAliceServer2,
      canSend: true,
      connectedAt: new Date(),
    });

    EventConsumer.handleEvent('member.banned', {
      server_id: 'srv-1',
      user_id: 'alice',
      reason: 'Rule violation',
    });

    const closed1 = (wsAliceServer1 as unknown as { _closedWith: () => { code: number; reason: string } | null })._closedWith();
    const closed2 = (wsAliceServer2 as unknown as { _closedWith: () => { code: number; reason: string } | null })._closedWith();

    assert.deepStrictEqual(closed1, { code: 4003, reason: 'Rule violation' });
    assert.strictEqual(closed2, null);
    assert.strictEqual(SessionManager.getUserSessions('alice', 'srv-1').length, 0);
    assert.strictEqual(SessionManager.getUserSessions('alice', 'srv-2').length, 1);
    assert.strictEqual(SessionManager.canSend(wsAliceServer2), true);
  });
});
