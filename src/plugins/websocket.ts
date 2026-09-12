import { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { ChatService } from '../services/ChatService';

export default async function websocketPlugin(app: FastifyInstance) {
  app.register(fastifyWebsocket);
    
  // CUANDO SE IMPLEMENTE REDIS PUB/SUB, SE REMPLAZA ESTE MAPA POR UN SUBSCRIBER
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channels = new Map<string, Set<any>>();

  app.register(async function (fastify) {
    fastify.get('/channels/:channelId/ws', { websocket: true }, (connection, req) => {
      const { channelId } = req.params as { channelId: string };
      const { last_message_id_seen } = req.query as { last_message_id_seen?: string };

      if (!channels.has(channelId)) {
        channels.set(channelId, new Set());
      }
      channels.get(channelId)!.add(connection);

      if (last_message_id_seen) {
        ChatService.getMissedMessages(channelId, last_message_id_seen)
          .then((missedMessages) => {
            for (const msg of missedMessages) {
              connection.send(JSON.stringify(msg));
            }
          })
          .catch((err) => app.log.error(err, 'Failed to recover missed messages'));
      }

      connection.on('message', async (message: Buffer) => {
        try {
          const data = JSON.parse(message.toString());

          if (data.authorId !== undefined && typeof data.authorId === 'number' && data.authorId <= 0) {
            connection.send(JSON.stringify({ error: 'authorId must be positive' }));
            return;
          }
          if (data.id !== undefined && typeof data.id === 'number' && data.id <= 0) {
            connection.send(JSON.stringify({ error: 'id must be positive' }));
            return;
          }

          const savedPayload = await ChatService.sendMessage(
            String(data.authorId),
            channelId,
            data.content
          );

          const channelClients = channels.get(channelId);
          if (channelClients) {
            const rawPayload = JSON.stringify(savedPayload);
            for (const client of channelClients) {
              if (client.readyState === 1) {
                client.send(rawPayload);
              }
            }
          }
        } catch (error) {
          if (error instanceof SyntaxError) {
            connection.send(JSON.stringify({ error: 'Invalid JSON payload' }));
            return;
          }
          const mongooseErrors = (error as { errors?: Record<string, { message: string }> })?.errors;
          if (mongooseErrors) {
            const firstError = Object.values(mongooseErrors)[0];
            connection.send(JSON.stringify({ error: firstError.message }));
            return;
          }
          connection.send(JSON.stringify({ error: (error as Error).message }));
        }
      });

      connection.on('close', () => {
        const channelClients = channels.get(channelId);
        if (channelClients) {
          channelClients.delete(connection);
          if (channelClients.size === 0) {
            channels.delete(channelId);
          }
        }
      });
    });
  });
}
