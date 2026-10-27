import type { WebSocket } from 'ws';

export interface ClientSession {
  userId: string;
  channelId: string;
  serverId: string;
  socket: WebSocket;
  canSend: boolean;
  connectedAt: Date;
}

export class SessionManager {
  private static channelSockets = new Map<string, Set<WebSocket>>();
  private static userSessions = new Map<string, Set<ClientSession>>();
  private static socketSessions = new Map<WebSocket, ClientSession>();

  static register(session: ClientSession): void {
    const { channelId, userId, socket } = session;

    if (!this.channelSockets.has(channelId)) {
      this.channelSockets.set(channelId, new Set());
    }
    this.channelSockets.get(channelId)!.add(socket);

    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    this.userSessions.get(userId)!.add(session);

    this.socketSessions.set(socket, session);
  }

  static unregister(socket: WebSocket): ClientSession | undefined {
    const session = this.socketSessions.get(socket);
    if (!session) {
      return undefined;
    }

    this.socketSessions.delete(socket);

    const channelSet = this.channelSockets.get(session.channelId);
    if (channelSet) {
      channelSet.delete(socket);
      if (channelSet.size === 0) {
        this.channelSockets.delete(session.channelId);
      }
    }

    const userSet = this.userSessions.get(session.userId);
    if (userSet) {
      userSet.delete(session);
      if (userSet.size === 0) {
        this.userSessions.delete(session.userId);
      }
    }

    return session;
  }

  static getSession(socket: WebSocket): ClientSession | undefined {
    return this.socketSessions.get(socket);
  }

  static getChannelSockets(channelId: string): WebSocket[] {
    const set = this.channelSockets.get(channelId);
    return set ? Array.from(set) : [];
  }

  static getUserSessions(userId: string, serverId?: string): ClientSession[] {
    const set = this.userSessions.get(userId);
    if (!set) return [];
    const sessions = Array.from(set);
    if (serverId) return sessions.filter(s => s.serverId === serverId);
    return sessions;
  }

  /** Sesiones abiertas en canales de ese servidor (de todos los usuarios). */
  static getServerSessions(serverId: string): ClientSession[] {
    return Array.from(this.socketSessions.values()).filter((s) => s.serverId === serverId);
  }

  /** Cambia si la sesión puede escribir y, solo si cambió, se lo avisa al cliente (PERMISSIONS_UPDATED). */
  static setCanSend(session: ClientSession, canSend: boolean): void {
    if (session.canSend === canSend) return;
    session.canSend = canSend;
    if (session.socket.readyState === 1) {
      session.socket.send(JSON.stringify({ type: 'PERMISSIONS_UPDATED', canSend, channelId: session.channelId }));
    }
  }

  static canSend(socket: WebSocket): boolean {
    return this.socketSessions.get(socket)?.canSend ?? false;
  }

  static updateUserPermission(userId: string, canSend: boolean, channelId?: string, serverId?: string): void {
    const sessions = this.getUserSessions(userId);
    for (const session of sessions) {
      if (channelId && session.channelId !== channelId) continue;
      if (serverId && session.serverId !== serverId) continue;
      session.canSend = canSend;
      if (session.socket.readyState === 1) {
        session.socket.send(
          JSON.stringify({
            type: 'PERMISSIONS_UPDATED',
            canSend,
            channelId: session.channelId,
          })
        );
      }
    }
  }

  static disconnectUser(userId: string, reason = 'Disconnected', code = 4003, channelId?: string, serverId?: string): void {
    const sessions = this.getUserSessions(userId);
    for (const session of sessions) {
      if (channelId && session.channelId !== channelId) continue;
      if (serverId && session.serverId !== serverId) continue;
      if (session.socket.readyState === 1) {
        session.socket.close(code, reason);
      }
      this.unregister(session.socket);
    }
  }

  static clear(): void {
    this.channelSockets.clear();
    this.userSessions.clear();
    this.socketSessions.clear();
  }
}
