## ADR 02: Estado de lectura y no leídos por canal

**Contexto:**
Las historias obligatorias #27 ("Ver notificaciones no leídas") y #28 ("Marcar notificaciones como leídas") piden, según sus criterios de aceptación:

* un indicador de no leído **por canal** y **por servidor**, y uno distinto si hay una mención sin leer (este último solo si se implementa la optativa #46, Menciones);
* que el indicador de un canal desaparezca **al abrirlo**, y una opción para **marcar todo como leído**.

Pese al nombre, no piden una bandeja de notificaciones (eso es la optativa #67). Lo que hace falta es saber, por usuario y canal, hasta dónde leyó, y cuántos mensajes hay después.

Hay tres restricciones que condicionan el diseño:

* **El WebSocket es por canal** (`/channels/:channelId/ws`): un cliente solo está conectado al canal que tiene abierto. No hay un canal por el que avisarle de la actividad en los demás.
* **Chat-Engine no conoce los permisos.** Quién puede ver qué canal lo decide Server-Roles-Core (roles, overrides por canal, bans). Contar mensajes de canales que el usuario no puede ver filtraría información, en contra del RNF de seguridad ("el acceso a datos de otros usuarios debe estar controlado por autorización explícita en cada operación").
* **El historial ya usa `_id` como cursor** (`before` en la paginación, `last_message_id_seen` en la reconexión): los ObjectId de Mongo empiezan con la fecha de creación, así que crecen con el tiempo.

**Decisión:**

* **El estado de lectura vive en Chat-Engine**, en la colección `readstates` (`src/models/ReadState.ts`): un documento por usuario y canal con `lastReadMessageId`, y un índice único `{ userId, channelId }`. Lo no leído no se guarda: se **calcula** contando los mensajes de otros con `_id` mayor. Así un mensaje nuevo no obliga a escribir nada por cada miembro del canal.
* **Endpoints** (detrás de Kong, bajo `/api/v1/chat`, con el usuario en `X-User-Id`):
  * `GET /unread` → `{ channels: [{ channelId, unreadCount, mentionCount }] }`, solo los canales con algo sin leer. El contador se corta en **100** (la interfaz muestra "99+"): basta para el indicador y acota el costo.
  * `POST /channels/:channelId/read` con `{ messageId? }` → `204`. Sin `messageId`, hasta el último mensaje. Protegido por `channelAccessGuard`, como el historial.
  * `POST /read-states/read-all` → `204`. Marca todos los canales visibles.
* **Marcar como leído nunca retrocede** (`$max` sobre `lastReadMessageId`, con `upsert`). Es idempotente y tolera pedidos duplicados o fuera de orden: si la web marca hasta el mensaje 50 y llega tarde un pedido del celular hasta el 30, queda en 50. El enunciado pide idempotencia "donde el reintento es esperable"; acá lo es (debounce en el cliente, varios dispositivos).
* **Un canal sin registro arranca leído hasta su último mensaje** (se crea en el primer `GET /unread`). Si no, quien se une a un servidor vería todo el historial como no leído. Si el canal está vacío se usa un ObjectId armado con la fecha actual (`ObjectId.createFromTime`). No se usa "ahora" cuando hay mensajes porque los ObjectId tienen resolución de segundos: los mensajes de ese mismo segundo quedarían como no leídos.
* **Los mensajes propios no cuentan**, y enviar un mensaje por el WebSocket avanza el estado de lectura de quien escribe (si eso falla, el mensaje ya se envió: solo se registra un `warn`).
* **Los canales visibles los decide Core**, no el cliente: `GET /unread` y `POST /read-states/read-all` llaman a `GET /internal/users/{id}/visible-channels` de Server-Roles-Core (canales de texto con `VIEW_CHANNELS` en todos los servidores del usuario). Es una **llamada sincrónica**, justificada como la de `/access`: la respuesta al usuario depende de ella y no se puede construir sin saber qué puede ver. Si Core no responde, `503` (`UpstreamUnavailableError`), igual que el historial.
* **Índice nuevo en `messages`:** `{ channelId: 1, _id: 1 }`. El conteo filtra por canal y `_id > lastReadMessageId`; con este índice Mongo va directo a ese tramo y cuenta como mucho 100 documentos. El índice existente (`{ channelId: 1, createdAt: -1 }`) obligaría a revisar todos los mensajes del canal.
* **Los clientes consultan por polling:** cada 30 s y al volver a la app (`useUnreadQuery` en `@discordia/core`; en mobile, el `focusManager` de React Query atado a `AppState`). El canal abierto se marca leído con cada mensaje que llega por su WebSocket, con un debounce de 1 s, y la interfaz nunca lo muestra como no leído.
* **`mentionCount` ya está en la respuesta y vale 0** hasta que exista #46: cuando haya menciones, se cuentan los mensajes no leídos que mencionan al usuario, sin cambiar el contrato.

**Alternativas descartadas:**

| Alternativa | Por qué se descartó |
|---|---|
| Guardarlo en Notification-Audit-Metrics | Hoy el servicio no tiene lógica (solo `/livez` y `/readyz`), y tendría que replicar los mensajes (o su `_id` y autor) por eventos para poder contar. Chat-Engine ya tiene los mensajes. Si más adelante se hace la bandeja (#67), esa sí va en Notification-Audit, consumiendo eventos. |
| Contador por usuario y canal, incrementado en cada mensaje | Cada mensaje implicaría una escritura por miembro del canal (que Chat no conoce sin preguntarle a Core) y se desincroniza fácil. Calcularlo desde el último leído es una lectura acotada. |
| Que el cliente mande la lista de canales | Evita la llamada a Core, pero permitiría preguntar por canales ajenos y obtener cuántos mensajes tienen. Rompe la autorización explícita del RNF de seguridad. |
| Avisar en tiempo real por un WebSocket por usuario | Es lo ideal para la experiencia, pero requiere un socket nuevo, saber los miembros de cada canal (otra consulta a Core por mensaje) y repartir entre instancias, que depende del pub/sub todavía pendiente. Los CA ("cuando el usuario mira la lista") se cumplen con polling. Se reconsidera cuando esté el pub/sub entre instancias. |
| Réplica local de permisos en Chat (consumir eventos de roles, membresías y overrides) | Mismo motivo que en el ADR-03 de Voice-Signaling: duplica la lógica de permisos de Core en otro servicio. |

**Consecuencias:**

* Cada `GET /unread` hace una llamada a Core y un conteo por canal visible (en paralelo, cada uno acotado a 100). Con N usuarios conectados son N pedidos cada 30 s. Conviene incluirlo en las pruebas de carga.
* Entre dispositivos, lo leído en uno se refleja en el otro en el siguiente polling (hasta 30 s).
* Lo que se envía entre que un usuario entra a un servidor y su primer `GET /unread` cuenta como leído. Es un caso chico y aceptado.
* Cuando un usuario deja un servidor, sus registros de lectura quedan en la base. No molestan (solo se cuentan los canales que Core dice que ve) y se pueden limpiar más adelante con los eventos `member.left`, `member.kicked` y `member.banned`, que Chat ya consume.
* **Pendiente de resiliencia:** las llamadas de Chat a Core (`/access` y `/visible-channels`, en `src/services/PermissionService.ts`) no tienen timeout ni reintentos. Voice-Signaling ya resolvió lo mismo (su ADR-03: 2 s por intento, 3 intentos con backoff exponencial, `503` al agotarlos). Hay que aplicar ese criterio acá; si no, un Core colgado deja colgados el historial y los no leídos.
* Tests: `tests/readStates.test.ts` (rutas, conteo, tope, monotonía, canales no visibles, Core caído, avance al escribir por WebSocket) y `tests/PermissionService.test.ts` (cliente de `visible-channels`). Del lado de Core, `tests/test_internal_visible_channels.py`.
