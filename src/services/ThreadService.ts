import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Message, IMessage } from '../models/Message';
import { NotFoundError, ValidationError } from '../errors';
import { isDmChannel } from '../helpers/directMessages';
import { ChatService, MessageAttachmentPayload, MessagePayload, ThreadSummaryPayload, toPayload } from './ChatService';
import { ConversationService } from './ConversationService';
import { EventConsumer } from './EventConsumer';
import { PermissionService } from './PermissionService';
import { PubSubService } from './PubSubService';

/** Tope de participantes guardados en el raíz: acota el documento y el evento a Notification. */
export const MAX_THREAD_PARTICIPANTS = 100;
export const DEFAULT_THREAD_LIMIT = 50;
export const MAX_THREAD_LIMIT = 100;
/** Largo del texto que viaja en el evento para la notificación. */
export const PREVIEW_MAX_LENGTH = 140;

/** Se intentó abrir un hilo sobre una respuesta: los hilos tienen un solo nivel. */
export const THREAD_NESTED = 'THREAD_NESTED';

export interface ThreadPage {
  /** El mensaje raíz, siempre (CA4), aunque esté borrado. */
  parent: MessagePayload;
  /** De la más vieja a la más nueva. */
  replies: MessagePayload[];
  hasMore: boolean;
  /** Para pedir la página siguiente con `after`. */
  nextCursor: string | null;
}

export interface ThreadReplyResult {
  reply: MessagePayload;
  parent: MessagePayload;
}

interface Logger {
  warn(obj: object, msg?: string): void;
}

function isObjectIdString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value);
}

/** Texto plano de una línea para el aviso: sin saltos ni espacios repetidos. */
function toPreview(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX_LENGTH);
}

/**
 * El raíz del hilo dentro del canal. Un raíz borrado sigue valiendo (el hilo no se pierde); un mensaje del
 * sistema o una respuesta, no.
 *
 * @throws NotFoundError si no existe en ese canal
 * @throws ValidationError `THREAD_NESTED` si es una respuesta, o si es un mensaje del sistema
 */
async function findRoot(channelId: string, parentId: string): Promise<IMessage> {
  if (!isObjectIdString(parentId)) {
    throw new NotFoundError('Message not found');
  }
  const root = await Message.findOne({ _id: parentId, channelId }).lean<IMessage>();
  if (!root) {
    throw new NotFoundError('Message not found');
  }
  if (root.threadParentId) {
    throw new ValidationError('Cannot start a thread on a thread reply', { code: THREAD_NESTED });
  }
  if (root.systemEvent) {
    throw new ValidationError('Cannot start a thread on a system message');
  }
  return root;
}

/**
 * Suma la respuesta al resumen del raíz en una sola operación atómica: contador, última respuesta (con $max,
 * por si dos llegan fuera de orden) y participantes sin repetir, manteniendo los que ya estaban si se llega
 * al tope.
 */
async function addReplyToSummary(rootId: mongoose.Types.ObjectId, reply: MessagePayload, participants: string[]) {
  const replyId = new mongoose.Types.ObjectId(reply.id);
  const existing = { $ifNull: ['$thread.participantIds', []] };
  // $literal: un id mencionado puede empezar con '$' (`<@$x>`) y el pipeline lo leería como un campo
  const incoming = { $literal: [...new Set(participants)] };
  return Message.findOneAndUpdate(
    { _id: rootId },
    [
      {
        $set: {
          thread: {
            replyCount: { $add: [{ $ifNull: ['$thread.replyCount', 0] }, 1] },
            lastReplyAt: { $max: [{ $ifNull: ['$thread.lastReplyAt', reply.createdAt] }, reply.createdAt] },
            lastReplyId: { $max: [{ $ifNull: ['$thread.lastReplyId', replyId] }, replyId] },
            participantIds: {
              $slice: [
                { $concatArrays: [existing, { $setDifference: [incoming, existing] }] },
                MAX_THREAD_PARTICIPANTS,
              ],
            },
          },
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true }
  ).lean<IMessage>();
}

export class ThreadService {
  /**
   * Raíz y respuestas de un hilo, de la más vieja a la más nueva. El acceso al canal lo valida la ruta.
   *
   * @throws ValidationError si `after` o `limit` no son válidos, o el raíz es una respuesta
   * @throws NotFoundError si el raíz no está en el canal
   */
  static async getThread(
    channelId: string,
    parentId: string,
    options: { after?: string; limit?: number } = {}
  ): Promise<ThreadPage> {
    const limit = options.limit ?? DEFAULT_THREAD_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_THREAD_LIMIT) {
      throw new ValidationError(`limit must be an integer between 1 and ${MAX_THREAD_LIMIT}`);
    }
    if (options.after !== undefined && !isObjectIdString(options.after)) {
      throw new ValidationError('after must be a valid message id');
    }

    const root = await findRoot(channelId, parentId);
    const found = await Message.find({
      threadParentId: root._id,
      ...(options.after ? { _id: { $gt: new mongoose.Types.ObjectId(options.after) } } : {}),
    })
      .sort({ _id: 1 })
      .limit(limit + 1)
      .lean<IMessage[]>();

    const replies = found.slice(0, limit).map(toPayload);
    const hasMore = found.length > limit;
    return {
      parent: toPayload(root),
      replies,
      hasMore,
      nextCursor: hasMore ? replies[replies.length - 1].id : null,
    };
  }

  /**
   * Guarda una respuesta en el hilo, actualiza el resumen del raíz y la reparte: `THREAD_REPLY_CREATED` al
   * canal (y en un DM también al inbox de los dos). El aviso a Notification sale después, sin demorar la
   * respuesta. Quien llama ya validó que puede escribir en un canal de servidor (`canSend`); en un DM se
   * valida acá, como en cada envío.
   *
   * @param serverId Servidor del canal ('' en un DM), para filtrar destinatarios que ya no son miembros
   * @throws ValidationError, NotFoundError (ver findRoot); ForbiddenError en un DM bloqueado o sin aceptar
   */
  static async createReply(
    authorId: string,
    channelId: string,
    parentId: string,
    content: string,
    attachments: MessageAttachmentPayload[] | undefined,
    serverId: string,
    logger: Logger = console
  ): Promise<ThreadReplyResult> {
    const isDm = isDmChannel(channelId);
    const conversation = isDm ? await ConversationService.assertCanReplyInThread(authorId, channelId) : null;
    const root = await findRoot(channelId, parentId);

    const files = Array.isArray(attachments) ? attachments : undefined;
    const reply = await ChatService.sendMessage(authorId, channelId, content, files, true, root._id);

    const updated = await addReplyToSummary(root._id, reply, [root.authorId, authorId, ...reply.mentions.users]);
    const parent = toPayload(updated ?? root);
    const thread = parent.thread as ThreadSummaryPayload;

    const event = { type: 'THREAD_REPLY_CREATED', channelId, parentId: parent.id, reply, thread };
    await PubSubService.publish(channelId, event);
    if (conversation) {
      const inboxEvent = { ...event, type: 'DM_THREAD_REPLY_CREATED', conversationId: channelId };
      await Promise.all(conversation.participantIds.map((id) => PubSubService.publishToInbox(id, inboxEvent)));
    }

    void this.publishReplyEvent(reply, thread, serverId).catch((err) =>
      logger.warn({ err, channelId, messageId: reply.id }, 'Failed to publish the thread reply event')
    );

    return { reply, parent };
  }

  /**
   * Publica el resumen actualizado del raíz como `MESSAGE_UPDATED` (por ejemplo, después de borrar una
   * respuesta). Si el raíz ya no existe, no hace nada.
   */
  static async publishSummary(channelId: string, parentId: string): Promise<void> {
    const root = await Message.findOne({ _id: parentId, channelId }).lean<IMessage>();
    if (!root) return;
    await PubSubService.publish(channelId, { ...toPayload(root), type: 'MESSAGE_UPDATED' });
  }

  /**
   * `chat.message.created` para Notification (ADR 0017). Los destinatarios los decide Chat (quién participa);
   * Notification decide a quién avisar según sus preferencias. En un servidor se sacan los que ya no son
   * miembros: si Core no responde, no se publica (antes perder un aviso que mandárselo a quien se fue).
   */
  private static async publishReplyEvent(reply: MessagePayload, thread: ThreadSummaryPayload, serverId: string) {
    let participants = thread.participantIds.filter((id) => id !== reply.authorId);
    if (participants.length === 0) return;

    if (serverId) {
      const members = new Set(await PermissionService.getServerMemberIds(serverId));
      participants = participants.filter((id) => members.has(id));
      if (participants.length === 0) return;
    }

    // shortcut: sin outbox, una caída entre guardar y publicar pierde el aviso (no el mensaje). Ver DEUDA-TECNICA.
    EventConsumer.publish('chat.message.created', {
      event_id: crypto.randomUUID(),
      event_type: 'chat.message.created',
      server_id: serverId || null,
      channel_id: reply.channelId,
      thread_id: reply.threadParentId ?? null,
      message_id: reply.id,
      author_id: reply.authorId,
      thread_participant_ids: participants,
      mention_user_ids: reply.mentions.users,
      mention_role_ids: reply.mentions.roles,
      mention_everyone: reply.mentions.everyone,
      is_dm: !serverId,
      preview: toPreview(reply.content),
      created_at: new Date(reply.createdAt).toISOString(),
    });
  }
}
