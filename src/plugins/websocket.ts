import { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { ChatService } from '../services/ChatService';
import { SessionManager } from '../services/SessionManager';
import { EventConsumer } from '../services/EventConsumer';
import { ReadStateService } from '../services/ReadStateService';
import { PubSubService } from '../services/PubSubService';
import { ConversationService } from '../services/ConversationService';
import { ThreadService } from '../services/ThreadService';
import { PresenceService } from '../services/PresenceService';
import { MAX_WATCHED_USERS, PresenceHub } from '../services/PresenceHub';
import { canonicalUserGuard, channelAccessGuard } from '../helpers/auth';
import { inboxChannelId, isDmChannel } from '../helpers/directMessages';
import { toProblem, ValidationError, ForbiddenError } from '../errors';
import { startHeartbeat } from '../helpers/heartbeat';

export interface WebsocketPluginOptions {
  pingIntervalMs: number;
}

/** Lo que el cliente puede mandar por el inbox (lo demás se ignora). */
type InboxClientMessage =
  | { type: 'PRESENCE_SUBSCRIBE'; userIds: string[] }
  | { type: 'ACTIVITY'; idle: boolean };

function parseInboxMessage(raw: unknown): InboxClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (
    message.type === 'PRESENCE_SUBSCRIBE' &&
    Array.isArray(message.userIds) &&
    message.userIds.length <= MAX_WATCHED_USERS &&
    message.userIds.every((id) => typeof id === 'string' && id !== '')
  ) {
    return { type: 'PRESENCE_SUBSCRIBE', userIds: message.userIds as string[] };
  }
  if (message.type === 'ACTIVITY' && typeof message.idle === 'boolean') {
    return { type: 'ACTIVITY', idle: message.idle };
  }
  return null;
}

/** Sin actividad solo si todas sus pestañas en esta instancia lo están. */
function isUserInactive(channelId: string): boolean {
  const sessions = SessionManager.getChannelSockets(channelId).map((socket) => SessionManager.getSession(socket));
  return sessions.length > 0 && sessions.every((session) => session?.inactive === true);
}

export default async function websocketPlugin(app: FastifyInstance, opts: WebsocketPluginOptions) {
  app.register(fastifyWebsocket);

  // Los cambios de presencia (de esta instancia o de otra, por Redis) van a los sockets que los siguen
  PubSubService.setPresenceHandler((rawChange) => PresenceHub.deliver(rawChange));
  app.addHook('onClose', async () => {
    PubSubService.setPresenceHandler(null);
    PresenceHub.clear();
  });

  app.register(async function (fastify) {
    fastify.get(
      '/channels/:channelId/ws',
      { websocket: true, preValidation: channelAccessGuard },
      (connection, req) => {
        const { channelId } = req.params as { channelId: string };
        const { last_message_id_seen } = req.query as { last_message_id_seen?: string };
        const userId = req.userId;
        const serverId = req.serverId || '';
        const canSend = req.canSend === true;

        SessionManager.register({
          userId,
          channelId,
          serverId,
          socket: connection,
          canSend,
          connectedAt: new Date(),
        });

        if (!canSend) {
          connection.send(JSON.stringify({ type: 'PERMISSIONS_UPDATED', canSend: false, channelId }));
          if (req.mutedUntil) {
            EventConsumer.scheduleMuteExpiry(userId, serverId, Math.max(req.mutedUntil.getTime() - Date.now(), 0));
          }
        }
        const stopHeartbeat = startHeartbeat(connection, opts.pingIntervalMs);

        connection.on('message', async (message: Buffer) => {
          try {
            let data;
            try {
              data = JSON.parse(message.toString());
            } catch {
              throw new ValidationError('Invalid JSON payload');
            }

            if (data.id !== undefined && typeof data.id === 'number' && data.id <= 0) {
              throw new ValidationError('id must be positive');
            }

            // Respuesta de hilo (ADR-07): no va al canal ni marca el canal como leído
            if (data.threadParentId !== undefined) {
              if (typeof data.threadParentId !== 'string') {
                throw new ValidationError('threadParentId must be a message id');
              }
              if (!isDmChannel(channelId) && !SessionManager.canSend(connection)) {
                throw new ForbiddenError('User does not have permission to send messages in this channel');
              }
              await ThreadService.createReply(
                userId,
                channelId,
                data.threadParentId,
                data.content || '',
                data.attachments,
                serverId,
                req.log,
                data.replyToId
              );
              return;
            }

            let savedPayload;
            if (isDmChannel(channelId)) {
              // Sin el canSend del socket: un bloqueo tiene que regir desde el mensaje siguiente
              savedPayload = await ConversationService.sendMessage(
                userId,
                channelId,
                data.content || '',
                data.attachments,
                data.replyToId
              );
            } else {
              if (!SessionManager.canSend(connection)) {
                throw new ForbiddenError('User does not have permission to send messages in this channel');
              }

              savedPayload = await ChatService.sendMessage(
                userId,
                channelId,
                data.content || '',
                data.attachments,
                true,
                undefined,
                data.replyToId,
                serverId
              );

              await PubSubService.publish(channelId, savedPayload);
            }

            ReadStateService.markRead(userId, channelId, savedPayload.id).catch((err) =>
              req.log.warn({ err, channelId }, 'Failed to update the sender read state')
            );
          } catch (error) {
            const problem = toProblem(error);
            if (problem.status >= 500) {
              req.log.error({ err: error, channelId }, 'Failed to handle WS message');
            }
            connection.send(
              JSON.stringify({
                error: problem.detail,
                status: problem.status,
                ...(problem.code ? { code: problem.code } : {}),
              })
            );
          }
        });

        connection.on('close', () => {
          stopHeartbeat();
          SessionManager.unregister(connection);
        });

        if (last_message_id_seen) {
          ChatService.getMissedMessages(channelId, last_message_id_seen)
            .then((missedMessages) => {
              for (const msg of missedMessages) {
                connection.send(JSON.stringify(msg));
              }
            })
            .catch((err) => app.log.error(err, 'Failed to recover missed messages'));
        }
      }
    );

    // Socket por usuario: recibe DM_MESSAGE, DM_CONVERSATION, PRESENCE_UPDATE, etc. Lo único que manda el
    // cliente es a quién sigue (PRESENCE_SUBSCRIBE) y si hay actividad (ACTIVITY). Lo que se perdió mientras
    // estaba desconectado se recupera con GET /conversations. Si Redis falla, la presencia queda
    // desactualizada, pero los mensajes se siguen entregando.
    fastify.get('/inbox/ws', { websocket: true, preValidation: canonicalUserGuard }, (connection, req) => {
      const userId = req.userId;
      const channelId = inboxChannelId(userId);
      const logPresenceError = (err: unknown) => req.log.warn({ err, userId }, 'Failed to update presence');

      SessionManager.register({ userId, channelId, serverId: '', socket: connection, canSend: false, connectedAt: new Date() });

      const renewPresence = () => {
        PresenceService.touch(userId, isUserInactive(channelId)).catch(logPresenceError);
      };
      renewPresence();
      const stopHeartbeat = startHeartbeat(connection, opts.pingIntervalMs, renewPresence);

      connection.on('message', (raw: unknown) => {
        const message = parseInboxMessage(raw);
        if (!message) return;

        if (message.type === 'ACTIVITY') {
          const session = SessionManager.getSession(connection);
          if (!session || session.inactive === message.idle) return;
          session.inactive = message.idle;
          renewPresence();
          return;
        }

        PresenceHub.watch(connection, message.userIds)
          .then((statuses) => {
            if (statuses && connection.readyState === 1) {
              connection.send(JSON.stringify({ type: 'PRESENCE_SNAPSHOT', statuses }));
            }
          })
          .catch(logPresenceError);
      });

      connection.on('close', () => {
        stopHeartbeat();
        PresenceHub.unwatch(connection);
        SessionManager.unregister(connection);
        if (SessionManager.getChannelSockets(channelId).length === 0) {
          PresenceService.clear(userId).catch(logPresenceError);
        } else {
          // Si se fue la única pestaña activa, las que quedan pueden estar sin actividad
          renewPresence();
        }
      });
    });
  });
}
