import Fastify, { FastifyInstance } from 'fastify';
import websocketPlugin from './plugins/websocket';
import historyPlugin from './plugins/history';
import { registerErrorHandler } from './plugins/errorHandler';
import { getRedis } from './config/redis';
import { checkMongo, checkRedis, RedisPinger } from './config/readiness';

export interface BuildAppOptions {
  /** Redis client used by /readyz. Defaults to the shared client (created lazily). */
  redis?: RedisPinger;
  readinessTimeoutMs?: number;
}

function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? 1000;

  registerErrorHandler(app);
  app.decorateRequest('userId', '');

  app.register(websocketPlugin);
  app.register(historyPlugin);

  app.get('/livez', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/readyz', async (_req, reply) => {
    const redis = opts.redis ?? getRedis();
    const [mongo, redisStatus] = await Promise.all([
      checkMongo(readinessTimeoutMs),
      checkRedis(redis, readinessTimeoutMs),
    ]);
    const checks = { mongo, redis: redisStatus };
    const ready = mongo === 'ok' && redisStatus === 'ok';

    if (!ready) {
      app.log.warn({ checks }, 'Readiness check failed');
    }
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });

  return app;
}

export default buildApp;
