import { Message, IMessage } from '../models/Message';
import { PermissionService } from './PermissionService';
import { ForbiddenError } from '../errors';

export interface MessagePayload {
  id: string;
  content: string;
  authorId: string;
  channelId: string;
  createdAt: Date;
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

    return messages.reverse().map((msg) => ({
      id: msg._id.toString(),
      content: msg.content,
      authorId: msg.authorId,
      channelId: msg.channelId,
      createdAt: msg.createdAt,
    }));
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

    return missedMessages.map((msg) => ({
      id: msg._id.toString(),
      content: msg.content,
      authorId: msg.authorId,
      channelId: msg.channelId,
      createdAt: msg.createdAt,
    }));
  }

  /**
   * Validates permissions and persists a new chat message into MongoDB.
   *
   * @param authorId User sending the message
   * @param channelId Target channel identifier
   * @param content Text body of the message
   */
  static async sendMessage(
    authorId: string,
    channelId: string,
    content: string
  ): Promise<MessagePayload> {
    const hasPermission = await PermissionService.canSendMessage(authorId, channelId);
    if (!hasPermission) {
      throw new ForbiddenError('User does not have permission to send messages in this channel');
    }

    const messageDocument = new Message({
      content,
      authorId,
      channelId,
    });

    await messageDocument.validate();
    await messageDocument.save();

    const saved = messageDocument.toObject<IMessage>();

    return {
      id: saved._id.toString(),
      content: saved.content,
      authorId: saved.authorId,
      channelId: saved.channelId,
      createdAt: saved.createdAt,
    };
  }
}