import type Redis from 'ioredis';
import { getRedis, getSubscriberRedis } from '../config/redis';
import { SessionManager } from './SessionManager';
import { inboxChannelId, isInboxChannel } from '../helpers/directMessages';

export interface PubSubLogger {
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
}

export interface PubSubOptions {
  publisher?: Redis;
  subscriber?: Redis;
  logger?: PubSubLogger;
}

const REDIS_CHANNEL_PREFIX = 'channel:';

export class PubSubService {
  private static publisher: Redis | null = null;
  private static subscriber: Redis | null = null;
  private static logger: PubSubLogger = console;
  private static started = false;
  private static subscribedChannels = new Set<string>();
  private static messageHandler: ((channel: string, message: string) => void) | null = null;

  /** Los inbox pasan por acá como un canal más, con su propia clave (`inbox:<userId>`). */
  static channelKey(channelId: string): string {
    return isInboxChannel(channelId) ? channelId : `${REDIS_CHANNEL_PREFIX}${channelId}`;
  }

  static channelIdFromKey(key: string): string | null {
    if (key.startsWith(REDIS_CHANNEL_PREFIX)) {
      return key.slice(REDIS_CHANNEL_PREFIX.length);
    }
    return isInboxChannel(key) ? key : null;
  }

  static isStarted(): boolean {
    return this.started;
  }

  static isSubscribed(channelId: string): boolean {
    return this.subscribedChannels.has(channelId);
  }

  static getSubscribedChannels(): string[] {
    return Array.from(this.subscribedChannels);
  }

  static async start(options: PubSubOptions = {}): Promise<void> {
    if (this.started) {
      return;
    }

    this.logger = options.logger ?? console;
    this.publisher = options.publisher ?? getRedis();
    this.subscriber = options.subscriber ?? getSubscriberRedis();

    this.publisher.on('error', (err) => {
      this.logger.warn({ err }, 'Redis publisher error');
    });

    this.subscriber.on('error', (err) => {
      this.logger.warn({ err }, 'Redis subscriber error');
    });

    this.messageHandler = (channel: string, message: string) => {
      this.handleIncomingMessage(channel, message);
    };

    this.subscriber.on('message', this.messageHandler);

    SessionManager.setChannelHooks({
      onChannelActive: (channelId: string) => {
        void this.subscribe(channelId);
      },
      onChannelEmpty: (channelId: string) => {
        void this.unsubscribe(channelId);
      },
      onClear: () => {
        void this.unsubscribeAll();
      },
    });

    this.started = true;

    // Resubscribe any channels that already have active sockets
    const activeChannels = SessionManager.getActiveChannelIds();
    for (const channelId of activeChannels) {
      await this.subscribe(channelId);
    }

    this.logger.info('Redis Pub/Sub service started');
  }

  static async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    SessionManager.setChannelHooks({});

    if (this.subscriber && this.messageHandler) {
      this.subscriber.removeListener('message', this.messageHandler);
    }

    await this.unsubscribeAll();

    this.messageHandler = null;
    this.publisher = null;
    this.subscriber = null;
    this.started = false;
    this.subscribedChannels.clear();
  }

  static async subscribe(channelId: string): Promise<void> {
    if (!this.started || !this.subscriber) {
      return;
    }

    if (this.subscribedChannels.has(channelId)) {
      return;
    }

    this.subscribedChannels.add(channelId);
    const key = this.channelKey(channelId);
    try {
      await this.subscriber.subscribe(key);
    } catch (err) {
      this.subscribedChannels.delete(channelId);
      this.logger.error({ err, channelId }, 'Failed to subscribe to Redis channel');
    }
  }

  static async unsubscribe(channelId: string): Promise<void> {
    if (!this.started || !this.subscriber) {
      return;
    }

    if (!this.subscribedChannels.has(channelId)) {
      return;
    }

    this.subscribedChannels.delete(channelId);
    const key = this.channelKey(channelId);
    try {
      await this.subscriber.unsubscribe(key);
    } catch (err) {
      this.logger.error({ err, channelId }, 'Failed to unsubscribe from Redis channel');
    }
  }

  static async unsubscribeAll(): Promise<void> {
    if (!this.subscriber || this.subscribedChannels.size === 0) {
      this.subscribedChannels.clear();
      return;
    }

    const keys = Array.from(this.subscribedChannels).map((c) => this.channelKey(c));
    try {
      await this.subscriber.unsubscribe(...keys);
    } catch (err) {
      this.logger.error({ err }, 'Failed to unsubscribe from all Redis channels');
    } finally {
      this.subscribedChannels.clear();
    }
  }

  static async publish(channelId: string, payload: unknown): Promise<void> {
    const rawPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);

    if (!this.started || !this.publisher) {
      // Fallback: local broadcast only
      this.broadcastToLocal(channelId, rawPayload);
      return;
    }

    const key = this.channelKey(channelId);
    try {
      await this.publisher.publish(key, rawPayload);
    } catch (err) {
      this.logger.error({ err, channelId }, 'Failed to publish message to Redis, falling back to local broadcast');
      this.broadcastToLocal(channelId, rawPayload);
    }
  }

  /** Publica en el socket por usuario, en la instancia en la que esté conectado. */
  static async publishToInbox(userId: string, payload: unknown): Promise<void> {
    await this.publish(inboxChannelId(userId), payload);
  }

  private static handleIncomingMessage(channel: string, message: string): void {
    const channelId = this.channelIdFromKey(channel);
    if (!channelId) {
      return;
    }

    this.broadcastToLocal(channelId, message);
  }

  private static broadcastToLocal(channelId: string, rawPayload: string): void {
    const clients = SessionManager.getChannelSockets(channelId);
    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(rawPayload);
      }
    }
  }
}

