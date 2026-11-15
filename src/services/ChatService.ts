import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Message, IMessage } from '../models/Message';
import { ReadState } from '../models/ReadState';
import { ChannelAccessResult, PermissionService } from './PermissionService';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { parseMentions } from '../helpers/mentions';
import { isDmChannel } from '../helpers/directMessages';
import { EventConsumer } from './EventConsumer';

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
  type?: string;
}

function toPayload(msg: IMessage): MessagePayload {
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
    ...(isDeleted ? { type: 'deleted', isDeleted: true, deletedAt: msg.deletedAt ?? null } : {}),
  };
}

export class ChatService {
  /**
   * Retrieves paginated message history for a channel in chronological order.
   *
   * @param channelId Target channel identifier
   * @param limit Maximum number of messages to fetch (default: 50)
   * @param before Optional message ID cursor to load older messages
   */
  static async getHistory(
    channelId: string,
    limit = 50,
    before?: string
  ): Promise<MessagePayload[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = { channelId };

    if (before) {
      query._id = { $lt: before };
    }

    const messages = await Message.find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .lean<IMessage[]>();

    return messages.reverse().map(toPayload);
  }

  /**
   * Retrieves messages missed during temporary client disconnection.
   * Fetches all messages created after the last known message in chronological order.
   *
   * @param channelId Target channel identifier
   * @param lastMessageIdSeen Message ID cursor provided by client handshake
   */
  static async getMissedMessages(
    channelId: string,
    lastMessageIdSeen: string
  ): Promise<MessagePayload[]> {
    const lastSeen = await Message.findById(lastMessageIdSeen).lean<IMessage>();
    if (!lastSeen) {
      return [];
    }

    const missedMessages = await Message.find({
      channelId,
      _id: { $gt: lastMessageIdSeen },
    })
      .sort({ _id: 1 })
      .lean<IMessage[]>();

    return missedMessages.map(toPayload);
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
   * @throws UpstreamUnavailableError si hay que validar @everyone o un rol y Core no responde
   */
  static async sendMessage(
    authorId: string,
    channelId: string,
    content: string,
    attachmentsOrSkip?: MessageAttachmentPayload[] | boolean,
    skipCheck = false
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

    const messageDocument = new Message({
      content,
      authorId,
      channelId,
      ...(parsed.userIds.length > 0 ? { mentionUserIds: parsed.userIds } : {}),
      ...(roleIds.length > 0 ? { mentionRoleIds: roleIds } : {}),
      ...(everyone ? { mentionEveryone: true } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });

    await messageDocument.validate();
    await messageDocument.save();

    return toPayload(messageDocument.toObject<IMessage>());
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

    await message.save();

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
}
