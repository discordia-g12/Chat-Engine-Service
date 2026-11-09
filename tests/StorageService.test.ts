import { describe, it, after, mock } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { StorageService, MAX_ATTACHMENT_SIZE } from '../src/services/StorageService';
import { PayloadTooLargeError, ValidationError } from '../src/errors';
import { fileSystem as fs } from '../src/helpers/fs';

describe('StorageService', () => {
  const tmpUploadDir = path.join(process.cwd(), 'tmp-test-uploads');
  process.env.UPLOAD_DIR = tmpUploadDir;

  after(async () => {
    delete process.env.UPLOAD_DIR;
    if (fs.existsSync(tmpUploadDir)) {
      await fs.promises.rm(tmpUploadDir, { recursive: true, force: true });
    }
  });

  describe('validate', () => {
    it('should accept valid image and document formats under 10MB', () => {
      const validCases = [
        { filename: 'photo.jpg', mimetype: 'image/jpeg' },
        { filename: 'photo.jpeg', mimetype: 'image/jpeg' },
        { filename: 'image.png', mimetype: 'image/png' },
        { filename: 'sticker.webp', mimetype: 'image/webp' },
        { filename: 'animation.gif', mimetype: 'image/gif' },
        { filename: 'document.pdf', mimetype: 'application/pdf' },
        { filename: 'notes.txt', mimetype: 'text/plain' },
        { filename: 'archive.zip', mimetype: 'application/zip' },
        { filename: 'archive2.zip', mimetype: 'application/x-zip-compressed' },
      ];

      for (const item of validCases) {
        assert.doesNotThrow(() => {
          StorageService.validate(item.filename, item.mimetype, 1024);
        }, `Should allow ${item.filename}`);
      }
    });

    it('should reject invalid formats with CA 2 error message', () => {
      const invalidCases = [
        { filename: 'malware.exe', mimetype: 'application/x-msdownload' },
        { filename: 'script.sh', mimetype: 'application/x-sh' },
        { filename: 'code.js', mimetype: 'application/javascript' },
        { filename: 'page.html', mimetype: 'text/html' },
        { filename: 'archive.tar', mimetype: 'application/x-tar' },
      ];

      for (const item of invalidCases) {
        assert.throws(
          () => {
            StorageService.validate(item.filename, item.mimetype, 1024);
          },
          (err: unknown) => {
            assert.ok(err instanceof ValidationError);
            assert.strictEqual(
              (err as ValidationError).message,
              'Formato de archivo no permitido. Usá imágenes (JPG, PNG, WebP, GIF) o documentos (PDF, TXT, ZIP).'
            );
            return true;
          }
        );
      }
    });

    it('should reject files exceeding 10MB with CA 3 error message', () => {
      assert.throws(
        () => {
          StorageService.validate('big.png', 'image/png', MAX_ATTACHMENT_SIZE + 1);
        },
        (err: unknown) => {
          assert.ok(err instanceof PayloadTooLargeError);
          assert.strictEqual(
            (err as PayloadTooLargeError).message,
            'El archivo supera el tamaño máximo permitido de 10 MB.'
          );
          return true;
        }
      );
    });
  });

  describe('saveAttachment (local storage)', () => {
    it('should save file locally and return MessageAttachmentPayload', async () => {
      const content = Buffer.from('hello world image content');
      const attachment = await StorageService.saveAttachment('channel-123', {
        filename: 'avatar.png',
        mimetype: 'image/png',
        data: content,
      });

      assert.ok(attachment.id.startsWith('att-'));
      assert.strictEqual(attachment.name, 'avatar.png');
      assert.strictEqual(attachment.size, content.length);
      assert.strictEqual(attachment.contentType, 'image/png');
      assert.match(attachment.url, /\/api\/v1\/chat\/uploads\/attachments\/channel-123\/att-.*avatar\.png/);

      // Verify file was written to disk
      const filePath = path.join(
        tmpUploadDir,
        'attachments',
        'channel-123',
        path.basename(attachment.url)
      );
      assert.ok(fs.existsSync(filePath));
      const readContent = await fs.promises.readFile(filePath);
      assert.strictEqual(readContent.toString(), content.toString());
    });

    it('should upload to S3 when S3 is configured', async () => {
      process.env.S3_BUCKET = 'my-bucket';
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
      process.env.S3_PUBLIC_BASE_URL = 'https://cdn.discordia.app';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let sentCommand: any = null;
      const originalSend = S3Client.prototype.send;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mock.method(S3Client.prototype, 'send', async function (command: any) {
        sentCommand = command;
        return {};
      });

      try {
        const content = Buffer.from('s3 image content');
        const attachment = await StorageService.saveAttachment('channel-s3', {
          filename: 'cloud.png',
          mimetype: 'image/png',
          data: content,
        });

        assert.ok(attachment.id.startsWith('att-'));
        assert.strictEqual(attachment.name, 'cloud.png');
        assert.strictEqual(attachment.size, content.length);
        assert.strictEqual(attachment.contentType, 'image/png');
        assert.match(attachment.url, /^https:\/\/cdn\.discordia\.app\/attachments\/channel-s3\/att-.*cloud\.png$/);
        assert.ok(sentCommand);
        assert.strictEqual(sentCommand.input.Bucket, 'my-bucket');
        assert.strictEqual(sentCommand.input.ContentType, 'image/png');
      } finally {
        delete process.env.S3_BUCKET;
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        delete process.env.S3_PUBLIC_BASE_URL;
        S3Client.prototype.send = originalSend;
      }
    });
  });
});
