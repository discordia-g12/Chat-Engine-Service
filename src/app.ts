import Fastify, { FastifyInstance } from 'fastify';

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/livez', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/readyz', async () => {
    return { status: 'ready' };
  });

  return app;
}

export default buildApp;
