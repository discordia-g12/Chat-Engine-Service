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

    it('should upload to S3 when S3 is configured, and answer with a signed URL', async () => {
      process.env.S3_BUCKET = 'my-bucket';
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
      delete process.env.AWS_REGION;

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
        assert.match(
          attachment.url,
          /^https:\/\/my-bucket\.s3\.us-east-1\.amazonaws\.com\/attachments\/channel-s3\/att-.*cloud\.png\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.*&X-Amz-Signature=[0-9a-f]{64}$/
        );
        assert.ok(sentCommand);
        assert.strictEqual(sentCommand.input.Bucket, 'my-bucket');
        assert.match(sentCommand.input.Key, /^attachments\/channel-s3\/att-.*cloud\.png$/);
        assert.strictEqual(sentCommand.input.ContentType, 'image/png');
      } finally {
        delete process.env.S3_BUCKET;
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        S3Client.prototype.send = originalSend;
      }
    });
  });

  describe('signAttachmentUrl', () => {
    const stored = 'https://my-bucket.s3.us-east-1.amazonaws.com/attachments/dm-abc/att-1-foto.png';
    const now = new Date('2026-11-24T15:30:00Z');

    const withS3 = (fn: () => void) => {
      process.env.S3_BUCKET = 'my-bucket';
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
      delete process.env.AWS_REGION;
      try {
        fn();
      } finally {
        delete process.env.S3_BUCKET;
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
      }
    };

    it('without S3 the URL goes out as is (local disk)', () => {
      const local = '/api/v1/chat/uploads/attachments/c1/att-1-a.png';
      assert.strictEqual(StorageService.signAttachmentUrl(local, 'c1', now), local);
    });

    it('signs an attachment of the same channel, valid for 24 h from the start of the 12 h window', () => {
      withS3(() => {
        const url = new URL(StorageService.signAttachmentUrl(stored, 'dm-abc', now));
        assert.strictEqual(url.host, 'my-bucket.s3.us-east-1.amazonaws.com');
        assert.strictEqual(url.pathname, '/attachments/dm-abc/att-1-foto.png');
        assert.strictEqual(url.searchParams.get('X-Amz-Date'), '20261124T120000Z');
        assert.strictEqual(url.searchParams.get('X-Amz-Expires'), '86400');
        assert.strictEqual(url.searchParams.get('X-Amz-Credential'), 'test-key/20261124/us-east-1/s3/aws4_request');
        assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
      });
    });

    it('gives the same URL inside a 12 h window (cacheable) and a new one after it', () => {
      withS3(() => {
        const a = StorageService.signAttachmentUrl(stored, 'dm-abc', new Date('2026-11-24T12:00:00Z'));
        const b = StorageService.signAttachmentUrl(stored, 'dm-abc', new Date('2026-11-24T23:59:59Z'));
        const c = StorageService.signAttachmentUrl(stored, 'dm-abc', new Date('2026-11-25T00:00:00Z'));
        assert.strictEqual(a, b);
        assert.notStrictEqual(a, c);
      });
    });

    it('re-signs a stored URL that already had an (old) signature', () => {
      withS3(() => {
        const old = `${stored}?X-Amz-Signature=deadbeef&X-Amz-Date=20200101T000000Z`;
        assert.strictEqual(
          StorageService.signAttachmentUrl(old, 'dm-abc', now),
          StorageService.signAttachmentUrl(stored, 'dm-abc', now)
        );
      });
    });

    it('does not sign an attachment of another channel: it goes out without signature (S3 answers 403)', () => {
      withS3(() => {
        const signed = `${stored}?X-Amz-Signature=deadbeef`;
        assert.strictEqual(StorageService.signAttachmentUrl(signed, 'dm-otro', now), stored);
        const sneaky = 'https://my-bucket.s3.us-east-1.amazonaws.com/attachments/dm-abc/../dm-otro/x.png';
        assert.ok(!StorageService.signAttachmentUrl(sneaky, 'dm-abc', now).includes('X-Amz-Signature'));
      });
    });

    it('leaves URLs of other hosts and invalid URLs as they are', () => {
      withS3(() => {
        const other = 'https://example.com/attachments/dm-abc/x.png';
        assert.strictEqual(StorageService.signAttachmentUrl(other, 'dm-abc', now), other);
        assert.strictEqual(StorageService.signAttachmentUrl('no es una url', 'dm-abc', now), 'no es una url');
        const avatar = 'https://my-bucket.s3.us-east-1.amazonaws.com/avatars/x.webp';
        assert.strictEqual(StorageService.signAttachmentUrl(avatar, 'dm-abc', now), avatar);
      });
    });
  });
});
