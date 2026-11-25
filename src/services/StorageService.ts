import path from 'node:path';
import crypto from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PayloadTooLargeError, ValidationError } from '../errors';
import type { MessageAttachmentPayload } from './ChatService';
import { fileSystem as fs } from '../helpers/fs';
import { presignS3Get, s3Host, s3ObjectPath } from '../helpers/s3Presign';

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB

/** Validez de la URL firmada de un adjunto. */
export const ATTACHMENT_URL_TTL_SECONDS = 24 * 60 * 60;
/** Cada cuánto cambia la firma (la mitad del TTL): mientras tanto la URL es la misma y se cachea. */
export const ATTACHMENT_URL_STABLE_SECONDS = 12 * 60 * 60;

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

  private static region(): string {
    return process.env.AWS_REGION || 'us-east-1';
  }

  /** Host del bucket donde quedan los adjuntos (`<bucket>.s3.<region>.amazonaws.com`). */
  static attachmentHost(): string {
    return s3Host(process.env.S3_BUCKET || '', this.region());
  }

  /**
   * URL firmada (vence) de un adjunto guardado en S3, para mandarla a un cliente. Solo se firma un adjunto
   * de `channelId`: el cliente arma la lista de adjuntos del mensaje, así que pegar la URL de un archivo de
   * otro canal (u otro DM) no le da acceso, porque sale sin firma y S3 responde 403. Cualquier otra URL
   * (adjuntos viejos en disco, o sin S3 configurado) sale tal cual.
   */
  static signAttachmentUrl(url: string, channelId: string, now: Date = new Date()): string {
    if (!this.isS3Configured()) return url;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return url;
    }
    if (parsed.protocol !== 'https:' || parsed.host !== this.attachmentHost()) return url;

    let key: string;
    try {
      key = decodeURIComponent(parsed.pathname.slice(1));
    } catch {
      return `https://${parsed.host}${parsed.pathname}`;
    }
    if (!key.startsWith(`attachments/${channelId}/`) || key.includes('..')) {
      return `https://${parsed.host}${parsed.pathname}`;
    }

    // Firma con la hora redondeada a bloques de 12 h y validez de 24 h: la URL de un adjunto no cambia en
    // cada mensaje que sale (el navegador la cachea) y siempre le quedan al menos 12 h de vida
    const window = ATTACHMENT_URL_STABLE_SECONDS * 1000;
    const signedAt = new Date(Math.floor(now.getTime() / window) * window);

    return presignS3Get({
      bucket: process.env.S3_BUCKET || '',
      key,
      region: this.region(),
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
      expiresIn: ATTACHMENT_URL_TTL_SECONDS,
      signedAt,
    });
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
          // private: lo cachea el navegador de quien lo pidió con su URL firmada, ningún intermediario
          CacheControl: 'private, max-age=31536000, immutable',
        })
      );

      // El prefijo attachments/ es privado: el mensaje guarda la URL sin firma (sola da 403) y cada vez que
      // sale hacia un cliente se firma (signAttachmentUrl, desde toPayload). La respuesta ya va firmada.
      const url = `https://${this.attachmentHost()}${s3ObjectPath(key)}`;

      return {
        id,
        name: filename,
        url: this.signAttachmentUrl(url, channelId),
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

