import mongoose, { Schema, Types } from 'mongoose';

export const CONVERSATION_STATUSES = ['pending', 'accepted', 'declined'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface IConversation {
  _id: Types.ObjectId;
  /** Los dos ids canónicos ordenados: el índice único garantiza una sola conversación por par. */
  participantKey: string;
  participantIds: string[];
  status: ConversationStatus;
  requestedBy: string;
  declinedBy?: string;
  lastMessageId?: Types.ObjectId;
  lastMessageAt: Date;
  lastMessagePreview?: string;
  lastMessageAuthorId?: string;
}

const ConversationSchema = new Schema<IConversation>(
  {
    participantKey: { type: String, required: true },
    participantIds: {
      type: [String],
      required: true,
      validate: {
        validator: (ids: string[]) => ids.length === 2,
        message: 'A conversation has exactly two participants',
      },
    },
    status: { type: String, enum: CONVERSATION_STATUSES, required: true },
    requestedBy: { type: String, required: true },
    declinedBy: { type: String },
    lastMessageId: { type: Schema.Types.ObjectId },
    lastMessageAt: { type: Date, required: true },
    lastMessagePreview: { type: String },
    lastMessageAuthorId: { type: String },
  },
  { strict: true }
);

ConversationSchema.index({ participantKey: 1 }, { unique: true });
ConversationSchema.index({ participantIds: 1, lastMessageAt: -1 });

export const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);
