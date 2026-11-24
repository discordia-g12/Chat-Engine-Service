import { ModifyResult, Types } from 'mongoose';
import { Conversation, ConversationStatus, IConversation } from '../models/Conversation';
import { ChatService, MessageAttachmentPayload, MessagePayload } from './ChatService';
import { PubSubService } from './PubSubService';
import { ReadStateService } from './ReadStateService';
import { RelationsService, UserRelations } from './RelationsService';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { CONVERSATION_NOT_FOUND, DM_NOT_DELIVERABLE, DM_PENDING, parseDmChannelId, toDmChannelId } from '../helpers/directMessages';

const PREVIEW_MAX_LENGTH = 200;
const DUPLICATE_KEY = 11000;

export interface ConversationView {
  id: string;
  status: ConversationStatus;
  requestedBy: string;
  otherUserId: string;
  lastMessage?: { content: string; authorId: string; createdAt: Date };
  unreadCount: number;
}

// Mismo texto para bloqueo, suspensión o cuenta inexistente: quien escribe no puede saber cuál fue
const notDeliverable = () => new ForbiddenError('The message could not be delivered', { code: DM_NOT_DELIVERABLE });
const pending = () => new ForbiddenError('This conversation has not been accepted yet', { code: DM_PENDING });

function isDeliverable(relations: UserRelations): boolean {
  return relations.exists && !relations.suspended && !relations.blockedByActor && !relations.blockedByOther;
}

function participantKey(a: string, b: string): string {
  return JSON.stringify([a, b].sort());
}

function otherParticipant(conversation: IConversation, userId: string): string {
  return conversation.participantIds[0] === userId ? conversation.participantIds[1] : conversation.participantIds[0];
}

/** Escribir es arrepentirse: quien rechazó la solicitud puede volver a escribir sin aceptarla antes. */
function declinedBy(conversation: IConversation, userId: string): boolean {
  return conversation.status === 'declined' && conversation.declinedBy === userId;
}

function toView(conversation: IConversation, viewerId: string, unreadCount: number): ConversationView {
  const { status, lastMessageAuthorId, lastMessageId, lastMessageAt } = conversation;
  return {
    id: toDmChannelId(conversation._id),
    // Quien inició la conversación no se entera del rechazo: para él sigue esperando respuesta
    status: status === 'declined' && !declinedBy(conversation, viewerId) ? 'pending' : status,
    requestedBy: conversation.requestedBy,
    otherUserId: otherParticipant(conversation, viewerId),
    ...(lastMessageId && lastMessageAuthorId
      ? {
          lastMessage: {
            content: conversation.lastMessagePreview ?? '',
            authorId: lastMessageAuthorId,
            createdAt: lastMessageAt,
          },
        }
      : {}),
    unreadCount,
  };
}

async function viewFor(conversation: IConversation, viewerId: string): Promise<ConversationView> {
  const channelId = toDmChannelId(conversation._id);
  const unread = await ReadStateService.getConversationUnread(viewerId, [channelId]);
  return toView(conversation, viewerId, unread.get(channelId) ?? 0);
}

/**
 * Conversaciones directas. Reciben siempre ids canónicos (ver `requireCanonicalUser`), y la relación entre
 * los participantes se le pregunta a Auth en cada envío: acá solo se guarda el estado de la conversación.
 */
export class ConversationService {
  /** Las conversaciones del usuario, las más recientes primero, sin las que rechazó. */
  static async list(userId: string): Promise<ConversationView[]> {
    const conversations = await Conversation.find({ participantIds: userId, declinedBy: { $ne: userId } })
      .sort({ lastMessageAt: -1 })
      .lean<IConversation[]>();

    const unread = await ReadStateService.getConversationUnread(
      userId,
      conversations.map((c) => toDmChannelId(c._id))
    );
    return conversations.map((c) => toView(c, userId, unread.get(toDmChannelId(c._id)) ?? 0));
  }

  /**
   * Lo que necesita el cliente para abrir un chat con alguien. No crea nada: la conversación nace con el
   * primer mensaje. Si ya son amigos, una conversación pendiente o rechazada pasa a `accepted`. Quien rechazó
   * puede escribir, pero abrir el chat no cambia el estado: eso pasa cuando manda el mensaje.
   */
  static async openWith(
    actorId: string,
    otherId: string
  ): Promise<{ conversation: ConversationView | null; canMessage: boolean }> {
    const other = await RelationsService.getCanonical(otherId);
    if (!other) return { conversation: null, canMessage: false };
    if (other.userId === actorId) {
      throw new ValidationError('You cannot start a conversation with yourself');
    }

    const relations = await RelationsService.getRelations(actorId, other.userId);
    const found = await Conversation.findOne({ participantKey: participantKey(actorId, other.userId) }).lean<IConversation>();
    const conversation = found && relations.friends ? await this.markAccepted(found) : found;

    return {
      conversation: conversation ? await viewFor(conversation, actorId) : null,
      canMessage:
        isDeliverable(relations) &&
        (!conversation || conversation.status === 'accepted' || declinedBy(conversation, actorId)),
    };
  }

  /**
   * Manda un mensaje a un usuario: crea la conversación si es el primero (`accepted` si son amigos, si no
   * `pending`) o reutiliza la que ya tienen.
   *
   * @throws ForbiddenError `DM_NOT_DELIVERABLE` si hay bloqueo o suspensión, `DM_PENDING` si falta aceptar
   * @throws UpstreamUnavailableError si Auth no responde: no se guarda ni se entrega nada
   */
  static async start(
    actorId: string,
    recipientId: string,
    content: string,
    attachments?: MessageAttachmentPayload[]
  ): Promise<{ conversation: ConversationView; message: MessagePayload }> {
    const recipient = await RelationsService.getCanonical(recipientId);
    if (!recipient) throw notDeliverable();
    if (recipient.userId === actorId) {
      throw new ValidationError('You cannot start a conversation with yourself');
    }

    const relations = await RelationsService.getRelations(actorId, recipient.userId);
    if (!isDeliverable(relations)) throw notDeliverable();

    const files = Array.isArray(attachments) ? attachments : undefined;
    await ChatService.validateMessage(actorId, 'dm-new', content, files);

    const { conversation, created } = await this.findOrCreate(actorId, recipient.userId, relations.friends);

    if (!created) {
      const reopens = relations.friends || declinedBy(conversation, actorId);
      const accepted = reopens ? await this.markAccepted(conversation) : conversation;
      if (accepted.status !== 'accepted') throw pending();
      const delivered = await this.deliver(accepted, actorId, content, files);
      return { conversation: await viewFor(delivered.conversation, actorId), message: delivered.message };
    }

    try {
      const delivered = await this.deliver(conversation, actorId, content, files, true);
      return { conversation: await viewFor(delivered.conversation, actorId), message: delivered.message };
    } catch (err) {
      // Sin mensaje la conversación queda vacía y, si es pendiente, le trabaría el envío a quien la inició
      await Conversation.deleteOne({ _id: conversation._id, lastMessageId: { $exists: false } });
      throw err;
    }
  }

  /** Solo quien la recibió. También sirve para arrepentirse de un rechazo. */
  static async accept(actorId: string, channelId: string): Promise<ConversationView> {
    const conversation = await this.requireRecipient(actorId, channelId);
    return viewFor(await this.markAccepted(conversation), actorId);
  }

  /** Solo quien la recibió. La saca de su lista; a quien la inició no se le avisa. */
  static async decline(actorId: string, channelId: string): Promise<void> {
    const conversation = await this.requireRecipient(actorId, channelId);
    const declined = await Conversation.findOneAndUpdate(
      { _id: conversation._id, status: { $ne: 'accepted' } },
      { $set: { status: 'declined', declinedBy: actorId } },
      { returnDocument: 'after' }
    ).lean<IConversation>();
    if (!declined) {
      throw new ConflictError('An accepted conversation cannot be declined');
    }
    await this.notifyConversation(declined, [actorId]);
  }

  /**
   * @throws NotFoundError si la conversación no existe o el id no es válido
   * @throws ForbiddenError si el usuario no participa
   */
  static async requireParticipant(userId: string, channelId: string): Promise<IConversation> {
    const id = parseDmChannelId(channelId);
    const conversation = id ? await Conversation.findById(id).lean<IConversation>() : null;
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }
    if (!conversation.participantIds.includes(userId)) {
      throw new ForbiddenError('User does not have permission to access this conversation');
    }
    return conversation;
  }

  /** Lo que hay que cumplir para escribir, sin mandar nada ni cambiar el estado: lo usa la subida de adjuntos. */
  static async assertCanSend(userId: string, channelId: string): Promise<void> {
    await this.checkSend(userId, channelId);
  }

  /**
   * Si el usuario puede llamar en la conversación (lo pregunta Voice-Signaling, historia #50). Mismas reglas
   * que para escribir, sin mandar nada ni cambiar el estado: una conversación que el próximo mensaje aceptaría
   * (son amigos, o llama quien la rechazó) también vale. Recibe el `X-User-Id` crudo, que puede ser un alias,
   * y devuelve los ids canónicos.
   *
   * @throws NotFoundError si la conversación no existe o el id no es `dm-…`
   * @throws ForbiddenError si no participa; `DM_NOT_DELIVERABLE` si no existe, está suspendido o hay bloqueo;
   *   `DM_PENDING` si falta aceptar
   * @throws UpstreamUnavailableError si Auth no responde
   */
  static async callAccess(
    rawUserId: string,
    channelId: string
  ): Promise<{ conversationId: string; userId: string; otherUserId: string }> {
    // Con código: así Voice distingue "la conversación no existe" de "este Chat no tiene la ruta" (404 sin código)
    const conversationNotFound = () =>
      new NotFoundError('Conversation not found', { code: CONVERSATION_NOT_FOUND });
    if (!parseDmChannelId(channelId)) throw conversationNotFound();

    const user = await RelationsService.getCanonical(rawUserId);
    if (!user || user.suspended) throw notDeliverable();

    let conversation: IConversation;
    try {
      ({ conversation } = await this.checkSend(user.userId, channelId));
    } catch (error) {
      if (error instanceof NotFoundError) throw conversationNotFound();
      throw error;
    }
    return {
      conversationId: toDmChannelId(conversation._id),
      userId: user.userId,
      otherUserId: otherParticipant(conversation, user.userId),
    };
  }

  /**
   * Manda un mensaje en una conversación existente, por WebSocket o REST. Vuelve a leerla y a preguntar la
   * relación en cada envío.
   *
   * @throws ForbiddenError `DM_NOT_DELIVERABLE` si hay bloqueo o suspensión, `DM_PENDING` si falta aceptar
   * @throws UpstreamUnavailableError si Auth no responde: no se guarda ni se entrega nada
   */
  static async sendMessage(
    userId: string,
    channelId: string,
    content: string,
    attachments?: MessageAttachmentPayload[],
    replyToId?: string
  ): Promise<MessagePayload> {
    const { conversation, reopens } = await this.checkSend(userId, channelId);
    const files = Array.isArray(attachments) ? attachments : undefined;

    let current = conversation;
    if (reopens) {
      // Un mensaje inválido no se manda: tampoco tiene que aceptar la conversación
      await ChatService.validateMessage(userId, channelId, content, files);
      current = await this.markAccepted(conversation);
    }

    const { message } = await this.deliver(current, userId, content, files, false, replyToId);
    return message;
  }

  /**
   * Mismas reglas que para escribir, para una respuesta de hilo en un DM (ADR-07). Una respuesta no acepta
   * la conversación: si falta aceptarla, se escribe en el chat principal.
   *
   * @throws ForbiddenError `DM_NOT_DELIVERABLE` si hay bloqueo o suspensión, `DM_PENDING` si falta aceptar
   * @throws UpstreamUnavailableError si Auth no responde
   */
  static async assertCanReplyInThread(userId: string, channelId: string): Promise<IConversation> {
    const { conversation, reopens } = await this.checkSend(userId, channelId);
    if (reopens) throw pending();
    return conversation;
  }

  /**
   * Revisa si el usuario puede escribir. `reopens` indica que la conversación todavía no está aceptada y que
   * este mensaje la acepta: ya son amigos, o escribe quien la rechazó.
   */
  private static async checkSend(
    userId: string,
    channelId: string
  ): Promise<{ conversation: IConversation; reopens: boolean }> {
    const conversation = await this.requireParticipant(userId, channelId);
    const relations = await RelationsService.getRelations(userId, otherParticipant(conversation, userId));
    if (!isDeliverable(relations)) throw notDeliverable();

    if (conversation.status === 'accepted') return { conversation, reopens: false };
    if (!relations.friends && !declinedBy(conversation, userId)) throw pending();
    return { conversation, reopens: true };
  }

  private static async requireRecipient(userId: string, channelId: string): Promise<IConversation> {
    const conversation = await this.requireParticipant(userId, channelId);
    if (conversation.requestedBy === userId) {
      throw new ForbiddenError('Only the recipient can answer a message request');
    }
    return conversation;
  }

  /**
   * Devuelve la conversación del par, o la crea. Dos primeros mensajes simultáneos se resuelven en el índice
   * único de `participantKey`: uno la crea, y el otro la encuentra (el upsert o, si perdió la carrera con
   * error de clave duplicada, la búsqueda de después).
   */
  private static async findOrCreate(
    actorId: string,
    recipientId: string,
    friends: boolean
  ): Promise<{ conversation: IConversation; created: boolean }> {
    const key = participantKey(actorId, recipientId);
    try {
      const result = (await Conversation.findOneAndUpdate(
        { participantKey: key },
        {
          $setOnInsert: {
            participantKey: key,
            participantIds: [actorId, recipientId].sort(),
            status: friends ? 'accepted' : 'pending',
            requestedBy: actorId,
            lastMessageAt: new Date(),
          },
        },
        { upsert: true, returnDocument: 'after', includeResultMetadata: true }
      ).lean()) as unknown as ModifyResult<IConversation>;
      return {
        conversation: result.value as IConversation,
        created: result.lastErrorObject?.updatedExisting === false,
      };
    } catch (err) {
      if ((err as { code?: unknown }).code !== DUPLICATE_KEY) throw err;
      const conversation = await Conversation.findOne({ participantKey: key }).lean<IConversation>();
      if (!conversation) throw err;
      return { conversation, created: false };
    }
  }

  /** Pasa la conversación a `accepted` y se lo avisa a los dos. Si ya lo estaba, no hace nada. */
  private static async markAccepted(conversation: IConversation): Promise<IConversation> {
    if (conversation.status === 'accepted') return conversation;

    const accepted = await Conversation.findOneAndUpdate(
      { _id: conversation._id, status: { $ne: 'accepted' } },
      { $set: { status: 'accepted' }, $unset: { declinedBy: 1 } },
      { returnDocument: 'after' }
    ).lean<IConversation>();
    if (!accepted) return { ...conversation, status: 'accepted', declinedBy: undefined };

    await this.notifyConversation(accepted, accepted.participantIds);
    return accepted;
  }

  /** Guarda el mensaje y lo reparte: al canal de la conversación y al inbox de los dos participantes. */
  private static async deliver(
    conversation: IConversation,
    authorId: string,
    content: string,
    attachments?: MessageAttachmentPayload[],
    isNew = false,
    replyToId?: string
  ): Promise<{ conversation: IConversation; message: MessagePayload }> {
    const channelId = toDmChannelId(conversation._id);
    const message = await ChatService.sendMessage(authorId, channelId, content, attachments, true, undefined, replyToId);

    const messageId = new Types.ObjectId(message.id);
    // Con mensajes simultáneos gana el último: sin esta condición, el resumen podría quedar en uno anterior
    const updated = await Conversation.findOneAndUpdate(
      { _id: conversation._id, $or: [{ lastMessageId: { $exists: false } }, { lastMessageId: { $lt: messageId } }] },
      {
        $set: {
          lastMessageId: messageId,
          lastMessageAt: message.createdAt,
          lastMessagePreview: message.content.slice(0, PREVIEW_MAX_LENGTH),
          lastMessageAuthorId: authorId,
        },
      },
      { returnDocument: 'after' }
    ).lean<IConversation>();

    // Primero la conversación: si no, el cliente recibe un mensaje de un chat que todavía no conoce
    if (isNew) await this.notifyConversation(updated ?? conversation, conversation.participantIds);

    await PubSubService.publish(channelId, message);
    const event = { type: 'DM_MESSAGE', conversationId: channelId, message };
    await Promise.all(conversation.participantIds.map((id) => PubSubService.publishToInbox(id, event)));

    return { conversation: updated ?? conversation, message };
  }

  /** Cada uno recibe su propia vista: cambia el otro participante y los no leídos. */
  private static async notifyConversation(conversation: IConversation, userIds: string[]): Promise<void> {
    await Promise.all(
      userIds.map(async (userId) =>
        PubSubService.publishToInbox(userId, {
          type: 'DM_CONVERSATION',
          conversation: await viewFor(conversation, userId),
        })
      )
    );
  }
}
