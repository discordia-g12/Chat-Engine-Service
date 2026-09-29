import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage extends Document {
  content: string;
  authorId: string;
  channelId: string;
  createdAt: Date;
}

const MessageSchema: Schema = new Schema({
  content: {
    type: String,
    required: [true, 'Content is required'],
    trim: true,
    minlength: [1, 'Message cannot be empty'],
    maxlength: [2000, 'Message exceeds maximum length of 2000 characters'],
    validate: {
      validator: function(v: string) {
        return !/\x00/.test(v);
      },
      message: 'Message cannot contain null characters'
    }
  },
  authorId: {
    type: String,
    required: [true, 'Author ID is required'],
    trim: true
  },
  channelId: {
    type: String,
    required: [true, 'Channel ID is required'],
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  strict: true
});

MessageSchema.index({ channelId: 1, createdAt: -1 });

export const Message = mongoose.model<IMessage>('Message', MessageSchema);
