import mongoose, { Schema, Document } from 'mongoose';

export interface IAttachment {
  id: string;
  name: string;
  url: string;
  size: number;
  contentType: string;
}

export interface IReaction {
  emoji: string;
  count: number;
  users: string[];
  emojiId?: string;
}

/** Mensajes que escribe el sistema, no un usuario. `member_join`: alguien se unió al servidor (autor = quien llegó). */
export const SYSTEM_EVENTS = ['member_join'] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

/** Resumen del hilo, guardado en el mensaje raíz (ADR-07): se actualiza en cada respuesta. */
export interface IThreadSummary {
  replyCount: number;
  lastReplyAt: Date;
  lastReplyId: mongoose.Types.ObjectId;
  /** Autor del raíz, quienes respondieron y los mencionados, con tope MAX_THREAD_PARTICIPANTS. */
  participantIds: string[];
  /** Solo quienes respondieron, en orden de primera respuesta (las fotos del resumen). Mismo tope. */
  replierIds?: string[];
}

/**
 * Copia del mensaje al que responde (responder citando, no un hilo). Se guarda con la respuesta para no
 * buscarlo en cada lectura; si el original se edita o se borra, ChatService actualiza las copias.
 */
export interface IReplyTo {
  id: mongoose.Types.ObjectId;
  authorId: string;
  content: string;
  deleted?: boolean;
}

/**
 * Lo que falta hacer después de guardar un mensaje (ADR-07, D3/D4): el aviso a Notification y, en una respuesta
 * de hilo, el resumen del raíz. Va en el mismo documento: se escribe con el mensaje en una sola operación
 * (atómica en Mongo), así una caída no lo pierde. Se completa en el momento y, si falla o el proceso se cae,
 * ThreadOutbox lo reintenta.
 */
export interface IThreadOutbox {
  /** El aviso `chat.message.created` todavía no lo confirmó RabbitMQ. Se reusa en cada intento (idempotencia). */
  eventId?: string;
  /** El resumen del raíz todavía no refleja esta respuesta (al crearla o al borrarla): hay que recontar. */
  summaryPending?: boolean;
  /** Servidor del canal ('' en un DM), para filtrar destinatarios que ya no son miembros. */
  serverId: string;
  attempts: number;
  nextAttemptAt: Date;
}

export interface IMessage extends Document {
  content: string;
  authorId: string;
  channelId: string;
  createdAt: Date;
  /** Menciones que notifican (#46). Solo se guardan si hay alguna. */
  mentionUserIds?: string[];
  mentionRoleIds?: string[];
  mentionEveryone?: boolean;
  attachments?: IAttachment[];
  edited?: boolean;
  editedAt?: Date | null;
  isDeleted?: boolean;
  deletedAt?: Date | null;
  reactions?: IReaction[];
  pinned?: boolean;
  pinnedAt?: Date | null;
  pinnedBy?: string | null;
  /** Mensaje del sistema: sin texto, la interfaz lo arma con el evento y el autor. */
  systemEvent?: SystemEvent;
  /** Id del evento de RabbitMQ que lo creó (message_id del Outbox): una entrega repetida no lo duplica. */
  sourceEventId?: string;
  /** Respuesta de hilo: id del mensaje raíz. No aparece en el historial del canal (ADR-07). */
  threadParentId?: mongoose.Types.ObjectId;
  /** Solo en el raíz de un hilo con al menos una respuesta. */
  thread?: IThreadSummary;
  /** Solo en un mensaje con algo pendiente (ver IThreadOutbox). */
  outbox?: IThreadOutbox;
  /** Mensaje citado, si responde a uno. */
  replyTo?: IReplyTo;
}

const AttachmentSchema = new Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  url: { type: String, required: true },
  size: { type: Number, required: true },
  contentType: { type: String, required: true },
}, { _id: false });

const ReactionSchema = new Schema({
  emoji: { type: String, required: true },
  count: { type: Number, required: true, default: 1 },
  users: { type: [String], default: [] },
  emojiId: { type: String, default: undefined },
}, { _id: false });

const ThreadSummarySchema = new Schema({
  replyCount: { type: Number, required: true, default: 0 },
  lastReplyAt: { type: Date, required: true },
  lastReplyId: { type: Schema.Types.ObjectId, required: true },
  participantIds: { type: [String], default: [] },
  replierIds: { type: [String], default: undefined },
}, { _id: false });

const ReplyToSchema = new Schema({
  id: { type: Schema.Types.ObjectId, required: true },
  authorId: { type: String, required: true },
  content: { type: String, default: '' },
  deleted: { type: Boolean, default: undefined },
}, { _id: false });

const ThreadOutboxSchema = new Schema({
  eventId: { type: String, default: undefined },
  summaryPending: { type: Boolean, default: undefined },
  serverId: { type: String, default: '' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, required: true },
}, { _id: false });

const MessageSchema: Schema = new Schema({
  content: {
    type: String,
    required: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function (this: any) {
        return !this.isDeleted && !this.systemEvent && (!this.attachments || this.attachments.length === 0);
      },
      'Content is required',
    ],
    default: '',
    trim: true,
    maxlength: [2000, 'Message exceeds maximum length of 2000 characters'],
    validate: [
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        validator: function (this: any, v: string) {
          if (this.isDeleted || this.systemEvent) {
            return true;
          }
          if (!this.attachments || this.attachments.length === 0) {
            return typeof v === 'string' && v.trim().length >= 1;
          }
          return true;
        },
        message: 'Message cannot be empty',
      },
      {
        validator: function (v: string) {
          return !v || !/\x00/.test(v);
        },
        message: 'Message cannot contain null characters',
      },
    ],
  },
  authorId: {
    type: String,
    required: [true, 'Author ID is required'],
    trim: true,
  },
  channelId: {
    type: String,
    required: [true, 'Channel ID is required'],
    trim: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  mentionUserIds: { type: [String], default: undefined },
  mentionRoleIds: { type: [String], default: undefined },
  mentionEveryone: { type: Boolean, default: undefined },
  attachments: { type: [AttachmentSchema], default: undefined },
  edited: { type: Boolean, default: false },
  editedAt: { type: Date, default: null },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
  reactions: { type: [ReactionSchema], default: undefined },
  pinned: { type: Boolean, default: false },
  pinnedAt: { type: Date, default: null },
  pinnedBy: { type: String, default: null },
  systemEvent: { type: String, enum: SYSTEM_EVENTS, default: undefined },
  sourceEventId: { type: String, default: undefined },
  threadParentId: { type: Schema.Types.ObjectId, default: undefined },
  thread: { type: ThreadSummarySchema, default: undefined },
  outbox: { type: ThreadOutboxSchema, default: undefined },
  replyTo: { type: ReplyToSchema, default: undefined },
}, {
  strict: true,
});

MessageSchema.index({ channelId: 1, createdAt: -1 });
MessageSchema.index({ channelId: 1, _id: 1 });
// Métricas del backoffice (`/internal/metrics/messages`): rango de fechas y autores distintos sin collection scan.
MessageSchema.index({ createdAt: 1, authorId: 1 });
// Fijados de un canal (`GET /channels/:id/pins`): solo indexa los mensajes fijados.
MessageSchema.index({ channelId: 1, pinnedAt: -1 }, { partialFilterExpression: { pinned: true } });
// Idempotencia de los mensajes del sistema: solo indexa los que vienen de un evento.
MessageSchema.index({ sourceEventId: 1 }, { unique: true, partialFilterExpression: { sourceEventId: { $type: 'string' } } });

// Respuestas de un hilo (`GET …/messages/:id/thread`): solo indexa las respuestas.
MessageSchema.index({ threadParentId: 1, _id: 1 }, { partialFilterExpression: { threadParentId: { $type: 'objectId' } } });

// Outbox de los hilos: el relay busca lo vencido. Solo indexa las respuestas con algo pendiente (casi nunca hay).
// Para actualizar las citas cuando el original se edita o se borra
MessageSchema.index({ 'replyTo.id': 1 }, { partialFilterExpression: { replyTo: { $type: 'object' } } });
MessageSchema.index({ 'outbox.nextAttemptAt': 1 }, { partialFilterExpression: { outbox: { $type: 'object' } } });

export const Message = mongoose.model<IMessage>('Message', MessageSchema);

