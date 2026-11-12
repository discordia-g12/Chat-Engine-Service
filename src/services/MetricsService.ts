import { Message } from '../models/Message';

export interface MessageMetrics {
  messages: number;
  activeUsers: number;
}

/**
 * Métricas de plataforma para el backoffice, consultadas en el momento por Notification-Audit-Metrics.
 * Cuentan mensajes de canales y de DMs (los dos viven en `Message`), borrados incluidos: se enviaron igual.
 */
export const MetricsService = {
  /**
   * Mensajes en `[from, to)` y autores distintos (usuario activo = mandó al menos un mensaje).
   * Un solo aggregate en vez de `distinct`, que devuelve un documento y tiene el límite de 16 MB.
   * Usa el índice `{ createdAt: 1, authorId: 1 }`.
   */
  async messageMetrics(from: Date, to: Date): Promise<MessageMetrics> {
    const [result] = await Message.aggregate<MessageMetrics>([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      { $group: { _id: '$authorId', count: { $sum: 1 } } },
      { $group: { _id: null, messages: { $sum: '$count' }, activeUsers: { $sum: 1 } } },
      { $project: { _id: 0, messages: 1, activeUsers: 1 } },
    ]);
    return result ?? { messages: 0, activeUsers: 0 };
  },
};
