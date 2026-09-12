import { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { Message } from '../models/Message';
import { PermissionService } from '../services/PermissionService';

export default async function websocketPlugin(app: FastifyInstance) {
  app.register(fastifyWebsocket);

  // CUANDO SE IMPLEMENTE REDIS PUB/SUB, SE REMPLAZA ESTE MAPA POR UN SUBSCRIBER
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channels = new Map<string, Set<any>>();

  app.register(async function (fastify) {
    fastify.get('/channels/:channelId/ws', { websocket: true }, (connection, req) => {
      const { channelId } = req.params as { channelId: string };

      if (!channels.has(channelId)) {
        channels.set(channelId, new Set());
      }
      channels.get(channelId)!.add(connection);

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

          // Validación de permisos (usa el mock provisorio)
          const authorIdStr = String(data.authorId);
          const hasPermission = await PermissionService.canSendMessage(authorIdStr, channelId);
          if (!hasPermission) {
            connection.send(JSON.stringify({ error: 'User does not have permission to send messages in this channel' }));
            return;
          }

          const msg = new Message({
            content: data.content,
            authorId: authorIdStr,
            channelId: channelId
          });

          try {
            await msg.validate();
          } catch (validationError) {
            const err = validationError as { errors: Record<string, { message: string }> };
            const firstKey = Object.keys(err.errors)[0];
            connection.send(JSON.stringify({ error: err.errors[firstKey].message }));
            return;
          }

          await msg.save();
          const savedMsg = msg.toObject();
          
          const payload = JSON.stringify({
            id: savedMsg._id.toString(),
            content: savedMsg.content,
            authorId: savedMsg.authorId,
            channelId: savedMsg.channelId,
            createdAt: savedMsg.createdAt
          });

          const channelClients = channels.get(channelId);
          if (channelClients) {
            for (const client of channelClients) {
              if (client.readyState === 1) {
                client.send(payload);
              }
            }
          }

        } catch {
          connection.send(JSON.stringify({ error: 'Invalid JSON payload' }));
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
