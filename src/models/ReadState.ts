import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IReadState extends Document {
  userId: string;
  channelId: string;
  lastReadMessageId: Types.ObjectId;
  updatedAt: Date;
}

const ReadStateSchema: Schema = new Schema(
  {
    userId: { type: String, required: true, trim: true },
    channelId: { type: String, required: true, trim: true },
    lastReadMessageId: { type: Schema.Types.ObjectId, required: true },
  },
  { strict: true, timestamps: { createdAt: false, updatedAt: true } }
);

ReadStateSchema.index({ userId: 1, channelId: 1 }, { unique: true });

export const ReadState = mongoose.model<IReadState>('ReadState', ReadStateSchema);
