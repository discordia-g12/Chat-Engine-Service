import { FastifyInstance, FastifyRequest } from 'fastify';
import { HydratedDocument } from 'mongoose';
import { ChatService, MessagePayload } from '../services/ChatService';
import { channelAccessGuard } from '../helpers/auth';
import { ForbiddenError } from '../errors';
import { PubSubService } from '../services/PubSubService';
import { ThreadService } from '../services/ThreadService';
import { isDmChannel, parseDmChannelId } from '../helpers/directMessages';
import { Conversation, IConversation } from '../models/Conversation';

type MessageParams = { channelId: string; messageId: string };
type ConversationDoc = HydratedDocument<IConversation>;

/** Conversación de un canal `dm-<id>`, o null si es un canal de servidor (o el DM no existe). */
async function findDmConversation(channelId: string): Promise<ConversationDoc | null> {
  if (!isDmChannel(channelId)) return null;
  const convId = parseDmChannelId(channelId);
  return convId ? Conversation.findById(convId) : null;
}

/** Avisa a los dos participantes del DM por su inbox (`DM_MESSAGE_*`). */
async function notifyDmParticipants(conv: ConversationDoc, type: string, channelId: string, message: MessagePayload) {
  const inboxEvent = { type, conversationId: channelId, message };
  await Promise.all(conv.participantIds.map((id) => PubSubService.publishToInbox(id, inboxEvent)));
}

export default async function messagesPlugin(app: FastifyInstance) {
  app.patch('/channels/:channelId/messages/:messageId', { preValidation: channelAccessGuard }, async (req) => {
    if (req.canSend === false) {
      throw new ForbiddenError('User does not have permission to edit messages in this channel');
    }

    const { channelId, messageId } = req.params as MessageParams;
    const userId = req.userId;
    const { content = '' } = (req.body || {}) as { content?: string };

    const updatedPayload = await ChatService.editMessage(userId, channelId, messageId, content, req.channelAccess);
    await PubSubService.publish(channelId, updatedPayload);

    const conv = await findDmConversation(channelId);
    if (conv) {
      if (conv.lastMessageId?.toString() === messageId) {
        conv.lastMessagePreview = content.slice(0, 200);
        await conv.save();
      }
      await notifyDmParticipants(conv, 'DM_MESSAGE_UPDATED', channelId, updatedPayload);
    }

    return updatedPayload;
  });

  app.delete('/channels/:channelId/messages/:messageId', { preValidation: channelAccessGuard }, async (req) => {
    const { channelId, messageId } = req.params as MessageParams;
    const userId = req.userId;
    const query = req.query as { reason?: string } | undefined;
    const body = req.body as { reason?: string } | undefined;
    const reason = query?.reason || body?.reason;

    const deletedPayload = await ChatService.deleteMessage(
      userId,
      channelId,
      messageId,
      req.canManageMessages ?? false,
      req.serverId,
      reason
    );
    await PubSubService.publish(channelId, deletedPayload);
    // El raíz cambió de contador: los clientes lo mergean como cualquier MESSAGE_UPDATED
    if (deletedPayload.threadParentId) {
      await ThreadService.publishSummary(channelId, deletedPayload.threadParentId);
    }

    const conv = await findDmConversation(channelId);
    if (conv) {
      if (conv.lastMessageId?.toString() === messageId) {
        conv.lastMessagePreview = '/ este mensaje fue eliminado';
        await conv.save();
      }
      await notifyDmParticipants(conv, 'DM_MESSAGE_DELETED', channelId, deletedPayload);
    }

    return deletedPayload;
  });

  app.put('/channels/:channelId/messages/:messageId/reactions', { preValidation: channelAccessGuard }, async (req) => {
    const { channelId, messageId } = req.params as MessageParams;
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

    const conv = await findDmConversation(channelId);
    if (conv) {
      await notifyDmParticipants(conv, 'DM_MESSAGE_REACTION_UPDATED', channelId, reactionPayload);
    }

    return reactionPayload;
  });

  // Fijar (PUT) y desfijar (DELETE) comparten handler. Viaja como MESSAGE_UPDATED: los clientes ya lo mergean.
  const setPinnedHandler = (pinned: boolean) => async (req: FastifyRequest) => {
    const { channelId, messageId } = req.params as MessageParams;

    const { payload, changed } = await ChatService.setPinned(
      req.userId,
      channelId,
      messageId,
      pinned,
      req.canManageMessages ?? false
    );
    if (!changed) return payload;

    await PubSubService.publish(channelId, payload);
    const conv = await findDmConversation(channelId);
    if (conv) {
      await notifyDmParticipants(conv, 'DM_MESSAGE_UPDATED', channelId, payload);
    }

    return payload;
  };

  app.put('/channels/:channelId/messages/:messageId/pin', { preValidation: channelAccessGuard }, setPinnedHandler(true));
  app.delete('/channels/:channelId/messages/:messageId/pin', { preValidation: channelAccessGuard }, setPinnedHandler(false));

  app.get('/channels/:channelId/pins', { preValidation: channelAccessGuard }, async (req) => {
    const { channelId } = req.params as { channelId: string };
    return ChatService.getPinnedMessages(channelId);
  });
}
