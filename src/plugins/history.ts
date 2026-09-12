import { FastifyInstance } from 'fastify';
import { ChatService } from '../services/ChatService';

export default async function historyPlugin(app: FastifyInstance) {
  app.get('/channels/:channelId/messages', async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const { limit = 50, before } = req.query as { limit?: number; before?: string };

    try {
      const messages = await ChatService.getHistory(channelId, Number(limit), before);
      return reply.send({ messages });
    } catch (error) {
      app.log.error(error, 'Error fetching message history');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }
  });
}