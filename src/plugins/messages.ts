import { FastifyInstance } from 'fastify';
import { ChatService } from '../services/ChatService';
import { channelAccessGuard } from '../helpers/auth';
import { ForbiddenError } from '../errors';
import { PubSubService } from '../services/PubSubService';
import { isDmChannel, parseDmChannelId } from '../helpers/directMessages';
import { Conversation } from '../models/Conversation';

export default async function messagesPlugin(app: FastifyInstance) {
  app.patch('/channels/:channelId/messages/:messageId', { preValidation: channelAccessGuard }, async (req) => {
    if (req.canSend === false) {
      throw new ForbiddenError('User does not have permission to edit messages in this channel');
    }

    const { channelId, messageId } = req.params as { channelId: string; messageId: string };
    const userId = req.userId;
    const { content = '' } = (req.body || {}) as { content?: string };

    const updatedPayload = await ChatService.editMessage(userId, channelId, messageId, content, req.channelAccess);
    await PubSubService.publish(channelId, updatedPayload);

    if (isDmChannel(channelId)) {
      const convId = parseDmChannelId(channelId);
      if (convId) {
        const conv = await Conversation.findById(convId);
        if (conv) {
          if (conv.lastMessageId?.toString() === messageId) {
            conv.lastMessagePreview = content.slice(0, 200);
            await conv.save();
          }
          const inboxEvent = { type: 'DM_MESSAGE_UPDATED', conversationId: channelId, message: updatedPayload };
          await Promise.all(conv.participantIds.map((id) => PubSubService.publishToInbox(id, inboxEvent)));
        }
      }
    }

    return updatedPayload;
  });

  app.delete('/channels/:channelId/messages/:messageId', { preValidation: channelAccessGuard }, async (req) => {
    const { channelId, messageId } = req.params as { channelId: string; messageId: string };
    const userId = req.userId;

    const deletedPayload = await ChatService.deleteMessage(
      userId,
      channelId,
      messageId,
      req.canManageMessages ?? false
    );
    await PubSubService.publish(channelId, deletedPayload);

    if (isDmChannel(channelId)) {
      const convId = parseDmChannelId(channelId);
      if (convId) {
        const conv = await Conversation.findById(convId);
        if (conv) {
          if (conv.lastMessageId?.toString() === messageId) {
            conv.lastMessagePreview = '/ este mensaje fue eliminado';
            await conv.save();
          }
          const inboxEvent = { type: 'DM_MESSAGE_DELETED', conversationId: channelId, message: deletedPayload };
          await Promise.all(conv.participantIds.map((id) => PubSubService.publishToInbox(id, inboxEvent)));
        }
      }
    }

    return deletedPayload;
  });

  app.put('/channels/:channelId/messages/:messageId/reactions', { preValidation: channelAccessGuard }, async (req) => {
    const { channelId, messageId } = req.params as { channelId: string; messageId: string };
    const userId = req.userId;
    const { emoji = '' } = (req.body || {}) as { emoji?: string };

    const reactionPayload = await ChatService.toggleReaction(
      userId,
      channelId,
      messageId,
      emoji,
      req.canAddReactions ?? false
    );
    await PubSubService.publish(channelId, reactionPayload);

    if (isDmChannel(channelId)) {
      const convId = parseDmChannelId(channelId);
      if (convId) {
        const conv = await Conversation.findById(convId);
        if (conv) {
          const inboxEvent = { type: 'DM_MESSAGE_REACTION_UPDATED', conversationId: channelId, message: reactionPayload };
          await Promise.all(conv.participantIds.map((id) => PubSubService.publishToInbox(id, inboxEvent)));
        }
      }
    }

    return reactionPayload;
  });
}

