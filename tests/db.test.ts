import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../src/config/db';

describe('Database Connection', () => {
  let mongoServer: MongoMemoryServer;
  let originalUri: string | undefined;

  before(async () => {
    mongoServer = await MongoMemoryServer.create();
    originalUri = process.env.MONGO_URI;
    process.env.MONGO_URI = mongoServer.getUri();
  });

  after(async () => {
    await disconnectDB();
    await mongoServer.stop();
    process.env.MONGO_URI = originalUri;
  });

  it('should connect to the database successfully', async () => {
    await connectDB();
    assert.strictEqual(mongoose.connection.readyState, 1);
  });

  it('should not reconnect if already connected', async () => {
    await connectDB(); 
    assert.strictEqual(mongoose.connection.readyState, 1);
  });

  it('should disconnect from the database successfully', async () => {
    await disconnectDB();
    assert.strictEqual(mongoose.connection.readyState, 0);
  });

  it('should not throw error if disconnecting when already disconnected', async () => {
    await disconnectDB(); 
    assert.strictEqual(mongoose.connection.readyState, 0);
  });

  it('should throw an error for invalid URI', async () => {
    process.env.MONGO_URI = 'mongodb://invalid-host:99999/test';
    try {
      await connectDB();
      assert.fail('Should have thrown an error');
    } catch (error) {
      assert.ok(error);
    }
  });

  it('should attempt to use default URI if MONGO_URI is missing', async () => {
    await disconnectDB(); // ensure disconnected
    delete process.env.MONGO_URI;
    
    // Mock para evitar timeout de 30 segundos conectando a localhost real
    const connectMock = mock.method(mongoose, 'connect', async (uri: string) => {
      assert.strictEqual(uri, 'mongodb://localhost:27017/discordia_chat');
      throw new Error('Simulated default connect error');
    });

    try {
      await connectDB();
    } catch (error) {
      assert.strictEqual((error as Error).message, 'Simulated default connect error');
    }
    
    connectMock.mock.restore();
    process.env.MONGO_URI = mongoServer.getUri();
  });
});
