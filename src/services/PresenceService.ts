import { getRedis } from '../config/redis';
import { UpstreamUnavailableError } from '../errors';
import { PubSubService } from './PubSubService';
import { RelationsService } from './RelationsService';

const PRESENCE_TTL_SECONDS = 60;

/** Lo que ven los demás. Un usuario invisible figura `offline`. */
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

/** Lo que elige el usuario. Vale mientras esté conectado y se guarda entre sesiones. */
export type PreferredStatus = 'online' | 'idle' | 'dnd' | 'invisible';

export const PREFERRED_STATUSES: readonly PreferredStatus[] = ['online', 'idle', 'dnd', 'invisible'];

const DEFAULT_PREFERENCE: PreferredStatus = 'online';

/** Valor de la clave de conexión: conectado y activo, o conectado sin actividad (todas sus pestañas). */
const ACTIVE = '1';
const INACTIVE = 'idle';

/** Lo que usa de Redis, para poder simularlo en los tests. */
export interface PresenceRedis {
  set(key: string, value: string): Promise<unknown>;
  /** Con GET (Redis 6.2+): devuelve el valor anterior, para avisar solo cuando cambia. */
  set(key: string, value: string, mode: 'EX', seconds: number, get: 'GET'): Promise<string | null>;
  del(key: string): Promise<number>;
  mget(keys: string[]): Promise<(string | null)[]>;
}

/** Un id tal como lo pidió el cliente y el usuario real detrás (null si no existe). */
export interface ResolvedUser {
  id: string;
  canonicalId: string;
  exists: boolean;
  suspended: boolean;
}

const presenceKey = (userId: string) => `presence:${userId}`;
const preferenceKey = (userId: string) => `presence:pref:${userId}`;

export const isPreferredStatus = (value: unknown): value is PreferredStatus =>
  typeof value === 'string' && (PREFERRED_STATUSES as readonly string[]).includes(value);

const toPreference = (value: string | null | undefined): PreferredStatus =>
  isPreferredStatus(value) ? value : DEFAULT_PREFERENCE;

/**
 * Conexión + preferencia → lo que ven los demás. Sin actividad pasa a `idle` solo quien eligió `online`:
 * No molestar e Invisible se respetan aunque no esté frente a la pantalla.
 */
const visibleStatus = (connection: string | null | undefined, preference: PreferredStatus): PresenceStatus => {
  if (!connection || preference === 'invisible') return 'offline';
  if (preference === 'online' && connection === INACTIVE) return 'idle';
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

  /**
   * Marca al usuario conectado. La renueva el heartbeat del inbox: si el socket muere, la clave vence sola.
   * Si cambió algo (recién se conecta, o pasó de activo a inactivo o al revés), avisa a quienes lo siguen.
   *
   * @param inactive todas sus pestañas en esta instancia están sin actividad
   */
  static async touch(userId: string, inactive = false): Promise<void> {
    const value = inactive ? INACTIVE : ACTIVE;
    const previous = await this.redis().set(presenceKey(userId), value, 'EX', PRESENCE_TTL_SECONDS, 'GET');
    if (previous !== value) await this.publishChange(userId);
  }

  /**
   * Se llama al cerrarse el último socket del usuario en esta instancia. Si tiene otro en otra instancia,
   * su heartbeat vuelve a crear la clave en el próximo ping. La preferencia no se toca.
   */
  static async clear(userId: string): Promise<void> {
    const deleted = await this.redis().del(presenceKey(userId));
    if (deleted > 0) await this.publishChange(userId);
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
   * Guarda el estado elegido. Sin TTL: se conserva aunque el usuario se desconecte. No avisa a nadie: eso es
   * announcePreference, aparte para que un aviso que falla no haga fallar algo que ya se guardó.
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

  /** Avisa el estado elegido a quienes siguen al usuario y a sus otras sesiones (MY_STATUS). */
  static async announcePreference(userId: string, status: PreferredStatus): Promise<void> {
    await Promise.all([
      this.publishChange(userId),
      PubSubService.publishToInbox(userId, { type: 'MY_STATUS', status }),
    ]);
  }

  /**
   * Usuario real detrás de cada id: la clave está por id canónico, pero en los canales de servidor un autor
   * puede figurar con un alias.
   *
   * @throws UpstreamUnavailableError si Auth no responde
   */
  static async resolve(userIds: string[]): Promise<ResolvedUser[]> {
    return Promise.all(
      userIds.map(async (id) => {
        const canonical = await RelationsService.getCanonical(id);
        return {
          id,
          canonicalId: canonical?.userId ?? id,
          exists: canonical !== null,
          suspended: canonical?.suspended ?? false,
        };
      })
    );
  }

  /**
   * Estado de usuarios ya resueltos, con los ids tal como los pidió el cliente. Desconectado, invisible,
   * suspendido o inexistente: `offline`.
   *
   * @throws UpstreamUnavailableError si Redis no responde
   */
  static async statusesOf(users: ResolvedUser[]): Promise<Record<string, PresenceStatus>> {
    if (users.length === 0) return {};
    const ids = users.map((user) => user.canonicalId);

    // Una sola ida a Redis: primero las claves de conexión, después las de preferencia
    let values: (string | null)[];
    try {
      values = await this.redis().mget([...ids.map(presenceKey), ...ids.map(preferenceKey)]);
    } catch (cause) {
      throw new UpstreamUnavailableError('Failed to read presence', { cause });
    }

    return Object.fromEntries(
      users.map((user, i) => {
        const connection = user.exists && !user.suspended ? values.at(i) : null;
        return [user.id, visibleStatus(connection, toPreference(values.at(users.length + i)))];
      })
    );
  }

  /**
   * Estado de cada usuario, con los ids tal como los pidió el cliente.
   *
   * @throws UpstreamUnavailableError si Auth o Redis no responden
   */
  static async getStatuses(userIds: string[]): Promise<Record<string, PresenceStatus>> {
    if (userIds.length === 0) return {};
    return this.statusesOf(await this.resolve(userIds));
  }

  /**
   * Publica el estado actual del usuario para quienes lo siguen (en cualquier instancia). `userId` ya es el
   * canónico: lo llaman el inbox y /presence/me, que pasan por canonicalUserGuard.
   */
  private static async publishChange(userId: string): Promise<void> {
    const [status] = Object.values(
      await this.statusesOf([{ id: userId, canonicalId: userId, exists: true, suspended: false }])
    );
    await PubSubService.publishPresence({ userId, status });
  }
}
