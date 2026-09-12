import mongoose from 'mongoose';

export async function connectDB(): Promise<void> {
  if (mongoose.connection.readyState >= 1) return;
  
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/discordia_chat';
  
  try {
    await mongoose.connect(uri);
    console.log('MongoDB Connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  console.log('MongoDB Disconnected');
}
