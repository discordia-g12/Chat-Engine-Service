import Fastify, { FastifyInstance } from 'fastify';
import websocketPlugin from './plugins/websocket';
import historyPlugin from './plugins/history';

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(websocketPlugin);
  app.register(historyPlugin);

  app.get('/livez', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/readyz', async () => {
    return { status: 'ready' };
  });

  return app;
}

export default buildApp;
