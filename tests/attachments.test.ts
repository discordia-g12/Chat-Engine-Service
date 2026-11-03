import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import buildApp from '../src/app';
import { connectDB, disconnectDB } from '../src/config/db';
import { MAX_ATTACHMENT_SIZE } from '../src/services/StorageService';

describe('Attachments Plugin & Storage Endpoints', () => {
  let app: FastifyInstance;
  let mongoServer: MongoMemoryServer;
  let originalFetch: typeof globalThis.fetch;
  const tmpUploadDir = path.join(process.cwd(), 'tmp-test-attachments-uploads');
  process.env.UPLOAD_DIR = tmpUploadDir;

  before(async () => {
    originalFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('banned-user') || urlStr.includes('no-access')) {
        return { status: 403 } as Response;
      }
      const canSend = !urlStr.includes('muted-user');
      return {
        status: 200,
        json: async () => ({ server_id: 'srv-1', can_send: canSend, muted_until: null }),
      } as Response;
    });

    mongoServer = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongoServer.getUri();
    await connectDB();

    app = buildApp();
    await app.listen({ port: 0 });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
    await disconnectDB();
    await mongoServer.stop();
    delete process.env.UPLOAD_DIR;
    if (fs.existsSync(tmpUploadDir)) {
      await fs.promises.rm(tmpUploadDir, { recursive: true, force: true });
    }
  });

  describe('POST /channels/:channelId/attachments', () => {
    it('should return 401 if X-User-Id header is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/channels/ch-1/attachments',
      });
      assert.strictEqual(res.statusCode, 401);
    });

    it('should return 403 if user cannot send in channel', async () => {
      const boundary = '----WebKitFormBoundaryTest';
      const body =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="photo.png"\r\n` +
        `Content-Type: image/png\r\n\r\n` +
        `fake-png-bytes\r\n` +
        `--${boundary}--\r\n`;

      const res = await app.inject({
        method: 'POST',
        url: '/channels/ch-1/attachments',
        headers: {
          'x-user-id': 'muted-user',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      assert.strictEqual(res.statusCode, 403);
    });

    it('should upload valid image successfully (CA 1)', async () => {
      const boundary = '----WebKitFormBoundaryTest';
      const body =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="valid_image.png"\r\n` +
        `Content-Type: image/png\r\n\r\n` +
        `some-valid-image-bytes\r\n` +
        `--${boundary}--\r\n`;

      const res = await app.inject({
        method: 'POST',
        url: '/channels/ch-1/attachments',
        headers: {
          'x-user-id': 'user-1',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      assert.strictEqual(res.statusCode, 201);
      const data = JSON.parse(res.payload);
      assert.ok(data.id);
      assert.strictEqual(data.name, 'valid_image.png');
      assert.strictEqual(data.contentType, 'image/png');
      assert.ok(data.url);
      assert.strictEqual(data.size, Buffer.from('some-valid-image-bytes').length);
    });

    it('should reject unsupported format with CA 2 error message', async () => {
      const boundary = '----WebKitFormBoundaryTest';
      const body =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="danger.exe"\r\n` +
        `Content-Type: application/x-msdownload\r\n\r\n` +
        `exe-bytes\r\n` +
        `--${boundary}--\r\n`;

      const res = await app.inject({
        method: 'POST',
        url: '/channels/ch-1/attachments',
        headers: {
          'x-user-id': 'user-1',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      assert.strictEqual(res.statusCode, 400);
      const data = JSON.parse(res.payload);
      assert.strictEqual(
        data.detail,
        'Formato de archivo no permitido. Usá imágenes (JPG, PNG, WebP, GIF) o documentos (PDF, TXT, ZIP).'
      );
    });

    it('should reject file exceeding 10MB with CA 3 error message', async () => {
      const boundary = '----WebKitFormBoundaryTest';
      // Construct a payload larger than 10MB
      const bigBuffer = Buffer.alloc(MAX_ATTACHMENT_SIZE + 100, 0x61);
      const prefix = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="huge.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`
      );
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([prefix, bigBuffer, suffix]);

      const res = await app.inject({
        method: 'POST',
        url: '/channels/ch-1/attachments',
        headers: {
          'x-user-id': 'user-1',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      assert.strictEqual(res.statusCode, 413);
      const data = JSON.parse(res.payload);
      assert.strictEqual(
        data.detail,
        'El archivo supera el tamaño máximo permitido de 10 MB.'
      );
    });
  });

  describe('POST /channels/:channelId/messages with attachments', () => {
    it('should persist message with attachments and return payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/channels/ch-1/messages',
        headers: {
          'x-user-id': 'user-1',
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          content: 'Look at this document',
          attachments: [
            {
              id: 'att-test-1',
              name: 'document.pdf',
              url: 'https://example.com/document.pdf',
              size: 5000,
              contentType: 'application/pdf',
            },
          ],
        }),
      });

      assert.strictEqual(res.statusCode, 201);
      const data = JSON.parse(res.payload);
      assert.strictEqual(data.content, 'Look at this document');
      assert.strictEqual(data.authorId, 'user-1');
      assert.ok(Array.isArray(data.attachments));
      assert.strictEqual(data.attachments.length, 1);
      assert.strictEqual(data.attachments[0].name, 'document.pdf');
    });

    it('should persist message with only attachments and empty content', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/channels/ch-1/messages',
        headers: {
          'x-user-id': 'user-1',
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          content: '',
          attachments: [
            {
              id: 'att-test-2',
              name: 'only_photo.png',
              url: 'https://example.com/photo.png',
              size: 12000,
              contentType: 'image/png',
            },
          ],
        }),
      });

      assert.strictEqual(res.statusCode, 201);
      const data = JSON.parse(res.payload);
      assert.strictEqual(data.content, '');
      assert.strictEqual(data.attachments[0].name, 'only_photo.png');
    });
  });
});
