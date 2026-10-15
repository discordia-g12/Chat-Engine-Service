import buildApp from './app';
import { connectDB } from './config/db';
import { getRedis, disconnectRedis } from './config/redis';
import { EventConsumer } from './services/EventConsumer';

const start = async (): Promise<void> => {
  const app = buildApp();
  const port = Number(process.env.PORT) || 3000;
  const host = '0.0.0.0';

  // Connect Redis eagerly. ioredis retries on its own; while it's down /readyz
  // reports 503. Without an 'error' listener ioredis prints "Unhandled error event" on every retry.
  getRedis().on('error', (err) => app.log.warn({ err }, 'Redis connection error'));
  app.addHook('onClose', async () => {
    await disconnectRedis();
    await EventConsumer.stop();
  });

  try {
    await connectDB();
    // No bloquea: si RabbitMQ (nodo infra) no está, el chat arranca igual y el consumidor reintenta solo
    EventConsumer.start({ logger: app.log });
    await app.listen({ port, host });
    app.log.info(`Chat Engine Service listening on http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

export { start };
