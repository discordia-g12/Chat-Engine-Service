import { FastifyInstance } from 'fastify';
import { NotFoundError, PayloadTooLargeError, ValidationError } from '../errors';
import { rejectProxiedRequests } from '../helpers/internalOnly';
import { USER_NOT_FOUND } from '../helpers/directMessages';
import { ConversationService } from '../services/ConversationService';
import { PubSubService } from '../services/PubSubService';
import { RelationsService } from '../services/RelationsService';

const MAX_RECIPIENTS = 10;
const MAX_EVENT_BYTES = 8 * 1024;
// Solo reparte eventos de llamadas (Voice) y avisos (Notification, ADR 0017): el resto lo publica Chat por su cuenta
const ALLOWED_EVENT_PREFIXES = ['CALL_', 'NOTIFICATION_'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUserIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RECIPIENTS) {
    throw new ValidationError(`'userIds' tiene que ser una lista de 1 a ${MAX_RECIPIENTS} ids.`);
  }
  if (!value.every((id) => typeof id === 'string' && id.trim() !== '')) {
    throw new ValidationError("'userIds' solo puede tener ids no vacíos.");
  }
  return [...new Set(value as string[])];
}

function parseEvent(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ValidationError("Falta 'event' o no es un objeto.");
  }
  const type = value.type;
  if (typeof type !== 'string' || !ALLOWED_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix))) {
    throw new ValidationError(`'event.type' tiene que empezar con ${ALLOWED_EVENT_PREFIXES.map((p) => `'${p}'`).join(' o ')}.`);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_EVENT_BYTES) {
    throw new PayloadTooLargeError(`'event' no puede superar los ${MAX_EVENT_BYTES} bytes.`);
  }
  return value;
}

/**
 * Lo que necesita Voice-Signaling para las llamadas privadas (historia #50): si alguien puede llamar en una
 * conversación, el id canónico de un usuario y avisar por el inbox. Solo red del nodo: ver
 * `rejectProxiedRequests`.
 */
export default async function internalCallsPlugin(app: FastifyInstance) {
  app.addHook('onRequest', rejectProxiedRequests);

  app.get('/internal/conversations/:id/call-access', async (req) => {
    const { id } = req.params as { id: string };
    const { user_id: userId } = (req.query ?? {}) as Record<string, unknown>;
    if (typeof userId !== 'string' || userId === '') {
      throw new ValidationError("Falta el parámetro 'user_id'.");
    }
    return ConversationService.callAccess(userId, id);
  });

  app.get('/internal/users/:id/canonical', async (req) => {
    const { id } = req.params as { id: string };
    const user = await RelationsService.getCanonical(id);
    if (!user) throw new NotFoundError('User not found', { code: USER_NOT_FOUND });
    return { userId: user.userId, suspended: user.suspended };
  });

  app.post('/internal/inbox/events', async (req, reply) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const userIds = parseUserIds(body.userIds);
    const event = parseEvent(body.event);

    await Promise.all(userIds.map((userId) => PubSubService.publishToInbox(userId, event)));
    return reply.status(202).send();
  });
}
