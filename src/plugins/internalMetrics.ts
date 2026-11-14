import { FastifyInstance } from 'fastify';
import { NotFoundError, ValidationError } from '../errors';
import { MetricsService } from '../services/MetricsService';

// Fecha (YYYY-MM-DD) o fecha y hora con zona opcional: `new Date()` sola acepta "2026" o un timestamp.
// Las partes opcionales se sacan por separado para no anidar cuantificadores (security/detect-unsafe-regex).
const ISO_DATE = /^\d{4}-\d\d-\d\d$/;
const ISO_ZONE = /(Z|[+-]\d\d:\d\d)$/;
const ISO_FRACTION = /\.\d{1,9}$/;
const ISO_TIME = /^\d\d:\d\d(:\d\d)?$/;

function isIso8601(value: string): boolean {
  const [date, time, ...rest] = value.split('T');
  if (rest.length > 0 || !ISO_DATE.test(date)) return false;
  return time === undefined || ISO_TIME.test(time.replace(ISO_ZONE, '').replace(ISO_FRACTION, ''));
}

function parseIsoDate(name: string, value: unknown): Date {
  if (value === undefined || value === '') {
    throw new ValidationError(`Falta el parámetro '${name}'.`);
  }
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (typeof value !== 'string' || !isIso8601(value) || Number.isNaN(date.getTime())) {
    throw new ValidationError(`'${name}' no es una fecha ISO 8601 válida.`);
  }
  return date;
}

/**
 * Rutas `/internal/*`: las consumen otros servicios por la red del nodo, sin JWT y sin pasar por Kong.
 *
 * Kong enruta `/api/v1/chat` con `strip_path`, así que `/api/v1/chat/internal/...` llegaría acá con el token
 * de cualquier usuario. Lo que pasa por Kong trae `X-User-Id` (lo pone el validador, que borra el que mande
 * el cliente) y `X-Forwarded-Prefix`: con cualquiera de los dos se responde 404, como si no existiera.
 */
export default async function internalMetricsPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    if (req.headers['x-user-id'] !== undefined || req.headers['x-forwarded-prefix'] !== undefined) {
      throw new NotFoundError(`Route ${req.method} ${req.url} not found`);
    }
  });

  app.get('/internal/metrics/messages', async (req) => {
    const { from: rawFrom, to: rawTo } = (req.query ?? {}) as Record<string, unknown>;
    const from = parseIsoDate('from', rawFrom);
    const to = parseIsoDate('to', rawTo);
    if (from.getTime() >= to.getTime()) {
      throw new ValidationError("'from' tiene que ser anterior a 'to'.");
    }

    const { messages, activeUsers } = await MetricsService.messageMetrics(from, to);
    return { from: from.toISOString(), to: to.toISOString(), messages, activeUsers };
  });

  app.post('/internal/metrics/messages', async (req) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const from = parseIsoDate('from', body.from);
    const to = parseIsoDate('to', body.to);
    if (from.getTime() >= to.getTime()) {
      throw new ValidationError("'from' tiene que ser anterior a 'to'.");
    }
    if (
      !Array.isArray(body.channelIds) ||
      body.channelIds.some((id) => typeof id !== 'string' || id.trim().length === 0)
    ) {
      throw new ValidationError("'channelIds' debe ser un arreglo de IDs de canal.");
    }
    const channelIds = body.channelIds.map((id) => id.trim());
    const result = await MetricsService.channelMessageMetrics(from, to, channelIds);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      messages: result.messages,
      activeUsers: result.activeUsers,
      daily: result.daily,
    };
  });
}
