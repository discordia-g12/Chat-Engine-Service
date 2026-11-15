import { FastifyRequest } from 'fastify';
import { NotFoundError } from '../errors';

/**
 * `onRequest` de los plugins con rutas `/internal/*`: las consumen otros servicios por la red del nodo, sin JWT
 * y sin pasar por Kong.
 *
 * Kong enruta `/api/v1/chat` con `strip_path`, así que `/api/v1/chat/internal/...` llegaría acá con el token
 * de cualquier usuario. Lo que pasa por Kong trae `X-User-Id` (lo pone el validador, que borra el que mande
 * el cliente) y `X-Forwarded-Prefix`: con cualquiera de los dos se responde 404, como si no existiera.
 */
export async function rejectProxiedRequests(req: FastifyRequest): Promise<void> {
  if (req.headers['x-user-id'] !== undefined || req.headers['x-forwarded-prefix'] !== undefined) {
    throw new NotFoundError(`Route ${req.method} ${req.url} not found`);
  }
}
