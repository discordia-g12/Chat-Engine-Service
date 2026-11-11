import type { WebSocket } from 'ws';
import { isDmChannel, isInboxChannel } from '../helpers/directMessages';

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

  private static onChannelActive?: (channelId: string) => void;
  private static onChannelEmpty?: (channelId: string) => void;
  private static onClear?: () => void;

  static setChannelHooks(hooks: {
    onChannelActive?: (channelId: string) => void;
    onChannelEmpty?: (channelId: string) => void;
    onClear?: () => void;
  }): void {
    this.onChannelActive = hooks.onChannelActive;
    this.onChannelEmpty = hooks.onChannelEmpty;
    this.onClear = hooks.onClear;
  }

  static getActiveChannelIds(): string[] {
    return Array.from(this.channelSockets.keys());
  }

  static register(session: ClientSession): void {
    const { channelId, userId, socket } = session;

    const isFirstSocket = !this.channelSockets.has(channelId);
    if (isFirstSocket) {
      this.channelSockets.set(channelId, new Set());
    }
    this.channelSockets.get(channelId)!.add(socket);

    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    this.userSessions.get(userId)!.add(session);

    this.socketSessions.set(socket, session);

    if (isFirstSocket && this.onChannelActive) {
      this.onChannelActive(channelId);
    }
  }

  static unregister(socket: WebSocket): ClientSession | undefined {
    const session = this.socketSessions.get(socket);
    if (!session) {
      return undefined;
    }

    this.socketSessions.delete(socket);

    const channelSet = this.channelSockets.get(session.channelId);
    let isLastSocket = false;
    if (channelSet) {
      channelSet.delete(socket);
      if (channelSet.size === 0) {
        this.channelSockets.delete(session.channelId);
        isLastSocket = true;
      }
    }

    const userSet = this.userSessions.get(session.userId);
    if (userSet) {
      userSet.delete(session);
      if (userSet.size === 0) {
        this.userSessions.delete(session.userId);
      }
    }

    if (isLastSocket && this.onChannelEmpty) {
      this.onChannelEmpty(session.channelId);
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

  /**
   * Sesiones del usuario en canales de servidor. Las de DM e inbox quedan afuera: su `serverId` es vacío, y
   * un evento de servidor sin `server_id` (que acá significa "todos sus servidores") no debe cerrarlas.
   */
  static getUserSessions(userId: string, serverId?: string): ClientSession[] {
    const set = this.userSessions.get(userId);
    if (!set) return [];
    const sessions = Array.from(set).filter((s) => !isDmChannel(s.channelId) && !isInboxChannel(s.channelId));
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

  /**
   * Cierra TODAS las sesiones del usuario: canales de cualquier servidor, DMs y bandeja. A diferencia de
   * disconnectUser (eventos de servidor, que no tocan DMs ni bandeja), es para cuando la cuenta entera queda
   * afuera: suspensión por la plataforma.
   */
  static disconnectAllSessions(userId: string, reason: string, code: number): void {
    for (const session of Array.from(this.userSessions.get(userId) ?? [])) {
      this.closeSession(session, reason, code);
    }
  }

  /** Cierra una sesión (si sigue abierta) y la saca del registro. */
  static closeSession(session: ClientSession, reason: string, code: number): void {
    if (session.socket.readyState === 1) {
      session.socket.close(code, reason);
    }
    this.unregister(session.socket);
  }

  /**
   * Cierra todas las sesiones abiertas en canales de ese servidor (servidor eliminado o suspendido por el staff).
   */
  static disconnectServer(serverId: string, reason = 'Server deleted', code = 4004): void {
    for (const session of this.getServerSessions(serverId)) {
      this.closeSession(session, reason, code);
    }
  }

  /**
   * Cierra todas las sesiones abiertas en ese canal (canal eliminado).
   */
  static disconnectChannel(channelId: string, reason = 'Channel deleted', code = 4004): void {
    const sockets = this.getChannelSockets(channelId);
    for (const socket of sockets) {
      if (socket.readyState === 1) {
        socket.close(code, reason);
      }
      this.unregister(socket);
    }
  }

  static clear(): void {
    this.channelSockets.clear();
    this.userSessions.clear();
    this.socketSessions.clear();
    if (this.onClear) {
      this.onClear();
    }
  }
}
