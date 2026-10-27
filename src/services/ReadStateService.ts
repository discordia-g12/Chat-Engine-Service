import { Types } from 'mongoose';
import { Message } from '../models/Message';
import { ReadState } from '../models/ReadState';
import { PermissionService } from './PermissionService';
import { NotFoundError, ValidationError } from '../errors';

/** Tope del contador por canal: más que esto, la interfaz muestra "99+". */
export const UNREAD_COUNT_CAP = 100;

export interface ChannelUnread {
  channelId: string;
  /** Mensajes de otros sin leer, hasta UNREAD_COUNT_CAP. */
  unreadCount: number;
  /** Menciones sin leer. Siempre 0 hasta que existan las menciones (historia #46). */
  mentionCount: number;
}

/** Un _id que queda después de todo lo enviado hasta ahora (y antes de lo que se envíe después). */
function idForNow(): Types.ObjectId {
  return Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000));
}

async function latestMessageId(channelId: string): Promise<Types.ObjectId | undefined> {
  const last = await Message.findOne({ channelId }, { _id: 1 }).sort({ _id: -1 }).lean();
  return last?._id as Types.ObjectId | undefined;
}

/**
 * Avanza lo leído en cada canal hasta `messageId` ($max: nunca retrocede). Si no había registro, lo
 * crea. Es idempotente y aguanta pedidos repetidos o fuera de orden.
 */
async function advance(userId: string, reads: { channelId: string; messageId: Types.ObjectId }[]): Promise<void> {
  if (reads.length === 0) return;
  await ReadState.bulkWrite(
    reads.map(({ channelId, messageId }) => ({
      updateOne: {
        filter: { userId, channelId },
        update: { $max: { lastReadMessageId: messageId } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
}

export class ReadStateService {
  /**
   * Canales visibles con mensajes sin leer. Un canal sin registro (recién visible, o nunca abierto) se
   * toma como leído hasta ahora: si no, quien entra a un servidor vería todo el historial como no leído.
   */
  static async getUnread(userId: string): Promise<ChannelUnread[]> {
    const channelIds = await PermissionService.getVisibleChannels(userId);
    if (channelIds.length === 0) return [];

    const states = await ReadState.find({ userId, channelId: { $in: channelIds } }).lean();
    const lastRead = new Map(states.map((s) => [s.channelId, s.lastReadMessageId as Types.ObjectId]));

    const missing = channelIds.filter((channelId) => !lastRead.has(channelId));
    if (missing.length > 0) {
      // Hasta el último mensaje (no "ahora": los ObjectId tienen resolución de segundos)
      const baselines = await Promise.all(
        missing.map(async (channelId) => ({ channelId, messageId: (await latestMessageId(channelId)) ?? idForNow() }))
      );
      // $setOnInsert: si otro pedido lo creó recién, se respeta el suyo
      await ReadState.bulkWrite(
        baselines.map(({ channelId, messageId }) => ({
          updateOne: {
            filter: { userId, channelId },
            update: { $setOnInsert: { lastReadMessageId: messageId } },
            upsert: true,
          },
        })),
        { ordered: false }
      );
      baselines.forEach(({ channelId, messageId }) => lastRead.set(channelId, messageId));
    }

    const counts = await Promise.all(
      channelIds.map(async (channelId) => ({
        channelId,
        unreadCount: await Message.countDocuments(
          { channelId, _id: { $gt: lastRead.get(channelId) }, authorId: { $ne: userId } },
          { limit: UNREAD_COUNT_CAP }
        ),
        mentionCount: 0,
      }))
    );
    return counts.filter((c) => c.unreadCount > 0);
  }

  /**
   * Marca el canal como leído hasta `messageId`, o hasta el último mensaje si no viene. El acceso al
   * canal lo valida la ruta (channelAccessGuard).
   *
   * @throws ValidationError si messageId no es un id válido
   * @throws NotFoundError si el mensaje no es de ese canal
   */
  static async markRead(userId: string, channelId: string, messageId?: string): Promise<void> {
    let upTo: Types.ObjectId | undefined;
    if (messageId !== undefined) {
      if (typeof messageId !== 'string' || !Types.ObjectId.isValid(messageId) || messageId.length !== 24) {
        throw new ValidationError('messageId must be a valid message id');
      }
      upTo = new Types.ObjectId(messageId);
      const exists = await Message.exists({ _id: upTo, channelId });
      if (!exists) {
        throw new NotFoundError('Message not found in this channel');
      }
    } else {
      upTo = (await latestMessageId(channelId)) ?? idForNow();
    }
    await advance(userId, [{ channelId, messageId: upTo }]);
  }

  /** Marca como leídos todos los canales que el usuario puede ver. */
  static async markAllRead(userId: string): Promise<void> {
    const channelIds = await PermissionService.getVisibleChannels(userId);
    const reads = await Promise.all(
      channelIds.map(async (channelId) => ({
        channelId,
        messageId: (await latestMessageId(channelId)) ?? idForNow(),
      }))
    );
    await advance(userId, reads);
  }
}
