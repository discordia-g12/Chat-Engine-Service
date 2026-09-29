import mongoose from 'mongoose';

export type CheckStatus = 'ok' | 'fail';

/** Minimal surface readiness needs from Redis, so tests can inject a fake. */
export interface RedisPinger {
  ping(): Promise<string>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function checkMongo(timeoutMs: number): Promise<CheckStatus> {
  // readyState alone can lag behind a dead server, so also round-trip a ping.
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) return 'fail';
  try {
    await withTimeout(db.admin().ping(), timeoutMs, 'Mongo ping');
    return 'ok';
  } catch {
    return 'fail';
  }
}

export async function checkRedis(redis: RedisPinger, timeoutMs: number): Promise<CheckStatus> {
  try {
    const reply = await withTimeout(redis.ping(), timeoutMs, 'Redis ping');
    return reply === 'PONG' ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}
