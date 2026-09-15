export class PermissionService {
  /**
   * Checks if a user is allowed to send messages in a specific channel
   * by querying the Server-Roles-Core-Service.
   * 
   * @param userId The ID of the user trying to send a message
   * @param channelId The ID of the channel
   * @returns Promise resolving to true if permitted, false otherwise
   */
  static async canSendMessage(userId: string, channelId: string): Promise<boolean> {
    if (!userId || !channelId) {
      throw new Error('User ID and Channel ID are required to check permissions');
    }

    const coreUrl = process.env.CORE_SERVICE_URL || 'http://localhost:8000';
    
    try {
      const response = await fetch(`${coreUrl}/internal/channels/${channelId}/can-send?user_id=${userId}`);
      
      if (response.status === 200) {
        return true;
      }
      
      if (response.status === 403) {
        return false;
      }
      
      if (response.status === 404) {
        throw new Error('Channel not found');
      }
      
      throw new Error(`Core service returned unexpected status: ${response.status}`);
    } catch (error) {
      if (error instanceof Error && error.message === 'Channel not found') {
        throw error;
      }
      throw new Error('Failed to communicate with permission service');
    }
  }
}
