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

/** Cambios de presencia de todos los usuarios: cada instancia se queda con los de quienes siguen sus sockets. */
export const PRESENCE_CHANNEL = 'presence-updates';

export class PubSubService {
  private static publisher: Redis | null = null;
  private static subscriber: Redis | null = null;
  private static logger: PubSubLogger = console;
  private static started = false;
  private static subscribedChannels = new Set<string>();
  private static messageHandler: ((channel: string, message: string) => void) | null = null;
  private static presenceHandler: ((rawChange: string) => void) | null = null;

  /** Quién recibe los cambios de presencia (PresenceHub.deliver). Se pasa así para no importarlo acá. */
  static setPresenceHandler(handler: ((rawChange: string) => void) | null): void {
    this.presenceHandler = handler;
  }

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

    try {
      await this.subscriber.subscribe(PRESENCE_CHANNEL);
    } catch (err) {
      // Sin esto la presencia sigue andando por polling; solo no llega al instante
      this.logger.error({ err }, 'Failed to subscribe to presence updates');
    }

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
    await this.subscriber?.unsubscribe(PRESENCE_CHANNEL).catch((err: unknown) => {
      this.logger.error({ err }, 'Failed to unsubscribe from presence updates');
    });

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

  /** Publica un cambio de presencia para todas las instancias. Sin Redis, solo le llega a esta. */
  static async publishPresence(change: unknown): Promise<void> {
    const rawChange = JSON.stringify(change);

    if (!this.started || !this.publisher) {
      this.presenceHandler?.(rawChange);
      return;
    }

    try {
      await this.publisher.publish(PRESENCE_CHANNEL, rawChange);
    } catch (err) {
      this.logger.error({ err }, 'Failed to publish presence change to Redis, delivering locally');
      this.presenceHandler?.(rawChange);
    }
  }

  private static handleIncomingMessage(channel: string, message: string): void {
    if (channel === PRESENCE_CHANNEL) {
      this.presenceHandler?.(message);
      return;
    }

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

