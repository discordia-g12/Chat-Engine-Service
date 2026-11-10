import { Message, IMessage } from '../models/Message';
import { ReadState } from '../models/ReadState';
import { ChannelAccessResult, PermissionService } from './PermissionService';
import { ForbiddenError } from '../errors';
import { parseMentions } from '../helpers/mentions';
import { isDmChannel } from '../helpers/directMessages';

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
}
