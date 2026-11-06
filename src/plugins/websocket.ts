import { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { ChatService } from '../services/ChatService';
import { SessionManager } from '../services/SessionManager';
import { EventConsumer } from '../services/EventConsumer';
import { ReadStateService } from '../services/ReadStateService';
import { PubSubService } from '../services/PubSubService';
import { ConversationService } from '../services/ConversationService';
import { PresenceService } from '../services/PresenceService';
import { canonicalUserGuard, channelAccessGuard } from '../helpers/auth';
import { inboxChannelId, isDmChannel } from '../helpers/directMessages';
import { toProblem, ValidationError, ForbiddenError } from '../errors';
import { startHeartbeat } from '../helpers/heartbeat';

export interface WebsocketPluginOptions {
  pingIntervalMs: number;
}

export default async function websocketPlugin(app: FastifyInstance, opts: WebsocketPluginOptions) {
  app.register(fastifyWebsocket);

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

            let savedPayload;
            if (isDmChannel(channelId)) {
              // Sin el canSend del socket: un bloqueo tiene que regir desde el mensaje siguiente
              savedPayload = await ConversationService.sendMessage(
                userId,
                channelId,
                data.content || '',
                data.attachments
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
                true
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

    // Socket por usuario: solo recibe (DM_MESSAGE, DM_CONVERSATION). Lo que se perdió mientras estaba
    // desconectado se recupera con GET /conversations. Si Redis falla, la presencia queda desactualizada,
    // pero los mensajes se siguen entregando.
    fastify.get('/inbox/ws', { websocket: true, preValidation: canonicalUserGuard }, (connection, req) => {
      const userId = req.userId;
      const channelId = inboxChannelId(userId);
      const logPresenceError = (err: unknown) => req.log.warn({ err, userId }, 'Failed to update presence');

      SessionManager.register({ userId, channelId, serverId: '', socket: connection, canSend: false, connectedAt: new Date() });

      const renewPresence = () => {
        PresenceService.touch(userId).catch(logPresenceError);
      };
      renewPresence();
      const stopHeartbeat = startHeartbeat(connection, opts.pingIntervalMs, renewPresence);

      connection.on('close', () => {
        stopHeartbeat();
        SessionManager.unregister(connection);
        if (SessionManager.getChannelSockets(channelId).length === 0) {
          PresenceService.clear(userId).catch(logPresenceError);
        }
      });
    });
  });
}
