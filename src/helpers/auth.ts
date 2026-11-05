import { FastifyRequest } from 'fastify';
import { PermissionService, ChannelAccessResult } from '../services/PermissionService';
import { ForbiddenError, UnauthorizedError } from '../errors';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `channelAccessGuard` once the caller is authenticated and authorized. */
    userId: string;
    /** Server that owns the requested channel, resolved during access validation. */
    serverId?: string;
    /** Whether the caller can write in the channel (they can always read once the guard passes). */
    canSend?: boolean;
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
 */
export async function channelAccessGuard(req: FastifyRequest): Promise<void> {
  const { channelId } = req.params as { channelId: string };
  const userId = requireAuth(req);
  const access = await requireChannelAccess(userId, channelId);
  req.userId = userId;
  req.serverId = access.serverId;
  req.canSend = access.canSend;
  req.mutedUntil = access.mutedUntil;
  req.channelAccess = access;
}
