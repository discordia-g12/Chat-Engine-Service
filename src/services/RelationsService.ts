import { UpstreamUnavailableError } from '../errors';

/** Si Auth no contesta en este tiempo, el DM no se entrega (fail closed). */
const AUTH_TIMEOUT_MS = 2000;
// El alias cambia solo al vincular una cuenta: un minuto alcanza y evita una llamada por request
const CANONICAL_TTL_MS = 60_000;
const CANONICAL_CACHE_MAX = 5000;

export interface CanonicalUser {
  userId: string;
  suspended: boolean;
}

export interface UserRelations {
  /** `exists` y `suspended` hablan del otro usuario. */
  exists: boolean;
  suspended: boolean;
  friends: boolean;
  blockedByActor: boolean;
  blockedByOther: boolean;
}

const unavailable = (detail: string) =>
  new UpstreamUnavailableError('Failed to communicate with auth service', { cause: new Error(detail) });

async function authFetch(path: string): Promise<Response> {
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:8000';
  try {
    return await fetch(`${authUrl}${path}`, { signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) });
  } catch (cause) {
    throw new UpstreamUnavailableError('Failed to communicate with auth service', { cause });
  }
}

async function readBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/** Cliente del API interno de Auth. Lo que no tenga la forma esperada se trata como Auth caído. */
export class RelationsService {
  private static canonicalCache = new Map<string, { user: CanonicalUser; expiresAt: number }>();

  static clearCache(): void {
    this.canonicalCache.clear();
  }

  /**
   * Id real del usuario (`GET /internal/users/{id}/canonical`): con login federado, `X-User-Id` puede ser
   * un alias. No se cachea el 404: la cuenta puede crearse en cualquier momento.
   *
   * @returns null si el usuario no existe
   * @throws UpstreamUnavailableError si Auth no responde o responde algo inesperado
   */
  static async getCanonical(userId: string): Promise<CanonicalUser | null> {
    const cached = this.canonicalCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    const response = await authFetch(`/internal/users/${encodeURIComponent(userId)}/canonical`);
    if (response.status === 404) return null;
    if (response.status !== 200) throw unavailable(`Auth returned unexpected status: ${response.status}`);

    const body = await readBody(response);
    if (typeof body?.user_id !== 'string' || typeof body.suspended !== 'boolean') {
      throw unavailable('Auth returned an unexpected canonical response');
    }

    const user = { userId: body.user_id, suspended: body.suspended };
    this.canonicalCache.delete(userId);
    if (this.canonicalCache.size >= CANONICAL_CACHE_MAX) {
      // Un Map recorre en orden de inserción: el primero es el más viejo
      const oldest = this.canonicalCache.keys().next().value;
      if (oldest !== undefined) this.canonicalCache.delete(oldest);
    }
    this.canonicalCache.set(userId, { user, expiresAt: Date.now() + CANONICAL_TTL_MS });
    return user;
  }

  /**
   * Relación entre dos usuarios (`GET /internal/relations`). No se cachea: un bloqueo rige desde el
   * mensaje siguiente.
   *
   * @throws UpstreamUnavailableError si Auth no responde o responde algo inesperado
   */
  static async getRelations(actorId: string, otherId: string): Promise<UserRelations> {
    const query = new URLSearchParams({ actor: actorId, other: otherId });
    const response = await authFetch(`/internal/relations?${query}`);
    if (response.status !== 200) throw unavailable(`Auth returned unexpected status: ${response.status}`);

    const body = await readBody(response);
    const flags = [body?.exists, body?.suspended, body?.friends, body?.blocked_by_actor, body?.blocked_by_other];
    if (!flags.every((flag) => typeof flag === 'boolean')) {
      throw unavailable('Auth returned an unexpected relations response');
    }
    const [exists, suspended, friends, blockedByActor, blockedByOther] = flags as boolean[];
    return { exists, suspended, friends, blockedByActor, blockedByOther };
  }
}
