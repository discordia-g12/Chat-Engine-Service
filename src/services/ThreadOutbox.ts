import mongoose from 'mongoose';
import { Message, IMessage } from '../models/Message';
import { clearSummaryPending } from './ChatService';
import { EventConsumer } from './EventConsumer';
import { PermissionService } from './PermissionService';

/** Tope de participantes guardados en el raíz: acota el documento y el evento a Notification. */
export const MAX_THREAD_PARTICIPANTS = 100;
/** Largo del texto que viaja en el evento para la notificación. */
export const PREVIEW_MAX_LENGTH = 140;
/** Cada cuánto el relay busca lo pendiente. */
export const RELAY_INTERVAL_MS = 10_000;
/** Cuántas respuestas toma por vuelta: acota el trabajo si RabbitMQ estuvo caído mucho tiempo. */
export const RELAY_BATCH = 50;
/** Backoff entre intentos: 30 s, 1 min, 2 min… hasta 30 min. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
/** Después de esto (unas 9 h con el backoff) se deja de intentar el aviso: queda en el log. */
export const MAX_ATTEMPTS = 25;

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

type ObjectId = mongoose.Types.ObjectId;

/** Texto plano de una línea para el aviso: sin saltos ni espacios repetidos. */
export function toPreview(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX_LENGTH);
}

export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_MS);
}

/** Saca el aviso del outbox (publicado, o que ya no corresponde) y el outbox entero si no queda nada. */
async function clearEvent(replyId: ObjectId): Promise<void> {
  await Message.updateOne({ _id: replyId }, { $unset: { 'outbox.eventId': 1 } });
  await Message.updateOne(
    { _id: replyId, 'outbox.eventId': { $exists: false }, 'outbox.summaryPending': { $exists: false } },
    { $unset: { outbox: 1 } }
  );
}

/** Reprograma lo que falló, con backoff. */
async function postpone(replyId: ObjectId, attempts: number): Promise<void> {
  await Message.updateOne(
    { _id: replyId },
    { $set: { 'outbox.attempts': attempts, 'outbox.nextAttemptAt': new Date(Date.now() + retryDelayMs(attempts)) } }
  );
}

/**
 * Outbox de las respuestas de hilo (ADR-07, D3 y D4). Lo pendiente va en la misma respuesta (`outbox`), escrito
 * junto con ella. ThreadService lo completa en el momento; esto lo reintenta si RabbitMQ o Server-Roles no
 * respondieron, o si el proceso se cayó en el medio.
 */
export class ThreadOutbox {
  private static timer: NodeJS.Timeout | null = null;
  private static running: Promise<void> | null = null;
  private static logger: Logger = console;

  /**
   * Recalcula el resumen del raíz desde las respuestas (D4): lo usa el relay cuando una creación o un borrado
   * quedó a mitad de camino. Cuenta las visibles, la última es la de _id más alto y los participantes se suman
   * a los que había (sin sacar a nadie). Un hilo sin respuestas pierde el resumen.
   *
   * shortcut: si justo otra respuesta suma con $inc entre el conteo y este $set, el contador queda uno arriba
   * hasta el próximo recuento. Solo pasa en la recuperación de una caída; un lock por hilo si alguna vez molesta.
   */
  static async recountSummary(rootId: ObjectId): Promise<void> {
    const root = await Message.findById(rootId).lean<IMessage>();
    if (!root) return;
    const [replyCount, last, authors] = await Promise.all([
      Message.countDocuments({ threadParentId: rootId, isDeleted: { $ne: true } }),
      Message.findOne({ threadParentId: rootId }, { _id: 1, createdAt: 1 }).sort({ _id: -1 }).lean<IMessage>(),
      Message.distinct('authorId', { threadParentId: rootId }) as Promise<string[]>,
    ]);
    if (!last) {
      await Message.updateOne({ _id: rootId }, { $unset: { thread: 1 } });
      return;
    }
    const existing = root.thread?.participantIds ?? [];
    const participantIds = [...new Set([...existing, root.authorId, ...authors])].slice(0, MAX_THREAD_PARTICIPANTS);
    await Message.updateOne(
      { _id: rootId },
      {
        $set: {
          thread: { replyCount, lastReplyAt: last.createdAt, lastReplyId: last._id, participantIds },
        },
      }
    );
  }

  /**
   * Publica `chat.message.created` de una respuesta (ADR 0017) y lo saca del outbox solo si RabbitMQ lo confirmó.
   * Los destinatarios se calculan al publicar: los participantes del raíz menos el autor y, en un servidor, sin
   * quienes ya no son miembros. Si Server-Roles no responde se reintenta después (antes que mandarle el texto
   * a quien se fue). El event_id es siempre el mismo: Notification descarta las repeticiones.
   *
   * @returns true si ya no queda aviso pendiente (publicado o que no corresponde)
   */
  static async deliver(replyId: ObjectId): Promise<boolean> {
    const reply = await Message.findById(replyId).lean<IMessage>();
    const outbox = reply?.outbox;
    if (!reply || !outbox?.eventId) return true;

    // Borrada antes de avisar, o sin raíz: no hay nada que contar
    const root = reply.threadParentId ? await Message.findById(reply.threadParentId).lean<IMessage>() : null;
    if (reply.isDeleted || !root) {
      await clearEvent(replyId);
      return true;
    }

    let participants = (root.thread?.participantIds ?? [root.authorId]).filter((id) => id !== reply.authorId);
    try {
      if (outbox.serverId && participants.length > 0) {
        const members = new Set(await PermissionService.getServerMemberIds(outbox.serverId));
        participants = participants.filter((id) => members.has(id));
      }
    } catch (err) {
      this.logger.warn({ err, messageId: replyId.toString() }, 'Thread reply event postponed: Server-Roles unavailable');
      await postpone(replyId, outbox.attempts + 1);
      return false;
    }
    if (participants.length === 0) {
      await clearEvent(replyId);
      return true;
    }

    const published = await EventConsumer.publishConfirmed('chat.message.created', {
      event_id: outbox.eventId,
      event_type: 'chat.message.created',
      server_id: outbox.serverId || null,
      channel_id: reply.channelId,
      thread_id: root._id.toString(),
      message_id: replyId.toString(),
      author_id: reply.authorId,
      thread_participant_ids: participants,
      mention_user_ids: reply.mentionUserIds ?? [],
      mention_role_ids: reply.mentionRoleIds ?? [],
      mention_everyone: reply.mentionEveryone === true,
      is_dm: !outbox.serverId,
      preview: toPreview(reply.content),
      created_at: new Date(reply.createdAt).toISOString(),
    });
    if (published) {
      await clearEvent(replyId);
      return true;
    }

    const attempts = outbox.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.logger.error({ messageId: replyId.toString(), attempts }, 'Thread reply event dropped after max attempts');
      await clearEvent(replyId);
      return true;
    }
    await postpone(replyId, attempts);
    return false;
  }

  /** Una vuelta del relay: lo vencido, de lo más viejo a lo más nuevo. */
  static async processDue(now: Date = new Date()): Promise<number> {
    const due = await Message.find(
      { outbox: { $type: 'object' }, 'outbox.nextAttemptAt': { $lte: now } },
      { _id: 1, threadParentId: 1, outbox: 1 }
    )
      .sort({ 'outbox.nextAttemptAt': 1 })
      .limit(RELAY_BATCH)
      .lean<IMessage[]>();

    for (const item of due) {
      const replyId = item._id as ObjectId;
      try {
        if (item.outbox?.summaryPending && item.threadParentId) {
          await this.recountSummary(item.threadParentId);
          await clearSummaryPending(replyId);
        }
        if (item.outbox?.eventId) {
          await this.deliver(replyId);
        } else {
          await clearEvent(replyId);
        }
      } catch (err) {
        this.logger.error({ err, messageId: replyId.toString() }, 'Thread outbox item failed');
        await postpone(replyId, (item.outbox?.attempts ?? 0) + 1).catch(() => undefined);
      }
    }
    return due.length;
  }

  /** Arranca el relay (server.ts). Una vuelta por vez: si una tarda, la siguiente espera. */
  static start(options: { logger?: Logger; intervalMs?: number } = {}): void {
    if (this.timer) return;
    this.logger = options.logger ?? console;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.processDue()
        .then(() => undefined)
        .catch((err) => this.logger.error({ err }, 'Thread outbox relay failed'))
        .finally(() => {
          this.running = null;
        });
    }, options.intervalMs ?? RELAY_INTERVAL_MS);
    this.timer.unref();
  }

  static async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
