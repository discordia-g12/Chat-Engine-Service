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

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Logger mínimo, con las dos firmas del de Fastify (app.log) para que sea asignable. */
export interface ConsumerLogger {
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
}

export interface EventConsumerOptions {
  url?: string;
  exchange?: string;
  queue?: string;
  logger?: ConsumerLogger;
  /** Para tests: reemplaza amqplib.connect. */
  connect?: (url: string) => Promise<ChannelModel>;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

type ResolvedOptions = Required<Omit<EventConsumerOptions, 'connect'>> & Pick<EventConsumerOptions, 'connect'>;

export class EventConsumer {
  private static connection: ChannelModel | null = null;
  private static channel: Channel | null = null;
  private static options: ResolvedOptions | null = null;
  private static stopped = true;
  private static attempts = 0;
  private static retryTimer: NodeJS.Timeout | null = null;
  private static wakeRetry: (() => void) | null = null;
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

  /**
   * Conecta a RabbitMQ y consume los eventos member.* de Server-Roles. No bloquea: el chat arranca
   * aunque RabbitMQ (otro nodo) esté caído, y se reintenta para siempre con backoff exponencial.
   * Si la conexión se cae después, vuelve a conectar sola.
   *
   * La cola es durable: los eventos que llegan mientras el chat está desconectado quedan en RabbitMQ
   * y se aplican al reconectar. Con más de una instancia del chat, cada una necesita su propia cola
   * (RABBITMQ_QUEUE distinto); si no, cada evento le llega a una sola instancia.
   */
  static start(options: EventConsumerOptions = {}): void {
    this.options = {
      url: options.url || process.env.RABBITMQ_URL || 'amqp://admin:admin@rabbitmq:5672/',
      exchange: options.exchange || process.env.RABBITMQ_EXCHANGE || 'server.events',
      queue: options.queue || process.env.RABBITMQ_QUEUE || 'chat_engine_events',
      logger: options.logger || console,
      connect: options.connect,
      baseDelayMs: options.baseDelayMs ?? RECONNECT_BASE_MS,
      maxDelayMs: options.maxDelayMs ?? RECONNECT_MAX_MS,
    };
    this.stopped = false;
    this.attempts = 0;
    void this.connectLoop();
  }

  /** true mientras haya una conexión activa consumiendo eventos (se informa en /readyz). */
  static get isConnected(): boolean {
    return this.channel !== null;
  }

  private static async connectLoop(): Promise<void> {
    const opts = this.options;
    if (!opts) return;

    while (!this.stopped) {
      try {
        await this.connectOnce(opts);
        this.attempts = 0;
        opts.logger.info({ exchange: opts.exchange, queue: opts.queue }, 'Event consumer connected to RabbitMQ');
        return;
      } catch (err) {
        const delayMs = Math.min(opts.baseDelayMs * 2 ** this.attempts, opts.maxDelayMs);
        this.attempts += 1;
        opts.logger.warn({ err, attempt: this.attempts, delayMs }, 'RabbitMQ unavailable, retrying');
        await new Promise<void>((resolve) => {
          this.wakeRetry = resolve;
          this.retryTimer = setTimeout(resolve, delayMs);
        });
        this.retryTimer = null;
        this.wakeRetry = null;
      }
    }
  }

  private static async connectOnce(opts: ResolvedOptions): Promise<void> {
    const connect = opts.connect || (await import('amqplib')).connect;
    const conn = await connect(opts.url);

    conn.on('error', (err: Error) => opts.logger.error({ err }, 'RabbitMQ connection error'));
    conn.on('close', () => {
      this.connection = null;
      this.channel = null;
      if (this.stopped) return;
      // Corte inesperado (RabbitMQ reiniciado, red, nodo infra caído): volver a conectar
      opts.logger.warn('RabbitMQ connection closed, reconnecting');
      void this.connectLoop();
    });

    try {
      const channel = await conn.createChannel();
      await channel.assertExchange(opts.exchange, 'topic', { durable: true });
      const q = await channel.assertQueue(opts.queue, { durable: true });
      await channel.bindQueue(q.queue, opts.exchange, 'member.*');

      await channel.consume(q.queue, (msg: ConsumeMessage | null) => {
        if (!msg) return;
        try {
          const payload = JSON.parse(msg.content.toString());
          this.handleEvent(msg.fields.routingKey, payload);
          channel.ack(msg);
        } catch (err) {
          // Mensaje mal formado: no se reencola (se volvería a romper en loop)
          opts.logger.error({ err, routingKey: msg.fields.routingKey }, 'Invalid event discarded');
          channel.nack(msg, false, false);
        }
      });

      this.connection = conn;
      this.channel = channel;
    } catch (err) {
      // Falló el armado del canal: cerrar sin disparar la reconexión del handler de close
      conn.removeAllListeners('close');
      await conn.close().catch(() => undefined);
      throw err;
    }
  }

  static async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.wakeRetry?.(); // si estaba esperando para reintentar, el bucle ve stopped y termina
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
