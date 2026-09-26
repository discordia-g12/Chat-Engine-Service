import { FastifyInstance } from 'fastify';
import { ChatService } from '../services/ChatService';
import { channelAccessGuard } from '../helpers/auth';

export default async function historyPlugin(app: FastifyInstance) {
  app.get('/channels/:channelId/messages', { preValidation: channelAccessGuard }, async (req) => {
    const { channelId } = req.params as { channelId: string };
    const { limit = 50, before } = req.query as { limit?: number; before?: string };

    const messages = await ChatService.getHistory(channelId, Number(limit), before);
    return { messages };
  });
}