import Redis from 'ioredis';

let client: Redis | null = null;
let subscriber: Redis | null = null;

/**
 * Shared Redis client (lazy singleton). Created on first use; ioredis handles
 * reconnection on its own, and readiness reports whether it is actually up.
 * Used for general commands, PUBLISH, and readiness ping.
 */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
    });
  }
  return client;
}

/**
 * Dedicated Redis client for pub/sub subscriptions.
 * In Redis/ioredis, a client entering subscriber mode cannot issue regular commands,
 * so a duplicated connection is required for SUBSCRIBE.
 */
export function getSubscriberRedis(): Redis {
  if (!subscriber) {
    subscriber = getRedis().duplicate();
  }
  return subscriber;
}

export async function disconnectRedis(): Promise<void> {
  const disconnectOne = async (c: Redis | null): Promise<void> => {
    if (!c) return;
    if (c.status === 'ready') {
      await c.quit();
    } else {
      c.disconnect();
    }
  };

  const currentClient = client;
  const currentSubscriber = subscriber;
  client = null;
  subscriber = null;

  await Promise.all([disconnectOne(currentClient), disconnectOne(currentSubscriber)]);
}

