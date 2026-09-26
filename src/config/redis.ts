import Redis from 'ioredis';

let client: Redis | null = null;

/**
 * Shared Redis client (lazy singleton). Created on first use; ioredis handles
 * reconnection on its own, and readiness reports whether it is actually up.
 * The pub/sub work (#1) will reuse this for PUBLISH and `duplicate()` it for SUBSCRIBE.
 */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
    });
  }
  return client;
}

export async function disconnectRedis(): Promise<void> {
  if (!client) return;
  const current = client;
  client = null;
  if (current.status === 'ready') {
    await current.quit();
  } else {
    current.disconnect();
  }
}
