import type { WebSocket } from 'ws';
import { PresenceService, type PresenceStatus } from './PresenceService';

/** Máximo de usuarios que sigue un socket: lo que la app tiene en pantalla (amigos, DMs, miembros). */
export const MAX_WATCHED_USERS = 500;

/** Lo que viaja por el canal de Redis: el estado nuevo de un usuario (por id canónico). */
export interface PresenceChange {
  userId: string;
  status: PresenceStatus;
}

const isPresenceChange = (value: unknown): value is PresenceChange => {
  if (typeof value !== 'object' || value === null) return false;
  const change = value as Record<string, unknown>;
  return typeof change.userId === 'string' && typeof change.status === 'string';
};

/**
 * A quién sigue cada socket inbox de esta instancia (PRESENCE_SUBSCRIBE) y la entrega de los cambios.
 * Se indexa por id canónico, pero a cada socket se le avisa con los ids tal como los pidió (alias incluidos).
 */
export class PresenceHub {
  /** id canónico → socket → ids con los que ese socket lo pidió */
  private static watchers = new Map<string, Map<WebSocket, Set<string>>>();
  /** socket → ids canónicos que sigue (para soltarlos al cambiar la lista o al cerrarse) */
  private static watching = new Map<WebSocket, string[]>();
  /** Último pedido de cada socket: si llegan dos seguidos, gana el último aunque el primero tarde más. */
  private static requests = new Map<WebSocket, number>();
  private static sequence = 0;

  /**
   * Reemplaza la lista de usuarios que sigue el socket y devuelve su estado actual, para que el cliente
   * no dependa de lo que pidió por HTTP antes de suscribirse.
   *
   * @returns null si mientras resolvía llegó otro pedido o el socket se cerró
   * @throws UpstreamUnavailableError si Auth o Redis no responden
   */
  static async watch(socket: WebSocket, userIds: string[]): Promise<Record<string, PresenceStatus> | null> {
    const request = ++this.sequence;
    this.requests.set(socket, request);

    const users = await PresenceService.resolve(Array.from(new Set(userIds)).slice(0, MAX_WATCHED_USERS));
    if (this.requests.get(socket) !== request) return null;

    this.release(socket);
    for (const user of users) {
      let sockets = this.watchers.get(user.canonicalId);
      if (!sockets) {
        sockets = new Map();
        this.watchers.set(user.canonicalId, sockets);
      }
      let aliases = sockets.get(socket);
      if (!aliases) {
        aliases = new Set();
        sockets.set(socket, aliases);
      }
      aliases.add(user.id);
    }
    this.watching.set(socket, Array.from(new Set(users.map((user) => user.canonicalId))));

    return PresenceService.statusesOf(users);
  }

  /** El socket se cerró: deja de seguir a todos. */
  static unwatch(socket: WebSocket): void {
    this.requests.delete(socket);
    this.release(socket);
  }

  /** Un cambio que llegó por Redis (de esta instancia o de otra): se lo manda a quienes lo siguen acá. */
  static deliver(rawChange: string): void {
    let change: unknown;
    try {
      change = JSON.parse(rawChange);
    } catch {
      return;
    }
    if (!isPresenceChange(change)) return;

    for (const [socket, aliases] of this.watchers.get(change.userId) ?? []) {
      if (socket.readyState !== 1) continue;
      for (const userId of aliases) {
        socket.send(JSON.stringify({ type: 'PRESENCE_UPDATE', userId, status: change.status }));
      }
    }
  }

  /** Para tests y métricas: cuántos sockets siguen a ese usuario en esta instancia. */
  static watcherCount(canonicalId: string): number {
    return this.watchers.get(canonicalId)?.size ?? 0;
  }

  static clear(): void {
    this.watchers.clear();
    this.watching.clear();
    this.requests.clear();
  }

  private static release(socket: WebSocket): void {
    for (const userId of this.watching.get(socket) ?? []) {
      const sockets = this.watchers.get(userId);
      sockets?.delete(socket);
      if (sockets?.size === 0) this.watchers.delete(userId);
    }
    this.watching.delete(socket);
  }
}
