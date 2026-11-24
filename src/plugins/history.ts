import { FastifyInstance } from 'fastify';
import { ChatService, MessageAttachmentPayload } from '../services/ChatService';
import { channelAccessGuard } from '../helpers/auth';
import { ForbiddenError } from '../errors';
import { PubSubService } from '../services/PubSubService';
import { ReadStateService } from '../services/ReadStateService';
import { ConversationService } from '../services/ConversationService';
import { isDmChannel } from '../helpers/directMessages';

export default async function historyPlugin(app: FastifyInstance) {
  app.get('/channels/:channelId/messages', { preValidation: channelAccessGuard }, async (req) => {
    const { channelId } = req.params as { channelId: string };
    const { limit, before } = req.query as { limit?: string; before?: string };

    // Sin limit, el default; con un valor que no es número, Number da NaN y getHistory responde 400
    const messages = await ChatService.getHistory(channelId, limit === undefined ? undefined : Number(limit), before);
    return { messages };
  });

  app.post('/channels/:channelId/messages', { preValidation: channelAccessGuard }, async (req, reply) => {
    if (req.canSend === false) {
      throw new ForbiddenError('User does not have permission to send messages in this channel');
    }

    const { channelId } = req.params as { channelId: string };
    const userId = req.userId;
    const { content = '', attachments, replyToId } = (req.body || {}) as {
      content?: string;
      attachments?: MessageAttachmentPayload[];
      replyToId?: string;
    };

    let savedPayload;
    if (isDmChannel(channelId)) {
      savedPayload = await ConversationService.sendMessage(userId, channelId, content, attachments, replyToId);
    } else {
      savedPayload = await ChatService.sendMessage(
        userId,
        channelId,
        content,
        attachments,
        true,
        undefined,
        replyToId,
        req.serverId
      );
      await PubSubService.publish(channelId, savedPayload);
    }
    ReadStateService.markRead(userId, channelId, savedPayload.id).catch((err) =>
      req.log.warn({ err, channelId }, 'Failed to update sender read state')
    );

    reply.status(201);
    return savedPayload;
  });
}
