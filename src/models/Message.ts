import mongoose, { Schema, Document } from 'mongoose';

export interface IAttachment {
  id: string;
  name: string;
  url: string;
  size: number;
  contentType: string;
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
}

const AttachmentSchema = new Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  url: { type: String, required: true },
  size: { type: Number, required: true },
  contentType: { type: String, required: true },
}, { _id: false });

const MessageSchema: Schema = new Schema({
  content: {
    type: String,
    required: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function (this: any) {
        return !this.attachments || this.attachments.length === 0;
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
}, {
  strict: true,
});

MessageSchema.index({ channelId: 1, createdAt: -1 });
MessageSchema.index({ channelId: 1, _id: 1 });

export const Message = mongoose.model<IMessage>('Message', MessageSchema);

