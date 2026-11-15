import { FastifyInstance } from 'fastify';
import { ChatService } from '../services/ChatService';
import { requireAuth } from '../helpers/auth';

/** Búsqueda de mensajes de un servidor por texto y/o autor (ver ADR-04). */
export default async function searchPlugin(app: FastifyInstance) {
  app.get('/servers/:serverId/messages/search', async (req) => {
    const userId = requireAuth(req);
    const { serverId } = req.params as { serverId: string };
    const { q, authorId, limit, before } = req.query as {
      q?: string;
      authorId?: string;
      limit?: string;
      before?: string;
    };

    return ChatService.searchMessages(userId, serverId, {
      query: q,
      authorId,
      limit: limit === undefined ? undefined : Number(limit),
      before,
    });
  });
}
