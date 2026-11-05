import mongoose from 'mongoose';
import { Message, IMessage } from '../models/Message';
import { ChannelAccessResult, PermissionService } from './PermissionService';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { parseMentions } from '../helpers/mentions';

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

export interface MessagePayload {
  id: string;
  content: string;
  authorId: string;
  channelId: string;
  createdAt: Date;
  mentions: MessageMentions;
  attachments?: MessageAttachmentPayload[];
  edited?: boolean;
  editedAt?: Date | null;
  type?: string;
}

function toPayload(msg: IMessage): MessagePayload {
  return {
    id: msg._id.toString(),
    content: msg.content,
    authorId: msg.authorId,
    channelId: msg.channelId,
    createdAt: msg.createdAt,
    mentions: {
      users: msg.mentionUserIds ?? [],
      roles: msg.mentionRoleIds ?? [],
      everyone: msg.mentionEveryone === true,
    },
    ...(msg.edited ? { edited: true, editedAt: msg.editedAt ?? null } : {}),
    ...(msg.attachments && msg.attachments.length > 0
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
   * Validates permissions and persists a new chat message into MongoDB.
   *
   * Las menciones se sacan del texto. Mencionar a @everyone o a un rol exige MENTION_EVERYONE, que se
   * consulta a Core en el momento (solo si el mensaje las tiene); sin el permiso quedan como texto plano.
   * Las menciones de usuario no requieren permiso.
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
    if (parsed.everyone || parsed.roleIds.length > 0) {
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
    if (parsed.everyone || parsed.roleIds.length > 0) {
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
}
