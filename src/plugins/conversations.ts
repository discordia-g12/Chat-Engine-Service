import { FastifyInstance } from 'fastify';
import { ConversationService } from '../services/ConversationService';
import { isPreferredStatus, PREFERRED_STATUSES, PresenceService } from '../services/PresenceService';
import { ReadStateService } from '../services/ReadStateService';
import { MessageAttachmentPayload } from '../services/ChatService';
import { canonicalUserGuard } from '../helpers/auth';
import { ValidationError } from '../errors';

const MAX_PRESENCE_USERS = 100;

export default async function conversationsPlugin(app: FastifyInstance) {
  app.register(async function (fastify) {
    fastify.addHook('preValidation', canonicalUserGuard);

    fastify.get('/conversations', async (req) => ConversationService.list(req.userId));

    fastify.put('/conversations/with/:userId', async (req) => {
      const { userId } = req.params as { userId: string };
      return ConversationService.openWith(req.userId, userId);
    });

    fastify.post('/conversations', async (req, reply) => {
      const { recipientId, content = '', attachments } = (req.body ?? {}) as {
        recipientId?: unknown;
        content?: string;
        attachments?: MessageAttachmentPayload[];
      };
      if (typeof recipientId !== 'string' || recipientId === '') {
        throw new ValidationError('recipientId is required');
      }

      const result = await ConversationService.start(req.userId, recipientId, content, attachments);
      ReadStateService.markRead(req.userId, result.conversation.id, result.message.id).catch((err) =>
        req.log.warn({ err, conversationId: result.conversation.id }, 'Failed to update sender read state')
      );

      reply.status(201);
      return result;
    });

    fastify.post('/conversations/:id/accept', async (req) => {
      const { id } = req.params as { id: string };
      return ConversationService.accept(req.userId, id);
    });

    fastify.post('/conversations/:id/decline', async (req, reply) => {
      const { id } = req.params as { id: string };
      await ConversationService.decline(req.userId, id);
      return reply.status(204).send();
    });

    fastify.post('/presence', async (req) => {
      const { userIds } = (req.body ?? {}) as { userIds?: unknown };
      if (!Array.isArray(userIds) || !userIds.every((id) => typeof id === 'string')) {
        throw new ValidationError('userIds must be a list of user ids');
      }
      if (userIds.length > MAX_PRESENCE_USERS) {
        throw new ValidationError(`userIds accepts at most ${MAX_PRESENCE_USERS} users`);
      }
      return PresenceService.getStatuses(userIds);
    });

    fastify.get('/presence/me', async (req) => ({ status: await PresenceService.getPreference(req.userId) }));

    fastify.put('/presence/me', async (req) => {
      const { status } = (req.body ?? {}) as { status?: unknown };
      if (!isPreferredStatus(status)) {
        throw new ValidationError(`status must be one of: ${PREFERRED_STATUSES.join(', ')}`);
      }
      await PresenceService.setPreference(req.userId, status);
      PresenceService.announcePreference(req.userId, status).catch((err) =>
        req.log.warn({ err, userId: req.userId }, 'Failed to announce presence')
      );
      return { status };
    });
  });
}
