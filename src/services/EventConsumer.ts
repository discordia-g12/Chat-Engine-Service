import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { ChatService } from './ChatService';
import { NotFoundError } from '../errors';
import { PermissionService } from './PermissionService';
import { PubSubService } from './PubSubService';
import { SessionManager, type ClientSession } from './SessionManager';
import { StorageService } from './StorageService';

export interface EventPayload {
  server_id?: string;
  channel_id?: string;
  channel_ids?: string[];
  user_id?: string;
  role_id?: string;
  permissions_bitmask?: number;
  reason?: string;
  expires_at?: string;
  /** user.suspended: todas las identidades de la cuenta (la principal y sus alias federados). */
  identities?: unknown;
  [key: string]: unknown;
}

/**
 * Cierre por cuenta suspendida por la plataforma (user.suspended de Auth-User). El cliente no reintenta:
 * Kong rechaza sus tokens con 403 account-suspended.
 */
export const ACCOUNT_SUSPENDED_CLOSE_CODE = 4010;

/**
 * Cierre por servidor suspendido por la plataforma (server.suspended de Server-Roles, ADR-002 de Server-Roles).
 * El cliente no reintenta: Server-Roles le niega el acceso al canal hasta que se levante la suspensión.
 */
export const SERVER_SUSPENDED_CLOSE_CODE = 4011;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// Si al vencer un mute Server-Roles todavía lo informa (el timer se disparó apenas antes, o los relojes
// no coinciden), se vuelve a probar en su vencimiento más este margen
const MUTE_RECHECK_MARGIN_MS = 1000;

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
  /** Exchange de Auth-User (user.suspended). */
  userExchange?: string;
  queue?: string;
  logger?: ConsumerLogger;
  /** Para tests: reemplaza amqplib.connect. */
  connect?: (url: string) => Promise<ChannelModel>;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

type ResolvedOptions = Required<Omit<EventConsumerOptions, 'connect'>> & Pick<EventConsumerOptions, 'connect'>;

/** user_id más las identidades del evento, sin repetir y solo strings no vacíos. */
function suspendedIdentities(payload: EventPayload): string[] {
  const ids = new Set<string>();
  if (typeof payload.user_id === 'string' && payload.user_id) ids.add(payload.user_id);
  if (Array.isArray(payload.identities)) {
    for (const id of payload.identities) {
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return [...ids];
}

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

  /**
   * Vuelve a evaluar la escritura de las sesiones del usuario en ese servidor cuando vence el mute. Lo usan
   * `member.muted` y la apertura del WebSocket de alguien que ya estaba muteado (así un mute que vence
   * después de un reinicio del chat se levanta igual). Reemplaza un timer anterior del mismo usuario y servidor.
   */
  static scheduleMuteExpiry(userId: string, serverId: string | undefined, delayMs: number): void {
    this.clearMuteExpiry(userId, serverId);
    this.armMuteTimer(userId, serverId, Date.now() + delayMs);
  }

  private static armMuteTimer(userId: string, serverId: string | undefined, expiresAtMs: number): void {
    const key = this.muteKey(userId, serverId);
    const remaining = Math.max(expiresAtMs - Date.now(), 0);
    // setTimeout no acepta más de ~24,8 días: con un valor mayor se dispara enseguida. Un mute más largo
    // se espera por tramos.
    const timer = setTimeout(() => {
      if (remaining > MAX_TIMEOUT_MS) {
        this.armMuteTimer(userId, serverId, expiresAtMs);
        return;
      }
      this.muteTimers.delete(key);
      // Venció el mute: puede volver a escribir si su rol se lo permite
      void this.recheckSendPermission(SessionManager.getUserSessions(userId, serverId), true);
    }, Math.min(remaining, MAX_TIMEOUT_MS));
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

  /**
   * Vuelve a preguntar a Server-Roles si cada sesión puede escribir (SEND_MESSAGES, overrides del canal y
   * mute) y avisa a las que cambiaron. Una consulta por usuario y canal, aunque tenga varias pestañas.
   * Si Server-Roles no responde, las sesiones quedan como estaban, salvo que se pase `fallback`.
   */
  static async recheckSendPermission(sessions: ClientSession[], fallback?: boolean): Promise<void> {
    const groups = new Map<string, ClientSession[]>();
    for (const session of sessions) {
      const key = `${session.userId}\u0000${session.channelId}`;
      groups.set(key, [...(groups.get(key) ?? []), session]);
    }

    await Promise.all(
      Array.from(groups.values()).map(async (group) => {
        const { userId, channelId } = group[0];
        let canSend: boolean | undefined;
        try {
          const access = await PermissionService.getChannelAccess(userId, channelId);
          canSend = access.canSend;
          // Sigue muteado (p. ej. el timer del vencimiento se adelantó): volver a probar cuando venza
          if (access.mutedUntil) {
            const delayMs = Math.max(access.mutedUntil.getTime() - Date.now(), 0) + MUTE_RECHECK_MARGIN_MS;
            this.scheduleMuteExpiry(userId, group[0].serverId || undefined, delayMs);
          }
        } catch (err) {
          (this.options?.logger ?? console).warn({ err, userId, channelId }, 'Could not re-check send permission');
          canSend = fallback;
        }
        if (canSend === undefined) return;
        for (const session of group) SessionManager.setCanSend(session, canSend);
      })
    );
  }

  /**
   * Manda `{ type: 'SERVER_UPDATED', serverId }` al inbox de cada miembro. Si el servidor ya no existe no
   * hay a quién avisar; si Server-Roles no responde se descarta (no se reencola): los clientes ven el
   * cambio la próxima vez que pidan sus servidores.
   */
  static async notifyServerUpdated(serverId: string): Promise<void> {
    let userIds: string[];
    try {
      userIds = await PermissionService.getServerMemberIds(serverId);
    } catch (err) {
      if (err instanceof NotFoundError) return;
      (this.options?.logger ?? console).warn({ err, serverId }, 'Could not notify server.updated to its members');
      return;
    }
    const event = { type: 'SERVER_UPDATED', serverId };
    await Promise.all(userIds.map((userId) => PubSubService.publishToInbox(userId, event)));
  }

  static async handleEvent(routingKey: string, payload: EventPayload): Promise<void> {
    if (!payload) {
      return;
    }

    const userId = payload.user_id;
    const serverId = payload.server_id;

    // Cuenta suspendida por el staff (CA 2 de "Suspender usuario"): se cierran todas sus conexiones, en
    // cualquier servidor, DMs y bandeja, de cada una de sus identidades
    if (routingKey === 'user.suspended') {
      for (const id of suspendedIdentities(payload)) {
        SessionManager.disconnectAllSessions(id, 'Account suspended', ACCOUNT_SUSPENDED_CLOSE_CODE);
      }
      return;
    }

    // Servidor suspendido por el staff (CA 1 de "Suspender servidor completo"): se cierran todas las sesiones de
    // sus canales, de todos los miembros. DMs y bandeja no son del servidor y siguen abiertos. Los mensajes no se
    // tocan: vuelven cuando se levanta la suspensión
    if (routingKey === 'server.suspended') {
      if (serverId) SessionManager.disconnectServer(serverId, 'Server suspended', SERVER_SUSPENDED_CLOSE_CODE);
      return;
    }

    // Servidor eliminado: cerrar conexiones del servidor, borrar sus mensajes de forma permanente y avisar por inbox
    if (routingKey === 'server.deleted') {
      if (serverId) {
        SessionManager.disconnectServer(serverId, 'Server deleted', 4004);
      }
      const channelIds = Array.isArray(payload.channel_ids)
        ? (payload.channel_ids as unknown[]).filter((id): id is string => typeof id === 'string' && Boolean(id))
        : [];
      if (channelIds.length > 0) {
        await ChatService.deleteChannelsMessages(channelIds);
        for (const channelId of channelIds) {
          const channelDir = path.join(StorageService.getUploadDir(), 'attachments', channelId);
          try {
            await fs.promises.rm(channelDir, { recursive: true, force: true });
          } catch {}
        }
      }
      if (serverId && Array.isArray(payload.member_ids)) {
        const memberIds = Array.from(
          new Set((payload.member_ids as unknown[]).filter((id): id is string => typeof id === 'string' && Boolean(id)))
        );
        const event = { type: 'SERVER_DELETED', serverId };
        await Promise.all(
          memberIds.map((id) =>
            PubSubService.publishToInbox(id, event).catch((err) =>
              (this.options?.logger ?? console).warn({ err, serverId, userId: id }, 'Could not notify server.deleted to member')
            )
          )
        );
      }
      return;
    }

    // Cambió la configuración del servidor (nombre, descripción, ícono o banner): se avisa por el inbox a
    // todos los miembros conectados, estén o no en ese servidor (la barra de servidores muestra todos).
    // El evento lleva solo el id: cada cliente vuelve a pedir sus servidores (ADR-0013)
    if (routingKey === 'server.updated') {
      if (serverId) await this.notifyServerUpdated(serverId);
      return;
    }

    // Canal eliminado: cerrar conexiones del canal y borrar sus mensajes de forma permanente
    if (routingKey === 'channel.deleted') {
      const channelId = typeof payload.channel_id === 'string' ? payload.channel_id : undefined;
      if (channelId) {
        SessionManager.disconnectChannel(channelId, 'Channel deleted', 4004);
        await ChatService.deleteChannelMessages(channelId);
        const channelDir = path.join(StorageService.getUploadDir(), 'attachments', channelId);
        try {
          await fs.promises.rm(channelDir, { recursive: true, force: true });
        } catch {}
      }
      return;
    }

    // Cambió lo que puede hacer un rol (o se borró): afecta a todos los que lo tengan en el servidor
    if (routingKey === 'role.permissions_updated' || routingKey === 'role.deleted') {
      if (serverId) await this.recheckSendPermission(SessionManager.getServerSessions(serverId));
      return;
    }

    if (!userId) {
      return;
    }

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
        // Sin mute no alcanza: si su rol no tiene SEND_MESSAGES sigue sin poder escribir. Si Server-Roles
        // no responde, se habilita como antes (el envío se vuelve a chequear al reconectar)
        this.clearMuteExpiry(userId, serverId);
        await this.recheckSendPermission(SessionManager.getUserSessions(userId, serverId), true);
        break;

      case 'member.role_assigned':
      case 'member.role_removed':
        await this.recheckSendPermission(SessionManager.getUserSessions(userId, serverId));
        break;

      default:
        break;
    }
  }

  /**
   * Conecta a RabbitMQ y consume los eventos member.* y role.* de Server-Roles, y user.suspended de
   * Auth-User (exchange user.events), todos en la misma cola. No bloquea: el chat arranca
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
      userExchange: options.userExchange || process.env.RABBITMQ_USER_EXCHANGE || 'user.events',
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

  /**
   * Publica un evento en un exchange de RabbitMQ (por defecto 'server.events').
   * Si no hay canal activo o falla la publicación, registra un warning/error y retorna false.
   */
  static publish(
    routingKey: string,
    payload: Record<string, unknown>,
    exchange?: string
  ): boolean {
    if (!this.channel) {
      (this.options?.logger ?? console).warn(
        { routingKey },
        'Cannot publish event: RabbitMQ channel not connected'
      );
      return false;
    }
    const targetExchange = exchange || this.options?.exchange || 'server.events';
    try {
      const content = Buffer.from(JSON.stringify(payload));
      const messageId = typeof payload.event_id === 'string' ? payload.event_id : crypto.randomUUID();
      return this.channel.publish(targetExchange, routingKey, content, {
        persistent: true,
        contentType: 'application/json',
        messageId,
        type: routingKey,
        timestamp: Date.now(),
        headers: {
          server_id: String(payload.server_id ?? ''),
        },
      });
    } catch (err) {
      (this.options?.logger ?? console).error({ err, routingKey }, 'Failed to publish event');
      return false;
    }
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
      // Mismas opciones con las que lo declara Auth-User (topic, durable): si no coinciden, RabbitMQ cierra el canal
      await channel.assertExchange(opts.userExchange, 'topic', { durable: true });
      await channel.assertExchange(opts.exchange, 'topic', { durable: true });
      const q = await channel.assertQueue(opts.queue, { durable: true });
      await channel.bindQueue(q.queue, opts.exchange, 'member.*');
      // Cambios de permisos de un rol: hay que volver a evaluar quién puede escribir
      await channel.bindQueue(q.queue, opts.exchange, 'role.*');
      // Eliminación de servidor o canal: cerrar conexiones y borrar mensajes
      await channel.bindQueue(q.queue, opts.exchange, 'server.deleted');
      await channel.bindQueue(q.queue, opts.exchange, 'channel.deleted');
      // Cambio de nombre, descripción, ícono o banner: avisar a los miembros por el inbox
      await channel.bindQueue(q.queue, opts.exchange, 'server.updated');
      // Servidor suspendido por la plataforma: cerrar las sesiones de sus canales
      await channel.bindQueue(q.queue, opts.exchange, 'server.suspended');
      // Cuenta suspendida por la plataforma: cerrar todas sus conexiones
      await channel.bindQueue(q.queue, opts.userExchange, 'user.suspended');

      await channel.consume(q.queue, (msg: ConsumeMessage | null) => {
        if (!msg) return;
        try {
          const payload = JSON.parse(msg.content.toString());
          this.handleEvent(msg.fields.routingKey, payload).catch((err) =>
            opts.logger.error({ err, routingKey: msg.fields.routingKey }, 'Failed to handle event')
          );
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
