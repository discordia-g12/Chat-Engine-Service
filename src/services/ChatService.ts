import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Message, IMessage, IReplyTo, IThreadOutbox, SystemEvent } from '../models/Message';
import { ReadState } from '../models/ReadState';
import { ChannelAccessResult, PermissionService } from './PermissionService';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { parseMentions } from '../helpers/mentions';
import { isDmChannel } from '../helpers/directMessages';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_LENGTH,
  buildContainsPattern,
} from '../helpers/search';
import { EventConsumer } from './EventConsumer';
import { ThreadOutbox } from './ThreadOutbox';

/** Menciones que notifican. Un @everyone o un rol sin permiso queda en el texto pero no acá. */
export interface MessageMentions {
  users: string[];
  roles: string[];
  everyone: boolean;
}

export interface MessageAttachmentPayload {
  id: string;
  name: string;
  url: string;
  size: number;
  contentType: string;
}

export interface MessageReactionPayload {
  emoji: string;
  count: number;
  users: string[];
  emojiId?: string;
}

export interface MessagePayload {
  id: string;
  content: string;
  authorId: string;
  channelId: string;
  createdAt: Date;
  mentions: MessageMentions;
  attachments?: MessageAttachmentPayload[];
  reactions?: MessageReactionPayload[];
  edited?: boolean;
  editedAt?: Date | null;
  isDeleted?: boolean;
  deletedAt?: Date | null;
  pinned: boolean;
  pinnedAt?: Date | null;
  pinnedBy?: string | null;
  type?: string;
  /** Mensaje del sistema (`type: 'system'`): qué pasó y a quién. La interfaz arma el texto con su nombre actual. */
  system?: { event: SystemEvent; userId: string };
  /** Respuesta de hilo: id del mensaje raíz (ADR-07). */
  threadParentId?: string;
  /** Raíz de un hilo: cuántas respuestas tiene y cuándo fue la última. */
  thread?: ThreadSummaryPayload;
  /** Mensaje citado (responder citando). `deleted`: el original se borró y ya no tiene texto. */
  replyTo?: { id: string; authorId: string; content: string; deleted?: boolean };
}

export interface ThreadSummaryPayload {
  replyCount: number;
  lastReplyAt: Date;
  lastReplyId: string;
  participantIds: string[];
  replierIds: string[];
}

/** Largo de la copia del texto citado: alcanza para la vista previa de una línea. */
export const REPLY_PREVIEW_MAX_LENGTH = 200;

/**
 * Copia del mensaje al que se responde. Tiene que estar en el mismo canal y en la misma conversación: en el
 * chat principal, un mensaje del canal; en un hilo, el raíz o una de sus respuestas. Ni borrado ni del sistema.
 *
 * @throws ValidationError si el id no es válido o el mensaje está en otra conversación
 * @throws NotFoundError si no existe en el canal o está borrado
 */
async function resolveReplyTo(
  channelId: string,
  replyToId: unknown,
  threadParentId?: mongoose.Types.ObjectId
): Promise<IReplyTo> {
  if (!isObjectIdString(replyToId)) {
    throw new ValidationError('replyToId must be a message id');
  }
  const target = await Message.findOne(
    { _id: replyToId, channelId, isDeleted: { $ne: true }, systemEvent: { $exists: false } },
    { authorId: 1, content: 1, threadParentId: 1 }
  ).lean<IMessage>();
  if (!target) {
    throw new NotFoundError('The message being replied to does not exist');
  }
  const targetId = target._id as mongoose.Types.ObjectId;
  const sameConversation = threadParentId
    ? targetId.equals(threadParentId) || target.threadParentId?.equals(threadParentId) === true
    : !target.threadParentId;
  if (!sameConversation) {
    throw new ValidationError('Cannot reply to a message from another conversation');
  }
  return { id: targetId, authorId: target.authorId, content: (target.content ?? '').slice(0, REPLY_PREVIEW_MAX_LENGTH) };
}

/**
 * Cuánto espera el relay antes de tomar algo del outbox: lo normal es que ThreadService lo complete en el
 * momento, y así no lo hacen los dos a la vez.
 */
export const OUTBOX_GRACE_MS = 15_000;

/**
 * El resumen del raíz ya refleja esta respuesta: se saca la marca y, si no queda nada pendiente, el outbox
 * entero (el índice parcial deja de verla).
 */
export async function clearSummaryPending(replyId: mongoose.Types.ObjectId): Promise<void> {
  await Message.updateOne({ _id: replyId }, { $unset: { 'outbox.summaryPending': 1 } });
  await Message.updateOne(
    { _id: replyId, 'outbox.eventId': { $exists: false }, 'outbox.summaryPending': { $exists: false } },
    { $unset: { outbox: 1 } }
  );
}

/** Historial (C4): por página, 50 por defecto y hasta 100; `?limit=1000000` le pedía todo el canal a Atlas M0. */
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 100;
/** Lo que se repone al reconectar: los más recientes. Si faltan más, el cliente los pide con el historial. */
export const MAX_MISSED_MESSAGES = 100;

/** Máximo de mensajes fijados por canal o DM. */
export const PINNED_LIMIT = 50;

export interface MessageSearchFilters {
  /** Texto a buscar dentro del contenido. */
  query?: string;
  /** Solo mensajes de este autor (su X-User-Id). */
  authorId?: string;
  limit?: number;
  /** Cursor: id del último mensaje de la página anterior. */
  before?: string;
}

export interface MessageSearchPage {
  /** Del más nuevo al más viejo. Vacío si no hay coincidencias. */
  messages: MessagePayload[];
  hasMore: boolean;
  nextCursor: string | null;
}

// Los ids de servidor de Core son UUID: otra cosa haría que Core responda 422 (y acá sería un 503)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ObjectId de 24 caracteres hex (isValid de mongoose también acepta strings de 12 bytes cualquiera). */
function isObjectIdString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value);
}

/** Filtros de búsqueda ya validados: el término recortado, el autor y el cursor como ObjectId. */
interface NormalizedSearch {
  term: string;
  authorId: string;
  limit: number;
  before?: mongoose.Types.ObjectId;
}

/** @throws ValidationError si no hay término ni autor, o algún filtro no es válido */
function normalizeSearchFilters(filters: MessageSearchFilters): NormalizedSearch {
  const term = typeof filters.query === 'string' ? filters.query.trim() : '';
  const authorId = typeof filters.authorId === 'string' ? filters.authorId.trim() : '';
  const limit = filters.limit ?? DEFAULT_SEARCH_LIMIT;

  if (!term && !authorId) {
    throw new ValidationError('A search term (q) or an author (authorId) is required');
  }
  if (term.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new ValidationError(`The search term cannot exceed ${MAX_SEARCH_QUERY_LENGTH} characters`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`);
  }
  if (filters.before !== undefined && !isObjectIdString(filters.before)) {
    throw new ValidationError('before must be a valid message id');
  }
  return {
    term,
    authorId,
    limit,
    ...(filters.before ? { before: new mongoose.Types.ObjectId(filters.before) } : {}),
  };
}

/** Una página de resultados en esos canales, del más nuevo al más viejo, sin los borrados. */
async function findSearchPage(channelIds: string[], search: NormalizedSearch): Promise<MessageSearchPage> {
  if (channelIds.length === 0) {
    return { messages: [], hasMore: false, nextCursor: null };
  }

  const query = {
    channelId: channelIds.length === 1 ? channelIds[0] : { $in: channelIds },
    isDeleted: { $ne: true },
    // "se unió …" no es un mensaje de nadie: no aparece buscando por texto ni por autor
    systemEvent: { $exists: false },
    ...(search.term ? { content: { $regex: buildContainsPattern(search.term), $options: 'i' } } : {}),
    ...(search.authorId ? { authorId: search.authorId } : {}),
    ...(search.before ? { _id: { $lt: search.before } } : {}),
  };

  // Uno de más para saber si hay otra página sin contar todo
  const found = await Message.find(query).sort({ _id: -1 }).limit(search.limit + 1).lean<IMessage[]>();
  const page = found.slice(0, search.limit).map(toPayload);
  const hasMore = found.length > search.limit;

  return { messages: page, hasMore, nextCursor: hasMore ? page[page.length - 1].id : null };
}

/** Lo que excluye las respuestas de hilo de las consultas del canal (historial, reconexión, no leídos). */
export const NOT_A_THREAD_REPLY = { threadParentId: { $exists: false } } as const;

export function toPayload(msg: IMessage): MessagePayload {
  const isDeleted = msg.isDeleted === true;
  return {
    id: msg._id.toString(),
    content: isDeleted ? '' : msg.content,
    authorId: msg.authorId,
    channelId: msg.channelId,
    createdAt: msg.createdAt,
    mentions: isDeleted
      ? { users: [], roles: [], everyone: false }
      : {
          users: msg.mentionUserIds ?? [],
          roles: msg.mentionRoleIds ?? [],
          everyone: msg.mentionEveryone === true,
        },
    ...(msg.edited && !isDeleted ? { edited: true, editedAt: msg.editedAt ?? null } : {}),
    ...(msg.attachments && msg.attachments.length > 0 && !isDeleted
      ? {
          attachments: msg.attachments.map((att) => ({
            id: att.id,
            name: att.name,
            url: att.url,
            size: att.size,
            contentType: att.contentType,
          })),
        }
      : {}),
    reactions: msg.reactions && msg.reactions.length > 0 && !isDeleted
      ? msg.reactions.map((r) => ({
          emoji: r.emoji,
          count: r.count ?? r.users.length,
          users: r.users ?? [],
          ...(r.emojiId ? { emojiId: r.emojiId } : {}),
        }))
      : [],
    // Siempre viaja `pinned` (también en false) para que un desfijado pise el estado del cliente.
    pinned: msg.pinned === true && !isDeleted,
    ...(msg.pinned && !isDeleted ? { pinnedAt: msg.pinnedAt ?? null, pinnedBy: msg.pinnedBy ?? null } : {}),
    ...(msg.systemEvent && !isDeleted ? { type: 'system', system: { event: msg.systemEvent, userId: msg.authorId } } : {}),
    ...(isDeleted ? { type: 'deleted', isDeleted: true, deletedAt: msg.deletedAt ?? null } : {}),
    ...(msg.threadParentId ? { threadParentId: msg.threadParentId.toString() } : {}),
    // También en un raíz borrado: el hilo sigue accesible ("mensaje eliminado · 3 respuestas")
    ...(msg.thread
      ? {
          thread: {
            replyCount: msg.thread.replyCount,
            lastReplyAt: msg.thread.lastReplyAt,
            lastReplyId: msg.thread.lastReplyId.toString(),
            participantIds: msg.thread.participantIds ?? [],
            replierIds: msg.thread.replierIds ?? [],
          },
        }
      : {}),
    ...(msg.replyTo && !isDeleted
      ? {
          replyTo: {
            id: msg.replyTo.id.toString(),
            authorId: msg.replyTo.authorId,
            content: msg.replyTo.content ?? '',
            ...(msg.replyTo.deleted ? { deleted: true } : {}),
          },
        }
      : {}),
  };
}

export class ChatService {
  /**
   * Retrieves paginated message history for a channel in chronological order.
   *
   * @param channelId Target channel identifier
   * @param limit Maximum number of messages to fetch (default: 50, hasta MAX_HISTORY_LIMIT)
   * @param before Optional message ID cursor to load older messages
   * @throws ValidationError si `limit` no es un entero entre 1 y MAX_HISTORY_LIMIT, o `before` no es un id
   */
  static async getHistory(
    channelId: string,
    limit = DEFAULT_HISTORY_LIMIT,
    before?: string
  ): Promise<MessagePayload[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
      throw new ValidationError(`limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`);
    }
    if (before !== undefined && !isObjectIdString(before)) {
      throw new ValidationError('before must be a valid message id');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = { channelId, ...NOT_A_THREAD_REPLY };

    if (before) {
      query._id = { $lt: new mongoose.Types.ObjectId(before) };
    }

    const messages = await Message.find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .lean<IMessage[]>();

    return messages.reverse().map(toPayload);
  }

  /**
   * Busca mensajes de un servidor por texto, por autor o por las dos cosas (ver ADR-04). Solo en los canales
   * de texto que el usuario puede ver: la lista la da Core, nunca el cliente. Los mensajes borrados no
   * aparecen. Los resultados van del más nuevo al más viejo; `before` es el `nextCursor` de la página anterior.
   *
   * @throws ValidationError si no hay término ni autor, o algún filtro no es válido
   * @throws UpstreamUnavailableError si Core no responde
   */
  static async searchMessages(userId: string, serverId: string, filters: MessageSearchFilters): Promise<MessageSearchPage> {
    if (!UUID.test(serverId)) {
      throw new ValidationError('serverId must be a valid server id');
    }
    const search = normalizeSearchFilters(filters);

    const { channelIds } = await PermissionService.getVisibleChannels(userId, serverId);
    return findSearchPage(channelIds, search);
  }

  /**
   * Busca dentro de un solo canal, con los mismos filtros y la misma paginación que la del servidor. Es la
   * búsqueda de un DM (`dm-…`, ADR-04): el acceso lo valida la ruta (channelAccessGuard), igual que el historial.
   *
   * @throws ValidationError si no hay término ni autor, o algún filtro no es válido
   */
  static async searchChannelMessages(channelId: string, filters: MessageSearchFilters): Promise<MessageSearchPage> {
    return findSearchPage([channelId], normalizeSearchFilters(filters));
  }

  /**
   * Retrieves messages missed during temporary client disconnection, in chronological order. Como mucho los
   * MAX_MISSED_MESSAGES más recientes (C4): un corte largo en un canal muy activo no trae todo de una vez, y el
   * resto se pide con el historial. Un id que no es un ObjectId no repone nada.
   *
   * @param channelId Target channel identifier
   * @param lastMessageIdSeen Message ID cursor provided by client handshake
   */
  static async getMissedMessages(
    channelId: string,
    lastMessageIdSeen: string
  ): Promise<MessagePayload[]> {
    if (!isObjectIdString(lastMessageIdSeen)) {
      return [];
    }
    const lastSeen = await Message.findById(lastMessageIdSeen).lean<IMessage>();
    if (!lastSeen) {
      return [];
    }

    const missedMessages = await Message.find({
      channelId,
      ...NOT_A_THREAD_REPLY,
      _id: { $gt: new mongoose.Types.ObjectId(lastMessageIdSeen) },
    })
      .sort({ _id: -1 })
      .limit(MAX_MISSED_MESSAGES)
      .lean<IMessage[]>();

    return missedMessages.reverse().map(toPayload);
  }

  /**
   * Valida un mensaje sin guardarlo. El primer mensaje de un DM se valida antes de crear la conversación,
   * para no dejarla vacía si el texto no sirve.
   */
  static async validateMessage(
    authorId: string,
    channelId: string,
    content: string,
    attachments?: MessageAttachmentPayload[]
  ): Promise<void> {
    await new Message({ content, authorId, channelId, ...(attachments?.length ? { attachments } : {}) }).validate();
  }

  /**
   * Validates permissions and persists a new chat message into MongoDB.
   *
   * Las menciones se sacan del texto. Mencionar a @everyone o a un rol exige MENTION_EVERYONE, que se
   * consulta a Core en el momento (solo si el mensaje las tiene); sin el permiso quedan como texto plano.
   * Las menciones de usuario no requieren permiso. Un DM no tiene servidor: Core respondería 404, así que
   * ahí no se consulta y @everyone y los roles quedan como texto.
   *
   * @param authorId User sending the message
   * @param channelId Target channel identifier
   * @param content Text body of the message
   * @param thread Raíz del hilo y lo que queda pendiente, si es una respuesta (lo arma ThreadService)
   * @param replyToId Mensaje que cita (responder citando), ver resolveReplyTo
   * @param serverId Servidor del canal: sin él (y fuera de un DM) no se avisa a Notification
   * @throws UpstreamUnavailableError si hay que validar @everyone o un rol y Core no responde
   */
  static async sendMessage(
    authorId: string,
    channelId: string,
    content: string,
    attachmentsOrSkip?: MessageAttachmentPayload[] | boolean,
    skipCheck = false,
    thread?: { parentId: mongoose.Types.ObjectId; outbox: IThreadOutbox },
    replyToId?: string,
    serverId?: string
  ): Promise<MessagePayload> {
    const attachments = Array.isArray(attachmentsOrSkip) ? attachmentsOrSkip : undefined;
    const skipPermissionCheck = typeof attachmentsOrSkip === 'boolean' ? attachmentsOrSkip : skipCheck;

    let access: ChannelAccessResult | undefined;
    if (!skipPermissionCheck) {
      access = await PermissionService.getChannelAccess(authorId, channelId);
      if (!access.canSend) {
        throw new ForbiddenError('User does not have permission to send messages in this channel');
      }
    }

    const replyTo = replyToId == null ? undefined : await resolveReplyTo(channelId, replyToId, thread?.parentId);

    const parsed = parseMentions(content);
    let roleIds: string[] = [];
    let everyone = false;
    if (!isDmChannel(channelId) && (parsed.everyone || parsed.roleIds.length > 0)) {
      const { canMentionEveryone, mentionableRoleIds } =
        access ?? (await PermissionService.getChannelAccess(authorId, channelId));
      if (canMentionEveryone) {
        everyone = parsed.everyone;
        // Solo roles de este servidor
        roleIds = parsed.roleIds.filter((roleId) => mentionableRoleIds.includes(roleId));
      }
    }

    // Aviso a Notification (ADR 0017) de todo mensaje de DM o de canal de servidor. Las respuestas traen el suyo
    // (ThreadService). Va en el mismo documento: se guarda con el mensaje o no se guarda.
    const isDm = isDmChannel(channelId);
    const eventServerId = isDm ? '' : (serverId || access?.serverId);
    const outbox: IThreadOutbox | undefined = thread
      ? thread.outbox
      : isDm || eventServerId
        ? {
            eventId: crypto.randomUUID(),
            serverId: eventServerId ?? '',
            attempts: 0,
            nextAttemptAt: new Date(Date.now() + OUTBOX_GRACE_MS),
          }
        : undefined;

    const messageDocument = new Message({
      content,
      authorId,
      channelId,
      ...(parsed.userIds.length > 0 ? { mentionUserIds: parsed.userIds } : {}),
      ...(roleIds.length > 0 ? { mentionRoleIds: roleIds } : {}),
      ...(everyone ? { mentionEveryone: true } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      // La respuesta y su outbox en el mismo documento: se guardan juntos o no se guarda ninguno
      ...(thread ? { threadParentId: thread.parentId } : {}),
      ...(outbox ? { outbox } : {}),
      ...(replyTo ? { replyTo } : {}),
    });

    await messageDocument.validate();
    await messageDocument.save();
    if (outbox && !thread) ThreadOutbox.deliverInBackground(messageDocument._id as mongoose.Types.ObjectId);

    return toPayload(messageDocument.toObject<IMessage>());
  }

  /**
   * "Se unió …": mensaje del sistema en el canal de bienvenida cuando alguien entra al servidor
   * (`member.joined` de Server-Roles, que elige el canal). El autor es quien llegó, para que la interfaz
   * muestre su nombre actual. Idempotente por `sourceEventId`: una entrega repetida del evento devuelve null.
   */
  static async postMemberJoined(channelId: string, userId: string, sourceEventId?: string): Promise<MessagePayload | null> {
    try {
      const message = await Message.create({
        content: '',
        authorId: userId,
        channelId,
        systemEvent: 'member_join',
        ...(sourceEventId ? { sourceEventId } : {}),
      });
      return toPayload(message.toObject<IMessage>());
    } catch (err) {
      // E11000: ya se publicó por este mismo evento
      if ((err as { code?: unknown })?.code === 11000) return null;
      throw err;
    }
  }

  /**
   * Elimina todos los mensajes y estados de lectura de un canal de forma permanente.
   */
  static async deleteChannelMessages(channelId: string): Promise<number> {
    const res = await Message.deleteMany({ channelId });
    await ReadState.deleteMany({ channelId });
    return res.deletedCount;
  }

  /**
   * Elimina todos los mensajes y estados de lectura de una lista de canales (ej. al borrar un servidor).
   */
  static async deleteChannelsMessages(channelIds: string[]): Promise<number> {
    if (!channelIds.length) return 0;
    const res = await Message.deleteMany({ channelId: { $in: channelIds } });
    await ReadState.deleteMany({ channelId: { $in: channelIds } });
    return res.deletedCount;
  }

  /**
   * Modifica el contenido de un mensaje existente.
   * Solo el autor del mensaje puede editarlo. Las menciones se vuelven a evaluar con el nuevo texto.
   *
   * @param authorId Usuario que solicita la edición
   * @param channelId Canal donde está el mensaje
   * @param messageId ID del mensaje a editar
   * @param newContent Nuevo texto del mensaje
   * @param access Resultado de acceso al canal para validar menciones a @everyone y roles
   */
  static async editMessage(
    authorId: string,
    channelId: string,
    messageId: string,
    newContent: string,
    access?: ChannelAccessResult
  ): Promise<MessagePayload> {
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      throw new NotFoundError('Message not found');
    }

    const message = await Message.findOne({ _id: messageId, channelId });
    if (!message) {
      throw new NotFoundError('Message not found');
    }

    if (message.isDeleted) {
      throw new ValidationError('Cannot edit a deleted message');
    }

    // "Se unió …" tiene como autor a quien llegó, pero no lo escribió
    if (message.systemEvent) {
      throw new ValidationError('System messages cannot be edited');
    }

    if (message.authorId !== authorId) {
      throw new ForbiddenError('Only the author can edit this message');
    }

    if (typeof newContent !== 'string') {
      throw new ValidationError('Message content must be a string');
    }

    const trimmed = newContent.trim();
    const hasAttachments = Boolean(message.attachments && message.attachments.length > 0);

    if (!hasAttachments && trimmed.length === 0) {
      throw new ValidationError('Message content cannot be empty');
    }
    if (trimmed.length > 2000) {
      throw new ValidationError('Message exceeds maximum length of 2000 characters');
    }
    if (/\x00/.test(newContent)) {
      throw new ValidationError('Message cannot contain null characters');
    }

    const parsed = parseMentions(trimmed);
    let roleIds: string[] = [];
    let everyone = false;
    if (!isDmChannel(channelId) && (parsed.everyone || parsed.roleIds.length > 0)) {
      const { canMentionEveryone, mentionableRoleIds } =
        access ?? (await PermissionService.getChannelAccess(authorId, channelId));
      if (canMentionEveryone) {
        everyone = parsed.everyone;
        roleIds = parsed.roleIds.filter((roleId) => mentionableRoleIds.includes(roleId));
      }
    }

    message.content = trimmed;
    message.edited = true;
    message.editedAt = new Date();
    message.mentionUserIds = parsed.userIds.length > 0 ? parsed.userIds : undefined;
    message.mentionRoleIds = roleIds.length > 0 ? roleIds : undefined;
    message.mentionEveryone = everyone ? true : undefined;

    await message.save();
    await Message.updateMany(
      { 'replyTo.id': message._id },
      { $set: { 'replyTo.content': trimmed.slice(0, REPLY_PREVIEW_MAX_LENGTH) } }
    );

    const payload = toPayload(message);
    return {
      ...payload,
      type: 'MESSAGE_UPDATED',
    };
  }

  /**
   * Marca un mensaje como eliminado (soft delete).
   * En canales de servidor lo puede hacer el autor o un moderador (con MANAGE_MESSAGES o admin).
   * En DMs únicamente el autor del mensaje.
   *
   * @param userId Usuario que solicita la eliminación
   * @param channelId Canal donde reside el mensaje
   * @param messageId ID del mensaje a eliminar
   * @param canManageMessages Si el usuario tiene permisos de moderación en el canal
   * @param serverId ID opcional del servidor para registro en audit log
   * @param reason Razón opcional de la moderación
   */
  static async deleteMessage(
    userId: string,
    channelId: string,
    messageId: string,
    canManageMessages = false,
    serverId?: string,
    reason?: string
  ): Promise<MessagePayload> {
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      throw new NotFoundError('Message not found');
    }

    const message = await Message.findOne({ _id: messageId, channelId });
    if (!message) {
      throw new NotFoundError('Message not found');
    }

    if (message.isDeleted) {
      const payload = toPayload(message);
      return {
        ...payload,
        type: 'MESSAGE_DELETED',
      };
    }

    const isAuthor = message.authorId === userId;
    const isDm = isDmChannel(channelId);

    if (isDm) {
      if (!isAuthor) {
        throw new ForbiddenError('Only the author can delete this message');
      }
    } else {
      if (!isAuthor && !canManageMessages) {
        throw new ForbiddenError('You do not have permission to delete this message');
      }
    }

    const previousAuthorId = message.authorId;

    message.isDeleted = true;
    message.deletedAt = new Date();
    message.content = '';
    message.attachments = [];
    message.mentionUserIds = undefined;
    message.mentionRoleIds = undefined;
    message.mentionEveryone = undefined;
    // Un mensaje borrado no queda fijado: libera el lugar en el límite.
    message.pinned = false;
    message.pinnedAt = null;
    message.pinnedBy = null;
    // Respuesta de hilo: queda anotado en el mismo guardado que falta restar del contador (D4). Si el proceso se
    // cae antes de restar, ThreadOutbox recuenta el hilo.
    if (message.threadParentId) {
      message.outbox = {
        ...(message.outbox ? { eventId: message.outbox.eventId } : {}),
        summaryPending: true,
        serverId: message.outbox?.serverId ?? serverId ?? '',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() + OUTBOX_GRACE_MS),
      };
    }

    await message.save();
    // Las citas no siguen mostrando el texto de un mensaje borrado
    await Message.updateMany({ 'replyTo.id': message._id }, { $set: { 'replyTo.content': '', 'replyTo.deleted': true } });

    // El contador del raíz cuenta solo respuestas visibles. Solo acá: un segundo DELETE sale antes, sin restar.
    if (message.threadParentId) {
      await Message.updateOne(
        { _id: message.threadParentId, 'thread.replyCount': { $gt: 0 } },
        { $inc: { 'thread.replyCount': -1 } }
      );
      await clearSummaryPending(message._id as mongoose.Types.ObjectId);
    }

    // Audit Log: Si un moderador elimina el mensaje de otro usuario en un servidor
    if (!isDm && !isAuthor) {
      let targetServerId = serverId;
      if (!targetServerId) {
        try {
          const access = await PermissionService.getChannelAccess(userId, channelId);
          targetServerId = access.serverId;
        } catch {
          // ignore lookup error
        }
      }

      if (targetServerId) {
        EventConsumer.publish('message.deleted_by_moderator', {
          event_id: crypto.randomUUID(),
          event_type: 'message.deleted_by_moderator',
          server_id: targetServerId,
          channel_id: channelId,
          message_id: message._id.toString(),
          author_id: previousAuthorId,
          deleted_by: userId,
          reason: reason || null,
          created_at: new Date().toISOString(),
        });
      }
    }

    const payload = toPayload(message);
    return {
      ...payload,
      type: 'MESSAGE_DELETED',
    };
  }

  /**
   * Alterna (agrega o retira) la reacción de un usuario a un mensaje con un emoji (CA 1, CA 2, CA 3).
   *
   * @param userId Usuario que reacciona
   * @param channelId Canal donde reside el mensaje
   * @param messageId ID del mensaje al que se reacciona
   * @param emoji Emoji con el cual se reacciona
   * @param canAddReactions Si el usuario tiene permiso ADD_REACTIONS en el canal
   */
  static async toggleReaction(
    userId: string,
    channelId: string,
    messageId: string,
    emoji: string,
    canAddReactions = true
  ): Promise<MessagePayload> {
    const cleanEmoji = typeof emoji === 'string' ? emoji.trim() : '';
    if (!cleanEmoji) {
      throw new ValidationError('Emoji is required');
    }

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      throw new NotFoundError('Message not found');
    }

    const message = await Message.findOne({ _id: messageId, channelId });
    if (!message) {
      throw new NotFoundError('Message not found');
    }

    if (message.isDeleted) {
      throw new ValidationError('Cannot react to a deleted message');
    }

    const reactions = message.reactions ? [...message.reactions] : [];
    const existing = reactions.find((r) => r.emoji === cleanEmoji);

    if (existing) {
      const userIndex = existing.users.indexOf(userId);

      if (userIndex !== -1) {
        const nextUsers = existing.users.filter((id) => id !== userId);
        if (nextUsers.length === 0) {
          message.reactions = reactions.filter((r) => r.emoji !== cleanEmoji);
        } else {
          message.reactions = reactions.map((r) =>
            r.emoji === cleanEmoji
              ? { emoji: r.emoji, count: nextUsers.length, users: nextUsers, emojiId: r.emojiId }
              : r
          );
        }
      } else {
        if (!canAddReactions) {
          throw new ForbiddenError('User does not have permission to add reactions in this channel');
        }
        const nextUsers = [...existing.users, userId];
        message.reactions = reactions.map((r) =>
          r.emoji === cleanEmoji
            ? { emoji: r.emoji, count: nextUsers.length, users: nextUsers, emojiId: r.emojiId }
            : r
        );
      }
    } else {
      if (!canAddReactions) {
        throw new ForbiddenError('User does not have permission to add reactions in this channel');
      }
      message.reactions = [
        ...reactions,
        {
          emoji: cleanEmoji,
          count: 1,
          users: [userId],
        },
      ];
    }
    message.markModified('reactions');
    await message.save();

    const payload = toPayload(message);
    return {
      ...payload,
      type: 'MESSAGE_REACTION_UPDATED',
    };
  }

  /**
   * Fija o desfija un mensaje. En canales de servidor requiere MANAGE_MESSAGES; en DMs alcanza con ser
   * participante (lo valida `channelAccessGuard`). Es idempotente: si ya estaba en ese estado, `changed` es false
   * y no hay que publicar nada.
   *
   * @param userId Usuario que fija o desfija
   * @param channelId Canal (o `dm-<id>`) donde está el mensaje
   * @param messageId ID del mensaje
   * @param pinned true para fijar, false para desfijar
   * @param canManageMessages Si el usuario tiene MANAGE_MESSAGES en el canal (ignorado en DMs)
   */
  static async setPinned(
    userId: string,
    channelId: string,
    messageId: string,
    pinned: boolean,
    canManageMessages = false
  ): Promise<{ payload: MessagePayload; changed: boolean }> {
    if (!isDmChannel(channelId) && !canManageMessages) {
      throw new ForbiddenError('You do not have permission to pin messages in this channel');
    }

    if (!isObjectIdString(messageId)) {
      throw new NotFoundError('Message not found');
    }

    const message = await Message.findOne({ _id: messageId, channelId });
    if (!message || message.isDeleted) {
      throw new NotFoundError('Message not found');
    }

    if (message.systemEvent) {
      throw new ValidationError('System messages cannot be pinned');
    }

    // Los fijados son del canal: una respuesta de hilo no está en el canal
    if (message.threadParentId) {
      throw new ValidationError('Thread replies cannot be pinned');
    }

    if ((message.pinned === true) === pinned) {
      return { payload: { ...toPayload(message), type: 'MESSAGE_UPDATED' }, changed: false };
    }

    if (pinned) {
      // Dos fijados simultáneos pueden pasar el límite por uno: se acepta, no justifica una transacción.
      const pinnedCount = await Message.countDocuments({ channelId, pinned: true });
      if (pinnedCount >= PINNED_LIMIT) {
        throw new ConflictError(`Pinned messages limit reached (${PINNED_LIMIT})`);
      }
    }

    message.pinned = pinned;
    message.pinnedAt = pinned ? new Date() : null;
    message.pinnedBy = pinned ? userId : null;
    await message.save();

    return { payload: { ...toPayload(message), type: 'MESSAGE_UPDATED' }, changed: true };
  }

  /**
   * Mensajes fijados de un canal o DM, del fijado más reciente al más viejo.
   *
   * @param channelId Canal (o `dm-<id>`)
   */
  static async getPinnedMessages(channelId: string): Promise<MessagePayload[]> {
    const messages = await Message.find({ channelId, pinned: true, isDeleted: { $ne: true } })
      .sort({ pinnedAt: -1 })
      .limit(PINNED_LIMIT)
      .lean<IMessage[]>();
    return messages.map(toPayload);
  }
}
