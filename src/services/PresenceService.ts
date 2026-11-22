import { getRedis } from '../config/redis';
import { UpstreamUnavailableError } from '../errors';
import { RelationsService } from './RelationsService';

const PRESENCE_TTL_SECONDS = 60;

/** Lo que ven los demás. Un usuario invisible figura `offline`. */
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

/** Lo que elige el usuario. Vale mientras esté conectado y se guarda entre sesiones. */
export type PreferredStatus = 'online' | 'idle' | 'dnd' | 'invisible';

export const PREFERRED_STATUSES: readonly PreferredStatus[] = ['online', 'idle', 'dnd', 'invisible'];

const DEFAULT_PREFERENCE: PreferredStatus = 'online';

/** Lo que usa de Redis, para poder simularlo en los tests. */
export interface PresenceRedis {
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  mget(keys: string[]): Promise<(string | null)[]>;
}

const presenceKey = (userId: string) => `presence:${userId}`;
const preferenceKey = (userId: string) => `presence:pref:${userId}`;

export const isPreferredStatus = (value: unknown): value is PreferredStatus =>
  typeof value === 'string' && (PREFERRED_STATUSES as readonly string[]).includes(value);

const toPreference = (value: string | null | undefined): PreferredStatus =>
  isPreferredStatus(value) ? value : DEFAULT_PREFERENCE;

/** Conectado + preferencia → lo que ven los demás. */
const visibleStatus = (connected: boolean, preference: PreferredStatus): PresenceStatus => {
  if (!connected || preference === 'invisible') return 'offline';
  return preference;
};

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
   * su heartbeat vuelve a crear la clave en el próximo ping. La preferencia no se toca.
   */
  static async clear(userId: string): Promise<void> {
    await this.redis().del(presenceKey(userId));
  }

  /**
   * Estado elegido por el usuario (`online` si nunca eligió uno).
   *
   * @throws UpstreamUnavailableError si Redis no responde
   */
  static async getPreference(userId: string): Promise<PreferredStatus> {
    try {
      const [value] = await this.redis().mget([preferenceKey(userId)]);
      return toPreference(value);
    } catch (cause) {
      throw new UpstreamUnavailableError('Failed to read presence', { cause });
    }
  }

  /**
   * Guarda el estado elegido. Sin TTL: se conserva aunque el usuario se desconecte.
   *
   * @throws UpstreamUnavailableError si Redis no responde
   */
  static async setPreference(userId: string, status: PreferredStatus): Promise<void> {
    try {
      await this.redis().set(preferenceKey(userId), status);
    } catch (cause) {
      throw new UpstreamUnavailableError('Failed to update presence', { cause });
    }
  }

  /**
   * Estado de cada usuario, con los ids tal como los pidió el cliente: la clave está por id canónico, pero
   * en los canales de servidor un autor puede figurar con un alias. Conectado vale su preferencia;
   * invisible, suspendido o sin conexión, `offline`.
   *
   * @throws UpstreamUnavailableError si Auth o Redis no responden
   */
  static async getStatuses(userIds: string[]): Promise<Record<string, PresenceStatus>> {
    if (userIds.length === 0) return {};
    const users = await Promise.all(
      userIds.map(async (id) => ({ id, canonical: await RelationsService.getCanonical(id) }))
    );
    const canonicalIds = users.map(({ id, canonical }) => canonical?.userId ?? id);

    // Una sola ida a Redis: primero las claves de conexión, después las de preferencia
    let values: (string | null)[];
    try {
      values = await this.redis().mget([...canonicalIds.map(presenceKey), ...canonicalIds.map(preferenceKey)]);
    } catch (cause) {
      throw new UpstreamUnavailableError('Failed to read presence', { cause });
    }

    return Object.fromEntries(
      users.map(({ id, canonical }, i) => {
        const connected = Boolean(canonical && !canonical.suspended && values.at(i));
        return [id, visibleStatus(connected, toPreference(values.at(users.length + i)))];
      })
    );
  }
}
