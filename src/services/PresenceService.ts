import { getRedis } from '../config/redis';
import { UpstreamUnavailableError } from '../errors';
import { RelationsService } from './RelationsService';

const PRESENCE_TTL_SECONDS = 60;

export type PresenceStatus = 'online' | 'offline';

/** Lo que usa de Redis, para poder simularlo en los tests. */
export interface PresenceRedis {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  mget(keys: string[]): Promise<(string | null)[]>;
}

const presenceKey = (userId: string) => `presence:${userId}`;

export class PresenceService {
  private static client: PresenceRedis | null = null;

  /** Para tests: reemplaza el cliente compartido. */
  static useClient(client: PresenceRedis | null): void {
    this.client = client;
  }

  private static redis(): PresenceRedis {
    return this.client ?? getRedis();
  }

  /** Marca al usuario conectado. La renueva el heartbeat del inbox: si el socket muere, la clave vence sola. */
  static async touch(userId: string): Promise<void> {
    await this.redis().set(presenceKey(userId), '1', 'EX', PRESENCE_TTL_SECONDS);
  }

  /**
   * Se llama al cerrarse el último socket del usuario en esta instancia. Si tiene otro en otra instancia,
   * su heartbeat vuelve a crear la clave en el próximo ping.
   */
  static async clear(userId: string): Promise<void> {
    await this.redis().del(presenceKey(userId));
  }

  /**
   * Estado de cada usuario, con los ids tal como los pidió el cliente: la clave está por id canónico, pero
   * en los canales de servidor un autor puede figurar con un alias.
   *
   * @throws UpstreamUnavailableError si Auth o Redis no responden
   */
  static async getStatuses(userIds: string[]): Promise<Record<string, PresenceStatus>> {
    if (userIds.length === 0) return {};
    const users = await Promise.all(
      userIds.map(async (id) => ({ id, canonical: await RelationsService.getCanonical(id) }))
    );

    let values: (string | null)[];
    try {
      values = await this.redis().mget(users.map(({ id, canonical }) => presenceKey(canonical?.userId ?? id)));
    } catch (cause) {
      throw new UpstreamUnavailableError('Failed to read presence', { cause });
    }

    return Object.fromEntries(
      users.map(({ id, canonical }, i) => [
        id,
        canonical && !canonical.suspended && values.at(i) ? ('online' as const) : ('offline' as const),
      ])
    );
  }
}
