import { FastifyInstance } from 'fastify';
import { MessageAttachmentPayload } from '../services/ChatService';
import { ThreadService } from '../services/ThreadService';
import { channelAccessGuard } from '../helpers/auth';
import { ForbiddenError, ValidationError } from '../errors';

type ThreadParams = { channelId: string; messageId: string };

/** Hilos de un mensaje (ADR-07). Mismo acceso que el canal: ver alcanza para leer, `canSend` para responder. */
export default async function threadsPlugin(app: FastifyInstance) {
  app.get('/channels/:channelId/messages/:messageId/thread', { preValidation: channelAccessGuard }, async (req) => {
    const { channelId, messageId } = req.params as ThreadParams;
    const { after, limit } = req.query as { after?: string; limit?: string };

    let parsedLimit: number | undefined;
    if (limit !== undefined) {
      parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit)) throw new ValidationError('limit must be an integer');
    }
    return ThreadService.getThread(channelId, messageId, { after, limit: parsedLimit });
  });

  app.post('/channels/:channelId/messages/:messageId/thread', { preValidation: channelAccessGuard }, async (req, reply) => {
    if (req.canSend === false) {
      throw new ForbiddenError('User does not have permission to send messages in this channel');
    }

    const { channelId, messageId } = req.params as ThreadParams;
    const { content = '', attachments } = (req.body || {}) as {
      content?: string;
      attachments?: MessageAttachmentPayload[];
    };

    const { reply: saved } = await ThreadService.createReply(
      req.userId,
      channelId,
      messageId,
      content,
      attachments,
      req.serverId ?? '',
      req.log
    );
    reply.status(201);
    return saved;
  });
}
