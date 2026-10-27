import { NotFoundError, UpstreamUnavailableError } from '../errors';

export interface ChannelAccessResult {
  /** Puede ver el canal: abrir el WebSocket y leer el historial. */
  allowed: boolean;
  serverId?: string;
  /** Puede escribir (SEND_MESSAGES y sin mute vigente). Siempre false si `allowed` es false. */
  canSend: boolean;
  /** Cuándo vence el mute, si es lo único que le impide escribir. */
  mutedUntil?: Date;
}

interface AccessResponseBody {
  server_id?: string;
  can_send?: boolean;
  muted_until?: string | null;
}

export class PermissionService {
  /**
   * Pregunta a Server-Roles qué puede hacer el usuario en el canal
   * (`GET /internal/channels/{id}/access`).
   *
   * Ver y escribir son permisos distintos: un usuario muteado puede ver el canal (`allowed: true`)
   * pero no escribir (`canSend: false`). Si la respuesta no dice que puede escribir, se asume que no.
   *
   * @throws NotFoundError si el canal no existe
   * @throws UpstreamUnavailableError si Server-Roles no responde o responde algo inesperado
   */
  static async getChannelAccess(userId: string, channelId: string): Promise<ChannelAccessResult> {
    if (!userId || !channelId) {
      throw new Error('User ID and Channel ID are required to check permissions');
    }

    const coreUrl = process.env.CORE_SERVICE_URL || 'http://localhost:8000';
    const url = `${coreUrl}/internal/channels/${encodeURIComponent(channelId)}/access?${new URLSearchParams({ user_id: userId })}`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      throw new UpstreamUnavailableError('Failed to communicate with permission service', { cause });
    }

    switch (response.status) {
      case 200: {
        let body: AccessResponseBody | null = null;
        try {
          body = (await response.json()) as AccessResponseBody | null;
        } catch {
          body = null;
        }
        const mutedUntil = body?.muted_until ? new Date(body.muted_until) : undefined;
        return {
          allowed: true,
          serverId: body?.server_id,
          canSend: body?.can_send === true,
          mutedUntil: mutedUntil && !Number.isNaN(mutedUntil.getTime()) ? mutedUntil : undefined,
        };
      }
      case 403:
        return { allowed: false, canSend: false };
      case 404:
        throw new NotFoundError('Channel not found');
      default:
        throw new UpstreamUnavailableError('Failed to communicate with permission service', {
          cause: new Error(`Core service returned unexpected status: ${response.status}`),
        });
    }
  }
}
