import { Message } from '../models/Message';

export interface MessageMetrics {
  messages: number;
  activeUsers: number;
}

export interface DailyChannelMetrics extends MessageMetrics {
  date: string;
}

export interface ChannelMetrics extends MessageMetrics {
  daily: DailyChannelMetrics[];
}

/** Los mensajes del sistema ("se unió …") no cuentan: no los mandó nadie. */
const SENT_BY_USERS = { systemEvent: { $exists: false } };

/**
 * Métricas de plataforma para el backoffice, consultadas en el momento por Notification-Audit-Metrics.
 * Cuentan mensajes de canales y de DMs (los dos viven en `Message`), borrados incluidos: se enviaron igual.
 * Los del sistema, no.
 */
export const MetricsService = {
  /**
   * Mensajes en `[from, to)` y autores distintos (usuario activo = mandó al menos un mensaje).
   * Un solo aggregate en vez de `distinct`, que devuelve un documento y tiene el límite de 16 MB.
   * Usa el índice `{ createdAt: 1, authorId: 1 }`.
   */
  async messageMetrics(from: Date, to: Date): Promise<MessageMetrics> {
    const [result] = await Message.aggregate<MessageMetrics>([
      { $match: { createdAt: { $gte: from, $lt: to }, ...SENT_BY_USERS } },
      { $group: { _id: '$authorId', count: { $sum: 1 } } },
      { $group: { _id: null, messages: { $sum: '$count' }, activeUsers: { $sum: 1 } } },
      { $project: { _id: 0, messages: 1, activeUsers: 1 } },
    ]);
    return result ?? { messages: 0, activeUsers: 0 };
  },

  /**
   * Métricas por servidor en `[from, to)` filtrando por sus `channelIds` (usa el índice `{ channelId: 1, createdAt: -1 }`).
   * Devuelve totales y serie diaria UTC en una única consulta agregada.
   */
  async channelMessageMetrics(from: Date, to: Date, channelIds: string[]): Promise<ChannelMetrics> {
    if (channelIds.length === 0) {
      return { messages: 0, activeUsers: 0, daily: [] };
    }
    const [facetResult] = await Message.aggregate<{
      totals: MessageMetrics[];
      daily: DailyChannelMetrics[];
    }>([
      { $match: { channelId: { $in: channelIds }, createdAt: { $gte: from, $lt: to }, ...SENT_BY_USERS } },
      {
        $facet: {
          totals: [
            { $group: { _id: '$authorId', count: { $sum: 1 } } },
            { $group: { _id: null, messages: { $sum: '$count' }, activeUsers: { $sum: 1 } } },
            { $project: { _id: 0, messages: 1, activeUsers: 1 } },
          ],
          daily: [
            {
              $group: {
                _id: {
                  date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                  authorId: '$authorId',
                },
                count: { $sum: 1 },
              },
            },
            {
              $group: {
                _id: '$_id.date',
                messages: { $sum: '$count' },
                activeUsers: { $sum: 1 },
              },
            },
            { $project: { _id: 0, date: '$_id', messages: 1, activeUsers: 1 } },
            { $sort: { date: 1 } },
          ],
        },
      },
    ]);
    const totals = facetResult?.totals[0];
    return {
      messages: totals?.messages ?? 0,
      activeUsers: totals?.activeUsers ?? 0,
      daily: facetResult?.daily ?? [],
    };
  },
};
