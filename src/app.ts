import Fastify, { FastifyInstance } from 'fastify';
import websocketPlugin from './plugins/websocket';
import { DEFAULT_PING_INTERVAL_MS } from './helpers/heartbeat';
import { EventConsumer } from './services/EventConsumer';
import historyPlugin from './plugins/history';
import messagesPlugin from './plugins/messages';
import readStatesPlugin from './plugins/readStates';
import attachmentsPlugin from './plugins/attachments';
import conversationsPlugin from './plugins/conversations';
import internalMetricsPlugin from './plugins/internalMetrics';
import internalCallsPlugin from './plugins/internalCalls';
import { registerErrorHandler } from './plugins/errorHandler';
import { getRedis } from './config/redis';
import { checkMongo, checkRedis, RedisPinger } from './config/readiness';

export interface BuildAppOptions {
  /** Redis client used by /readyz. Defaults to the shared client (created lazily). */
  redis?: RedisPinger;
  readinessTimeoutMs?: number;
  /** Cada cuánto se pinguea cada WebSocket de canal (ver helpers/heartbeat). */
  wsPingIntervalMs?: number;
}

function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? 1000;

  registerErrorHandler(app);
  app.decorateRequest('userId', '');

  app.register(websocketPlugin, {
    pingIntervalMs: opts.wsPingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
  });
  app.register(historyPlugin);
  app.register(messagesPlugin);
  app.register(readStatesPlugin);
  app.register(attachmentsPlugin);
  app.register(conversationsPlugin);
  app.register(internalMetricsPlugin);
  app.register(internalCallsPlugin);

  app.get('/livez', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/readyz', async (_req, reply) => {
    const redis = opts.redis ?? getRedis();
    const [mongo, redisStatus] = await Promise.all([
      checkMongo(readinessTimeoutMs),
      checkRedis(redis, readinessTimeoutMs),
    ]);
    // RabbitMQ se informa pero no define "ready": sin eventos el chat sigue funcionando (los bans y
    // mutes en vivo esperan a que vuelva) y marcarlo no-ready propagaría una caída del nodo infra.
    const checks = { mongo, redis: redisStatus, rabbitmq: EventConsumer.isConnected ? 'ok' : 'disconnected' };
    const ready = mongo === 'ok' && redisStatus === 'ok';

    if (!ready) {
      app.log.warn({ checks }, 'Readiness check failed');
    }
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });

  return app;
}

export default buildApp;
