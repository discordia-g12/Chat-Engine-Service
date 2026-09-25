import { FastifyInstance } from 'fastify';
import { ChatService } from '../services/ChatService';
import { requireAuth, requireChannelAccess } from '../helpers/auth';

export default async function historyPlugin(app: FastifyInstance) {
  app.get('/channels/:channelId/messages', async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const { limit = 50, before } = req.query as { limit?: number; before?: string };

    try {
      const userId = await requireAuth(req);
      await requireChannelAccess(userId, channelId);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg === 'Missing X-User-Id header') {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      if (msg === 'Channel not found') {
        return reply.status(404).send({ error: 'Channel not found' });
      }
      return reply.status(403).send({ error: 'Forbidden' });
    }

    try {
      const messages = await ChatService.getHistory(channelId, Number(limit), before);
      return reply.send({ messages });
    } catch (error) {
      app.log.error(error, 'Error fetching message history');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }
  });
}