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
* **Resumen en el raíz:** `thread: { replyCount, lastReplyAt, lastReplyId, participantIds, replierIds }`, actualizado con un
  solo `findOneAndUpdate` de pipeline (atómico): suma uno, `$max` para la última respuesta y participantes sin
  repetir. Los participantes son el autor del raíz, quienes respondieron y los mencionados, con tope de 100: al
  llegar al tope se conservan los que estaban. `replierIds` son solo quienes respondieron, en orden de primera
  respuesta (las fotos del resumen; los hilos anteriores lo completan con la próxima respuesta). Borrar una respuesta resta uno (solo la primera vez) y se publica
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
  responder, sin demorar la respuesta, con *publisher confirms*: solo cuenta como enviado si RabbitMQ lo
  confirmó. Si Server-Roles no responde se reintenta después (antes que mandarle el texto a quien se fue).
* **Outbox en la misma respuesta** (`outbox: { eventId, summaryPending, serverId, attempts, nextAttemptAt }`).
  Se escribe junto con la respuesta en una sola escritura de un documento, que en Mongo es atómica: no hace
  falta transacción. `summaryPending` dice que el resumen del raíz todavía no la cuenta (también al borrarla);
  `eventId` que el aviso no se confirmó. ThreadService completa los dos en el momento y saca el outbox.
* **Relay** (`ThreadOutbox`, cada 10 s): toma lo vencido (índice parcial sobre `outbox.nextAttemptAt`, 15 s de
  gracia para no pisarse con el camino normal). Si quedó `summaryPending`, recuenta el hilo desde las
  respuestas; si quedó `eventId`, vuelve a publicar con el mismo id (Notification descarta las repeticiones).
  Backoff de 30 s a 30 min; a los 25 intentos (unas 9 h) lo deja y lo loguea como error. Una respuesta
  borrada antes de avisar no se avisa.
* **Mismo aviso para DMs y canales** (épica de notificaciones, ADR 0017). Todo mensaje que no es respuesta
  también se guarda con `outbox: { eventId, serverId, attempts, nextAttemptAt }` (sin `summaryPending`) y sale
  por el mismo `deliver` y el mismo relay. Lo arma `ChatService.sendMessage`, el único camino de escritura de
  los mensajes de usuario. Cambia solo a quién nombra el evento:
  * **DM:** `recipient_ids`, campo opcional nuevo, con los participantes de la conversación menos el autor (se
    leen al publicar). Solo en mensajes de DM. No se reutilizó `thread_participant_ids`: sigue significando
    "participantes del hilo" y Notification lo usa para `thread_reply`. Una respuesta de hilo en un DM sigue
    como antes, sin `recipient_ids`.
  * **Canal de servidor:** sale siempre, con o sin menciones, para el nivel `all`. `thread_participant_ids`
    vacío y sin `recipient_ids`: los mencionados viajan en `mention_*` y quién pidió `all` lo resuelve
    Notification con sus preferencias. Chat no llama a Server-Roles por estos mensajes.
  * Sin `serverId` conocido fuera de un DM no se guarda aviso (sin `server_id` Notification no puede aplicar
    las preferencias). Los dos caminos de envío (socket y `POST`) lo pasan siempre.
  * Los mensajes del sistema ("se unió …") no avisan: no pasan por `sendMessage`.

**Alternativas descartadas:**

| Alternativa | Por qué se descartó |
|---|---|
| Colección aparte `ThreadReply` | Duplica edición, borrado, reacciones, adjuntos y búsqueda. Con el mismo modelo todo eso ya funciona. |
| Hilos anidados (responder a una respuesta) | Complica la UI en mobile y el resumen; ninguna historia lo pide. Se puede abrir después sin migrar datos. |
| Contar respuestas al leer (`countDocuments` por mensaje) | Una consulta por mensaje en cada página del historial (N+1). El contador en el raíz viaja en el payload. |
| Mandar la respuesta como un mensaje crudo con `threadParentId` | Los clientes que no conocen el campo la agregarían al canal principal. |
| Que Chat decida a quién avisar | Obliga a Chat a leer las preferencias de Notification en cada mensaje. Chat manda quién participa y Notification filtra. |
| Publicar directo, sin outbox | Una caída entre guardar y publicar, o RabbitMQ caído, pierde el aviso. Con CA5 eso es un usuario que no se entera. |
| Colección `Outbox` aparte con transacción | Atlas M0 tiene transacciones, pero los tests usan un Mongo de un nodo y la transacción suma latencia a cada respuesta. En el mismo documento la escritura ya es atómica. |

**Consecuencias:**

* Una escritura extra por respuesta (el raíz) y, en un servidor, una llamada a Server-Roles fuera del camino de
  la respuesta.
* Cada mensaje de usuario publica un `chat.message.created` (uno solo, sin importar cuántos miembros o menciones
  tenga) y hace una escritura más en Mongo para sacar el outbox; un DM, además, una lectura de la conversación.
  Con RabbitMQ caído, los mensajes se acumulan con su outbox y el relay los toma de a 50 por vuelta.
* Si el proceso se cae entre guardar la respuesta y actualizar el raíz, el relay recuenta el hilo. El recuento
  y un `$inc` simultáneo pueden dejar el contador uno arriba hasta el próximo recuento: solo en la recuperación
  de una caída, y se acepta.
* Con más de una instancia (C3), dos relays pueden publicar el mismo aviso: lo descarta Notification por
  `event_id`.
* El texto del aviso es el contenido recortado a 140 caracteres, con las menciones en su formato crudo
  (`<@id>`): la interfaz las resuelve.
* Un cliente que se reconecta no recibe las respuestas que se perdió por el socket: las relee al abrir el hilo.
* Compatibilidad: solo se suman campos. Los mensajes viejos no tienen `thread` ni `threadParentId`.
