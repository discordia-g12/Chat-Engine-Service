import { timingSafeEqual } from 'node:crypto';
import { FastifyRequest } from 'fastify';
import { NotFoundError, UnauthorizedError } from '../errors';

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

let warnedMissingToken = false;

/**
 * `onRequest` de las rutas `/internal/*` que publican algo a nombre de otro servicio (hoy, el inbox). Exige
 * `X-Internal-Token` igual a `INTERNAL_API_TOKEN` (V9): la red sola no alcanza, cualquiera que llegue al 3000
 * del nodo podría avisarle cualquier cosa a cualquier usuario.
 *
 * shortcut: sin `INTERNAL_API_TOKEN` no se exige (avisa una vez en el log), para desplegar Voice y Notification
 * mandándolo antes de cargar el secreto. Volverlo obligatorio cuando esté cargado en todos los nodos.
 */
export async function requireInternalToken(req: FastifyRequest): Promise<void> {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    if (!warnedMissingToken) {
      warnedMissingToken = true;
      req.log.warn('INTERNAL_API_TOKEN is not set: internal publish routes accept requests without a token');
    }
    return;
  }

  const received = req.headers['x-internal-token'];
  const given = Buffer.from(typeof received === 'string' ? received : '');
  const wanted = Buffer.from(expected);
  // timingSafeEqual exige el mismo largo; comparar el largo antes no filtra el secreto, solo su longitud
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw new UnauthorizedError('Missing or invalid internal token');
  }
}
