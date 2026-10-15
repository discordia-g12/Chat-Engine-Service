import { NotFoundError, UpstreamUnavailableError } from '../errors';

export interface PermissionCheckResult {
  allowed: boolean;
  serverId?: string;
}

export class PermissionService {
  /**
   * Checks if a user is allowed to send messages in a specific channel
   * by querying the Server-Roles-Core-Service.
   *
   * @returns PermissionCheckResult with allowed status and server ID
   * @throws NotFoundError if the channel does not exist
   * @throws UpstreamUnavailableError if Core is unreachable or answers unexpectedly
   */
  static async canSendMessage(userId: string, channelId: string): Promise<PermissionCheckResult> {
    if (!userId || !channelId) {
      throw new Error('User ID and Channel ID are required to check permissions');
    }

    const coreUrl = process.env.CORE_SERVICE_URL || 'http://localhost:8000';
    const url = `${coreUrl}/internal/channels/${encodeURIComponent(channelId)}/can-send?${new URLSearchParams({ user_id: userId })}`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      throw new UpstreamUnavailableError('Failed to communicate with permission service', { cause });
    }

    switch (response.status) {
      case 200: {
        let serverId: string | undefined;
        try {
          const body = (await response.json()) as { server_id?: string } | null;
          serverId = body?.server_id;
        } catch {
          serverId = undefined;
        }
        return { allowed: true, serverId };
      }
      case 403:
        return { allowed: false };
      case 404:
        throw new NotFoundError('Channel not found');
      default:
        throw new UpstreamUnavailableError('Failed to communicate with permission service', {
          cause: new Error(`Core service returned unexpected status: ${response.status}`),
        });
    }
  }
}
