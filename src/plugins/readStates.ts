import { FastifyInstance } from 'fastify';
import { ReadStateService } from '../services/ReadStateService';
import { channelAccessGuard, requireAuth } from '../helpers/auth';

export default async function readStatesPlugin(app: FastifyInstance) {
  app.get('/unread', async (req) => {
    const userId = requireAuth(req);
    const channels = await ReadStateService.getUnread(userId);
    return { channels };
  });

  app.post('/channels/:channelId/read', { preValidation: channelAccessGuard }, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const { messageId } = (req.body ?? {}) as { messageId?: string };
    await ReadStateService.markRead(req.userId, channelId, messageId);
    return reply.status(204).send();
  });

  app.post('/read-states/read-all', async (req, reply) => {
    const userId = requireAuth(req);
    await ReadStateService.markAllRead(userId);
    return reply.status(204).send();
  });
}
