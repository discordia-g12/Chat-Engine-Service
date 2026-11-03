import fs from 'node:fs';
import { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { channelAccessGuard } from '../helpers/auth';
import { ForbiddenError, PayloadTooLargeError, ValidationError } from '../errors';
import { StorageService, MAX_ATTACHMENT_SIZE } from '../services/StorageService';

export default async function attachmentsPlugin(app: FastifyInstance) {
  await app.register(multipart, {
    limits: {
      fileSize: MAX_ATTACHMENT_SIZE,
      files: 1,
    },
  });

  const uploadDir = StorageService.getUploadDir();
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: '/uploads/',
    decorateReply: false,
  });

  // Servir también con el prefijo completo por si se llama directo a Chat-Engine sin strip_path
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: '/api/v1/chat/uploads/',
    decorateReply: false,
  });

  app.post(
    '/channels/:channelId/attachments',
    { preValidation: channelAccessGuard },
    async (req, reply) => {
      if (req.canSend === false) {
        throw new ForbiddenError('User does not have permission to send messages in this channel');
      }

      const { channelId } = req.params as { channelId: string };
      const fileData = await req.file();
      if (!fileData) {
        throw new ValidationError('No file was uploaded');
      }

      const buffer = await fileData.toBuffer();
      if (fileData.file.truncated || buffer.length > MAX_ATTACHMENT_SIZE) {
        throw new PayloadTooLargeError('El archivo supera el tamaño máximo permitido de 10 MB.');
      }

      const attachment = await StorageService.saveAttachment(channelId, {
        filename: fileData.filename,
        mimetype: fileData.mimetype,
        data: buffer,
      });

      reply.status(201);
      return attachment;
    }
  );
}

