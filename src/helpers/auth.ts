import { FastifyRequest } from 'fastify';
import { PermissionService, ChannelAccessResult } from '../services/PermissionService';
import { RelationsService } from '../services/RelationsService';
import { ConversationService } from '../services/ConversationService';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { isDmChannel } from './directMessages';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `channelAccessGuard` once the caller is authenticated and authorized. */
    userId: string;
    /** Server that owns the requested channel, resolved during access validation. */
    serverId?: string;
    /** Whether the caller can write in the channel (they can always read once the guard passes). */
    canSend?: boolean;
    /** Whether the caller has MANAGE_MESSAGES or admin rights to delete messages of others. */
    canManageMessages?: boolean;
    /** When the caller's mute expires, if the mute is the only thing preventing them from writing. */
    mutedUntil?: Date;
    /** Full channel access result resolved during access validation. */
    channelAccess?: ChannelAccessResult;
  }
}

export function extractUserId(req: FastifyRequest): string | undefined {
  const userId = req.headers['x-user-id'];
  if (Array.isArray(userId)) {
    return userId[0];
  }
  return userId;
}

export function requireAuth(req: FastifyRequest): string {
  const userId = extractUserId(req);
  if (!userId) {
    throw new UnauthorizedError('Missing X-User-Id header');
  }
  return userId;
}

/**
 * Id real del usuario. En los DMs se guarda y se compara siempre este, nunca el `X-User-Id` crudo, que con
 * login federado puede ser un alias. Sin cuenta en Auth o con la cuenta suspendida no hay DMs.
 *
 * @throws UpstreamUnavailableError si Auth no responde
 */
export async function requireCanonicalUser(req: FastifyRequest): Promise<string> {
  const user = await RelationsService.getCanonical(requireAuth(req));
  if (!user || user.suspended) {
    throw new ForbiddenError('User cannot use direct messages');
  }
  return user.userId;
}

/** Exige permiso de VER el canal. Que pueda escribir viene en el resultado (`canSend`). */
export async function requireChannelAccess(userId: string, channelId: string): Promise<ChannelAccessResult> {
  const result = await PermissionService.getChannelAccess(userId, channelId);
  if (!result.allowed) {
    throw new ForbiddenError('User does not have permission to access this channel');
  }
  return result;
}

/**
 * `preValidation` hook for routes with a `:channelId` param. It only throws;
 * the central error handler decides the response (401/403/404/503).
 *
 * On WebSocket routes it runs BEFORE the HTTP upgrade, so rejected clients get
 * a real HTTP status and the handler can attach its listeners synchronously.
 *
 * Un `dm-…` no pasa por Core: alcanza con ser participante. `canSend` queda en true porque en un DM la
 * relación y el estado se revisan en cada envío (ConversationService), no al conectar.
 */
export async function channelAccessGuard(req: FastifyRequest): Promise<void> {
  const { channelId } = req.params as { channelId: string };

  if (isDmChannel(channelId)) {
    const canonicalId = await requireCanonicalUser(req);
    await ConversationService.requireParticipant(canonicalId, channelId);
    req.userId = canonicalId;
    req.serverId = '';
    req.canSend = true;
    req.canManageMessages = false;
    return;
  }

  const userId = requireAuth(req);
  const access = await requireChannelAccess(userId, channelId);
  req.userId = userId;
  req.serverId = access.serverId;
  req.canSend = access.canSend;
  req.mutedUntil = access.mutedUntil;
  req.canManageMessages = access.canManageMessages;
  req.channelAccess = access;
}

/** `preValidation` de las rutas de conversaciones e inbox: deja en `req.userId` el id canónico. */
export async function canonicalUserGuard(req: FastifyRequest): Promise<void> {
  req.userId = await requireCanonicalUser(req);
}
