import { FastifyRequest } from 'fastify';
import { PermissionService } from '../services/PermissionService';
import { ForbiddenError, UnauthorizedError } from '../errors';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `channelAccessGuard` once the caller is authenticated and authorized. */
    userId: string;
    /** Server that owns the requested channel, resolved during access validation. */
    serverId?: string;
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

export async function requireChannelAccess(userId: string, channelId: string): Promise<string | undefined> {
  const result = await PermissionService.canSendMessage(userId, channelId);
  if (!result.allowed) {
    throw new ForbiddenError('User does not have permission to access this channel');
  }
  return result.serverId;
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
  const serverId = await requireChannelAccess(userId, channelId);
  req.userId = userId;
  req.serverId = serverId;
}
