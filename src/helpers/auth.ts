import { FastifyRequest } from 'fastify';
import { PermissionService } from '../services/PermissionService';

export function extractUserId(req: FastifyRequest): string | undefined {
  const userId = req.headers['x-user-id'];
  if (Array.isArray(userId)) {
    return userId[0];
  }
  return userId;
}

export async function requireAuth(req: FastifyRequest): Promise<string> {
  const userId = extractUserId(req);
  if (!userId) {
    throw new Error('Missing X-User-Id header');
  }
  return userId;
}

export async function requireChannelAccess(userId: string, channelId: string): Promise<void> {
  const canSend = await PermissionService.canSendMessage(userId, channelId);
  if (!canSend) {
    throw new Error('User does not have permission to access this channel');
  }
}
