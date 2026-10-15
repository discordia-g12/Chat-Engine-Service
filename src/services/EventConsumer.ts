import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { SessionManager } from './SessionManager';

export interface EventPayload {
  server_id?: string;
  user_id?: string;
  role_id?: string;
  permissions_bitmask?: number;
  reason?: string;
  expires_at?: string;
  [key: string]: unknown;
}

export class EventConsumer {
  private static connection: ChannelModel | null = null;
  private static channel: Channel | null = null;
  private static muteTimers = new Map<string, NodeJS.Timeout>();

  private static muteKey(userId: string, serverId?: string): string {
    return `${userId}:${serverId || '*'}`;
  }

  private static scheduleMuteExpiry(userId: string, serverId: string | undefined, delayMs: number): void {
    const key = this.muteKey(userId, serverId);
    this.clearMuteExpiry(userId, serverId);
    const timer = setTimeout(() => {
      SessionManager.updateUserPermission(userId, true, undefined, serverId);
      this.muteTimers.delete(key);
    }, delayMs);
    timer.unref();
    this.muteTimers.set(key, timer);
  }

  static clearMuteExpiry(userId: string, serverId?: string): void {
    const key = this.muteKey(userId, serverId);
    const timer = this.muteTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.muteTimers.delete(key);
    }
  }

  static clearAllTimers(): void {
    for (const timer of this.muteTimers.values()) {
      clearTimeout(timer);
    }
    this.muteTimers.clear();
  }

  static get pendingMuteCount(): number {
    return this.muteTimers.size;
  }

  static handleEvent(routingKey: string, payload: EventPayload): void {
    if (!payload || !payload.user_id) {
      return;
    }

    const userId = payload.user_id;
    const serverId = payload.server_id;

    switch (routingKey) {
      case 'member.banned':
        SessionManager.disconnectUser(userId, payload.reason || 'Banned from server', 4003, undefined, serverId);
        break;

      case 'member.kicked':
        SessionManager.disconnectUser(userId, payload.reason || 'Kicked from server', 4002, undefined, serverId);
        break;

      case 'member.left':
        SessionManager.disconnectUser(userId, 'Member left server', 4002, undefined, serverId);
        break;

      case 'member.muted':
        SessionManager.updateUserPermission(userId, false, undefined, serverId);
        if (payload.expires_at) {
          const expiresAt = new Date(payload.expires_at);
          const delay = expiresAt.getTime() - Date.now();
          if (delay > 0) {
            this.scheduleMuteExpiry(userId, serverId, delay);
          }
        }
        break;

      case 'member.unmuted':
        SessionManager.updateUserPermission(userId, true, undefined, serverId);
        this.clearMuteExpiry(userId, serverId);
        break;

      default:
        break;
    }
  }

  static async start(
    url?: string,
    exchange?: string,
    queue?: string,
    retries = 10,
    retryDelayMs = 1500
  ): Promise<void> {
    const amqpUrl = url || process.env.RABBITMQ_URL || 'amqp://admin:admin@rabbitmq:5672/';
    const exchangeName = exchange || process.env.RABBITMQ_EXCHANGE || 'server.events';
    const queueName = queue || process.env.RABBITMQ_QUEUE || 'chat_engine_events';

    let amqplib;
    try {
      amqplib = await import('amqplib');
    } catch {
      return;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const conn = await amqplib.connect(amqpUrl);
        this.connection = conn;

        conn.on('error', () => {});
        conn.on('close', () => {
          this.connection = null;
          this.channel = null;
        });

        const channel = await conn.createChannel();
        this.channel = channel;

        await channel.assertExchange(exchangeName, 'topic', { durable: true });
        const q = await channel.assertQueue(queueName, { durable: true });

        await channel.bindQueue(q.queue, exchangeName, 'member.*');

        await channel.consume(q.queue, (msg: ConsumeMessage | null) => {
          if (!msg) return;
          try {
            const payload = JSON.parse(msg.content.toString());
            this.handleEvent(msg.fields.routingKey, payload);
            channel.ack(msg);
          } catch {
            channel.nack(msg, false, false);
          }
        });
        return;
      } catch {
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        } else {
          return;
        }
      }
    }
  }

  static async stop(): Promise<void> {
    this.clearAllTimers();
    if (this.channel) {
      try {
        await this.channel.close();
      } catch {}
      this.channel = null;
    }
    if (this.connection) {
      try {
        await this.connection.close();
      } catch {}
      this.connection = null;
    }
  }
}
