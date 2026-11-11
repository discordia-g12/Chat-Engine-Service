import { NotFoundError, UpstreamUnavailableError } from '../errors';

export interface ChannelAccessResult {
  /** Puede ver el canal: abrir el WebSocket y leer el historial. */
  allowed: boolean;
  serverId?: string;
  /** Puede escribir (SEND_MESSAGES y sin mute vigente). Siempre false si `allowed` es false. */
  canSend: boolean;
  /** Cuándo vence el mute, si es lo único que le impide escribir. */
  mutedUntil?: Date;
  /** Tiene MENTION_EVERYONE: puede mencionar a @everyone y a roles. */
  canMentionEveryone: boolean;
  /** Roles del servidor del canal que puede mencionar (vacío sin MENTION_EVERYONE). */
  mentionableRoleIds: string[];
  /** Tiene MANAGE_MESSAGES, ADMINISTRATOR o es dueño: puede borrar mensajes ajenos. */
  canManageMessages: boolean;
  /** Tiene ADD_REACTIONS: puede agregar reacciones con emojis en el canal. */
  canAddReactions: boolean;
}

export interface VisibleChannels {
  channelIds: string[];
  /** Roles del usuario en sus servidores (sin los por defecto), para contar menciones de rol. */
  roleIds: string[];
}

interface AccessResponseBody {
  server_id?: string;
  can_send?: boolean;
  muted_until?: string | null;
  can_mention_everyone?: boolean;
  mentionable_role_ids?: unknown;
  can_manage_messages?: boolean;
  can_add_reactions?: boolean;
}

/** Una lista de strings, o vacía si no vino (Core anterior a #46) o no tiene esa forma. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

export class PermissionService {
  /**
   * Pregunta a Server-Roles qué puede hacer el usuario en el canal
   * (`GET /internal/channels/{id}/access`).
   *
   * Ver y escribir son permisos distintos: un usuario muteado puede ver el canal (`allowed: true`)
   * pero no escribir (`canSend: false`). Si la respuesta no dice que puede escribir, se asume que no. Lo
   * mismo con mencionar a @everyone o a roles.
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
          canMentionEveryone: body?.can_mention_everyone === true,
          mentionableRoleIds: body?.can_mention_everyone === true ? stringList(body?.mentionable_role_ids) : [],
          canManageMessages: body?.can_manage_messages === true,
          canAddReactions: body?.can_add_reactions === true,
        };
      }
      case 403:
        return { allowed: false, canSend: false, canMentionEveryone: false, mentionableRoleIds: [], canManageMessages: false, canAddReactions: false };
      case 404:
        throw new NotFoundError('Channel not found');
      default:
        throw new UpstreamUnavailableError('Failed to communicate with permission service', {
          cause: new Error(`Core service returned unexpected status: ${response.status}`),
        });
    }
  }

  /**
   * Canales de texto que el usuario puede ver en todos sus servidores, y sus roles
   * (`GET /internal/users/{id}/visible-channels`). Los no leídos se calculan solo sobre estos, así no se
   * confía en la lista que mande el cliente. Si Core no manda `role_ids` (versión anterior a #46), se
   * toman como vacíos: solo cuentan las menciones directas y @everyone.
   *
   * @throws UpstreamUnavailableError si Server-Roles no responde o responde algo inesperado
   */
  static async getVisibleChannels(userId: string): Promise<VisibleChannels> {
    if (!userId) {
      throw new Error('User ID is required to list visible channels');
    }

    const coreUrl = process.env.CORE_SERVICE_URL || 'http://localhost:8000';
    const url = `${coreUrl}/internal/users/${encodeURIComponent(userId)}/visible-channels`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      throw new UpstreamUnavailableError('Failed to communicate with permission service', { cause });
    }

    let body: { channel_ids?: unknown; role_ids?: unknown } | null = null;
    if (response.status === 200) {
      try {
        body = (await response.json()) as { channel_ids?: unknown; role_ids?: unknown } | null;
      } catch {
        body = null;
      }
    }
    const channelIds = body?.channel_ids;
    if (!Array.isArray(channelIds) || !channelIds.every((id) => typeof id === 'string')) {
      throw new UpstreamUnavailableError('Failed to communicate with permission service', {
        cause: new Error(`Core service returned an unexpected visible-channels response (status ${response.status})`),
      });
    }
    return { channelIds, roleIds: stringList(body?.role_ids) };
  }

  /**
   * Ids de todos los miembros del servidor (`GET /internal/servers/{id}/member-ids`), para avisarles por el
   * inbox un cambio de configuración (server.updated).
   *
   * @throws NotFoundError si el servidor ya no existe (p. ej. se borró antes de procesar el evento)
   * @throws UpstreamUnavailableError si Server-Roles no responde o responde algo inesperado
   */
  static async getServerMemberIds(serverId: string): Promise<string[]> {
    if (!serverId) {
      throw new Error('Server ID is required to list its members');
    }

    const coreUrl = process.env.CORE_SERVICE_URL || 'http://localhost:8000';
    const url = `${coreUrl}/internal/servers/${encodeURIComponent(serverId)}/member-ids`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      throw new UpstreamUnavailableError('Failed to communicate with permission service', { cause });
    }

    if (response.status === 404) {
      throw new NotFoundError('Server not found');
    }

    let body: { user_ids?: unknown } | null = null;
    if (response.status === 200) {
      try {
        body = (await response.json()) as { user_ids?: unknown } | null;
      } catch {
        body = null;
      }
    }
    const userIds = body?.user_ids;
    if (!Array.isArray(userIds) || !userIds.every((id) => typeof id === 'string')) {
      throw new UpstreamUnavailableError('Failed to communicate with permission service', {
        cause: new Error(`Core service returned an unexpected member-ids response (status ${response.status})`),
      });
    }
    return userIds;
  }
}
