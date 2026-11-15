import path from 'node:path';
import crypto from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PayloadTooLargeError, ValidationError } from '../errors';
import { MessageAttachmentPayload } from './ChatService';
import { fileSystem as fs } from '../helpers/fs';

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.pdf',
  '.txt',
  '.zip',
]);

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream', // Para zips o binarios identificados por extensión
]);

export class StorageService {
  private static s3Client: S3Client | null = null;

  static isS3Configured(): boolean {
    return Boolean(
      process.env.S3_BUCKET &&
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY
    );
  }

  private static getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
        },
      });
    }
    return this.s3Client;
  }

  static validate(filename: string, mimetype: string, size?: number): void {
    if (size !== undefined && size > MAX_ATTACHMENT_SIZE) {
      throw new PayloadTooLargeError('El archivo supera el tamaño máximo permitido de 10 MB.');
    }

    const ext = path.extname(filename || '').toLowerCase();
    const isExtAllowed = ALLOWED_EXTENSIONS.has(ext);
    const isMimeAllowed = ALLOWED_MIME_TYPES.has(mimetype?.toLowerCase());

    // Si la extensión no está permitida, o el mime no está permitido (salvo que sea zip y octet-stream)
    if (!isExtAllowed || !isMimeAllowed) {
      throw new ValidationError(
        'Formato de archivo no permitido. Usá imágenes (JPG, PNG, WebP, GIF) o documentos (PDF, TXT, ZIP).'
      );
    }
  }

  static getUploadDir(): string {
    return process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
  }

  static async saveAttachment(
    channelId: string,
    file: { filename: string; mimetype: string; data: Buffer }
  ): Promise<MessageAttachmentPayload> {
    const { filename, mimetype, data } = file;

    this.validate(filename, mimetype, data.length);

    const id = `att-${crypto.randomUUID()}`;
    const ext = path.extname(filename || '').toLowerCase();
    const safeBase = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const storedFilename = `${id}-${safeBase || 'file'}${ext}`;

    if (this.isS3Configured()) {
      const bucket = process.env.S3_BUCKET!;
      const key = `attachments/${channelId}/${storedFilename}`;
      const s3 = this.getS3Client();

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: data,
          ContentType: mimetype,
          CacheControl: 'public, max-age=31536000, immutable',
        })
      );

      const baseUrl =
        process.env.S3_PUBLIC_BASE_URL ||
        `https://${bucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`;
      const url = `${baseUrl.replace(/\/$/, '')}/${key}`;

      return {
        id,
        name: filename,
        url,
        size: data.length,
        contentType: mimetype,
      };
    }

    // Modo local / pruebas
    const channelDir = path.join(this.getUploadDir(), 'attachments', channelId);
    await fs.promises.mkdir(channelDir, { recursive: true });
    const localFilePath = path.join(channelDir, storedFilename);
    await fs.promises.writeFile(localFilePath, data);

    const publicBase = (process.env.CHAT_PUBLIC_URL || '/api/v1/chat').replace(/\/$/, '');
    const url = `${publicBase}/uploads/attachments/${channelId}/${storedFilename}`;

    return {
      id,
      name: filename,
      url,
      size: data.length,
      contentType: mimetype,
    };
  }
}

