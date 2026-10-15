import { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { ChatService } from '../services/ChatService';
import { SessionManager } from '../services/SessionManager';
import { channelAccessGuard } from '../helpers/auth';
import { toProblem, ValidationError, ForbiddenError } from '../errors';

export default async function websocketPlugin(app: FastifyInstance) {
  app.register(fastifyWebsocket);

  app.register(async function (fastify) {
    fastify.get(
      '/channels/:channelId/ws',
      { websocket: true, preValidation: channelAccessGuard },
      (connection, req) => {
        const { channelId } = req.params as { channelId: string };
        const { last_message_id_seen } = req.query as { last_message_id_seen?: string };
        const userId = req.userId;

        SessionManager.register({
          userId,
          channelId,
          serverId: req.serverId || '',
          socket: connection,
          canSend: true,
          connectedAt: new Date(),
        });

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

            if (!SessionManager.canSend(connection)) {
              throw new ForbiddenError('User does not have permission to send messages in this channel');
            }

            const savedPayload = await ChatService.sendMessage(userId, channelId, data.content, true);

            const channelClients = SessionManager.getChannelSockets(channelId);
            const rawPayload = JSON.stringify(savedPayload);
            for (const client of channelClients) {
              if (client.readyState === 1) {
                client.send(rawPayload);
              }
            }
          } catch (error) {
            const problem = toProblem(error);
            if (problem.status >= 500) {
              req.log.error({ err: error, channelId }, 'Failed to handle WS message');
            }
            connection.send(JSON.stringify({ error: problem.detail, status: problem.status }));
          }
        });

        connection.on('close', () => {
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
  });
}
