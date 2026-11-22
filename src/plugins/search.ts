import { FastifyInstance, FastifyRequest } from 'fastify';
import { ChatService, MessageSearchFilters } from '../services/ChatService';
import { channelAccessGuard, extractUserId, requireAuth } from '../helpers/auth';
import { isDmChannel } from '../helpers/directMessages';

interface SearchQuery {
  q?: string;
  authorId?: string;
  limit?: string;
  before?: string;
}

function searchFilters(req: FastifyRequest): MessageSearchFilters {
  const { q, authorId, limit, before } = req.query as SearchQuery;
  return { query: q, authorId, limit: limit === undefined ? undefined : Number(limit), before };
}

/** Búsqueda de mensajes por texto y/o autor: en un servidor o en un solo canal o DM (ver ADR-04). */
export default async function searchPlugin(app: FastifyInstance) {
  app.get('/servers/:serverId/messages/search', async (req) => {
    const userId = requireAuth(req);
    const { serverId } = req.params as { serverId: string };
    return ChatService.searchMessages(userId, serverId, searchFilters(req));
  });

  // El guard es el del historial: participante en un DM, VIEW_CHANNELS en un canal de servidor
  app.get('/channels/:channelId/messages/search', { preValidation: channelAccessGuard }, async (req) => {
    const { channelId } = req.params as { channelId: string };
    const filters = searchFilters(req);

    // En un DM los mensajes se guardan con el id canónico. Con login federado el cliente puede conocerse por
    // un alias (su X-User-Id): "mis mensajes" tiene que encontrar los que guardó el canónico
    if (isDmChannel(channelId) && filters.authorId !== undefined && filters.authorId === extractUserId(req)) {
      filters.authorId = req.userId;
    }

    return ChatService.searchChannelMessages(channelId, filters);
  });
}
