## ADR 07: Hilos de conversación

**Contexto:**
La historia "Responder en un hilo" pide responder a un mensaje dentro de un hilo, sin interrumpir el canal:
abrir el hilo desde el mensaje, ver cuántas respuestas tiene, ver el mensaje original arriba y avisar a quienes
participan cuando llega una respuesta, según sus preferencias. Aplica a canales de servidor y a DMs, en web y
mobile.

Restricciones que condicionan el diseño:

* **El canal se lee paginado** (`getHistory`, `getMissedMessages`) y los no leídos se cuentan por canal
  (ADR-02). Si una respuesta se guarda como un mensaje más del canal, aparece en los tres lados.
* **Los clientes agregan al canal cualquier payload con `id` y `content`** que llegue por el socket. Un
  cliente viejo pondría una respuesta en el canal principal.
* **Los avisos no son de Chat.** Las preferencias de notificación y la bandeja viven en Notification-Audit-
  Metrics (ADR 0017 de la organización). Chat sabe quién participa; no sabe a quién le interesa.
* **Atlas M0**: sin transacciones caras ni colecciones grandes de más.

**Decisión:**

* **Un solo nivel.** Una respuesta guarda `threadParentId` (el raíz). Responder a una respuesta es `400` con
  `code: THREAD_NESTED`; un mensaje del sistema tampoco abre hilo.
* **Mismo modelo y mismas rutas de edición.** Una respuesta es un `Message` con `threadParentId`: editar,
  borrar y reaccionar usan las rutas de siempre y viajan como `MESSAGE_*` con `threadParentId`, para que el
  cliente sepa a qué caché va. No se fija (`400`): los fijados son del canal.
* **Fuera del canal.** El historial, la reconexión y los no leídos filtran `threadParentId: { $exists: false }`
  (`NOT_A_THREAD_REPLY`). La búsqueda sí las incluye, con `threadParentId` para abrir el hilo.
* **Resumen en el raíz:** `thread: { replyCount, lastReplyAt, lastReplyId, participantIds }`, actualizado con un
  solo `findOneAndUpdate` de pipeline (atómico): suma uno, `$max` para la última respuesta y participantes sin
  repetir. Los participantes son el autor del raíz, quienes respondieron y los mencionados, con tope de 100: al
  llegar al tope se conservan los que estaban. Borrar una respuesta resta uno (solo la primera vez) y se publica
  el raíz como `MESSAGE_UPDATED`. Un raíz borrado conserva el hilo.
* **Rutas**, detrás de `channelAccessGuard`:
  * `GET /channels/:channelId/messages/:messageId/thread?after=&limit=`: `{ parent, replies, hasMore,
    nextCursor }`, de la más vieja a la más nueva (50, hasta 100), índice parcial `{ threadParentId: 1, _id: 1 }`.
  * `POST` sobre la misma ruta, o el socket del canal con `threadParentId`. En un canal exige `canSend`; en un
    DM, las reglas de cada envío (`DM_NOT_DELIVERABLE`, `DM_PENDING`). Una respuesta no acepta un DM pendiente
    ni cambia el resumen de la conversación, y no marca el canal como leído.
* **Realtime:** `THREAD_REPLY_CREATED { channelId, parentId, reply, thread }` al canal; en un DM además
  `DM_THREAD_REPLY_CREATED` al inbox de los dos. Es un evento con `type`: un cliente viejo lo ignora.
* **Aviso a Notification:** `chat.message.created` en `server.events`, con `thread_participant_ids` sin el
  autor y sin quienes ya no son miembros (una llamada a `/internal/servers/{id}/member-ids`). El contrato es
  general (lleva menciones y `is_dm`) para que las historias de notificaciones lo reutilicen. Sale después de
  responder, sin demorar la respuesta. Si Server-Roles no responde, no se publica: antes perder un aviso que
  mandarle el texto a quien se fue del servidor.

**Alternativas descartadas:**

| Alternativa | Por qué se descartó |
|---|---|
| Colección aparte `ThreadReply` | Duplica edición, borrado, reacciones, adjuntos y búsqueda. Con el mismo modelo todo eso ya funciona. |
| Hilos anidados (responder a una respuesta) | Complica la UI en mobile y el resumen; ninguna historia lo pide. Se puede abrir después sin migrar datos. |
| Contar respuestas al leer (`countDocuments` por mensaje) | Una consulta por mensaje en cada página del historial (N+1). El contador en el raíz viaja en el payload. |
| Mandar la respuesta como un mensaje crudo con `threadParentId` | Los clientes que no conocen el campo la agregarían al canal principal. |
| Que Chat decida a quién avisar | Obliga a Chat a leer las preferencias de Notification en cada mensaje. Chat manda quién participa y Notification filtra. |
| Outbox en Mongo para el evento | Chat no tiene outbox ni worker; agregarlo es otro cambio. Se acepta perder un aviso, nunca el mensaje (queda en la deuda técnica). |

**Consecuencias:**

* Una escritura extra por respuesta (el raíz) y, en un servidor, una llamada a Server-Roles fuera del camino de
  la respuesta.
* Si el proceso se cae entre guardar la respuesta y actualizar el raíz, el contador queda uno abajo. No hay
  transacción: se acepta, igual que el límite de fijados (ADR-05).
* El texto del aviso es el contenido recortado a 140 caracteres, con las menciones en su formato crudo
  (`<@id>`): la interfaz las resuelve.
* Un cliente que se reconecta no recibe las respuestas que se perdió por el socket: las relee al abrir el hilo.
* Compatibilidad: solo se suman campos. Los mensajes viejos no tienen `thread` ni `threadParentId`.
