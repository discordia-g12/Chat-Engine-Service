# Chat-Engine-Service

Servicio de mensajería en tiempo real de Discordia (Node.js 20, TypeScript, Fastify 5). Cada canal de texto
tiene un WebSocket: el servicio guarda los mensajes en MongoDB y los reparte a los conectados (localmente y entre
múltiples instancias mediante Redis Pub/Sub, según el ADR 0006). Al reconectar,
el cliente recupera los mensajes que se perdió. Además expone el historial paginado, los mensajes directos y
la presencia.

No decide permisos: le pregunta a Server-Roles-Core si el usuario puede ver y escribir en el canal, y escucha
sus eventos (`member.*`, `role.*`) por RabbitMQ para aplicar en vivo baneos, expulsiones, silencios y
cambios de rol. En los mensajes directos tampoco decide: le pregunta a Auth-User-Service quién es el usuario
y qué relación tiene con el otro.

## Requisitos

- Node.js 20 (la versión de la imagen y del CI) y npm.
- Docker, para MongoDB y Redis.
- **Server-Roles-Core-Service** corriendo, para abrir un canal: sin él, el acceso al canal responde `503`.
  Con su `docker compose up -d` queda en `localhost:8080`.
- **Auth-User-Service** corriendo, para los mensajes directos: sin él, los DMs responden `503` y los canales de
  servidor siguen funcionando.
- RabbitMQ es opcional: sin él, el chat funciona igual, pero los baneos y silencios no se aplican en vivo.

## Levantarlo en local

### Desde el host, con recarga en caliente

```bash
npm install
docker compose up -d chat-mongo chat-redis      # MongoDB en 27017 y Redis en 6379

# El servicio no lee .env: las variables van exportadas o en la línea (referencia en .env.example)
CORE_SERVICE_URL=http://localhost:8080 AUTH_SERVICE_URL=http://localhost:8000 npm run dev
```

### Todo en contenedores

```bash
docker compose up -d --build        # MongoDB, Redis y el servicio en localhost:3000
```

La app del compose llega a Server-Roles en `http://host.docker.internal:8080` y a Auth en
`http://host.docker.internal:8001`, el puerto que publica Auth en el stack de `deploy/` (el 8000 ahí es Kong,
que no expone `/internal`; se cambian con `CORE_SERVICE_URL` y `AUTH_SERVICE_URL`). Usa la base `chat_db`; `npm run dev`, por defecto, `discordia_chat`: los mensajes de
una no aparecen en la otra.

Bajar todo: `docker compose down` (con `-v` también borra los datos).

### Probarlo

```bash
curl localhost:3000/livez
curl localhost:3000/readyz      # {"status":"ready","checks":{"mongo":"ok","redis":"ok","rabbitmq":"disconnected"}}
```

Para mandar un mensaje hace falta un canal real: crear un servidor en Server-Roles
(`POST /api/v1/servers`, que trae un canal de texto "general") y usar su `id`. Sin Kong adelante, la
identidad va en el header `X-User-Id` (con el mismo usuario que creó el servidor):

```bash
CANAL=<id del canal>
npx wscat -c "ws://localhost:3000/channels/$CANAL/ws" -H "X-User-Id: auth0|local-test"
> {"content":"hola"}
< {"id":"...","content":"hola","authorId":"auth0|local-test","channelId":"...","createdAt":"...","mentions":{"users":[],"roles":[],"everyone":false}}

curl "localhost:3000/channels/$CANAL/messages?limit=20" -H "X-User-Id: auth0|local-test"
```

Con otro `X-User-Id`, que no es miembro del servidor, el canal responde `403`.

### Con el resto del sistema

Para levantarlo junto con el Gateway y los demás servicios, usar el compose del orquestador
(`discordia-orchestrator/deploy/docker-compose.yml`, profile `local`). Ahí se entra por Kong
(`localhost:8000/api/v1/chat/...`), que valida el token y agrega `X-User-Id`.

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto HTTP y WebSocket |
| `MONGO_URI` | `mongodb://localhost:27017/discordia_chat` | Historial de mensajes. En producción, MongoDB Atlas |
| `REDIS_URL` | `redis://localhost:6379` | Redis para pub/sub de mensajería multi-instancia y verificación en `/readyz` |
| `CORE_SERVICE_URL` | `http://localhost:8000` | Server-Roles-Core, para `/internal/channels/{id}/access`, `/internal/users/{id}/visible-channels` y `/internal/servers/{id}/member-ids`. En local, `http://localhost:8080` |
| `AUTH_SERVICE_URL` | `http://localhost:8000` | Auth-User-Service, para `/internal/users/{id}/canonical` y `/internal/relations`. Timeout de 2 s; si no responde, los DMs dan `503` |
| `RABBITMQ_URL` | `amqp://admin:admin@rabbitmq:5672/` | Broker de los eventos de Server-Roles |
| `RABBITMQ_EXCHANGE` | `server.events` | Exchange del que consume |
| `RABBITMQ_USER_EXCHANGE` | `user.events` | Exchange de Auth-User, del que consume `user.suspended` |
| `RABBITMQ_QUEUE` | `chat_engine_events` | Cola durable del servicio |
| `INTERNAL_API_TOKEN` | — | Secreto compartido con Voice-Signaling y Notification: `POST /internal/inbox/events` exige `X-Internal-Token` igual a este valor (`401` si no). Sin la variable no se exige (y se avisa en el log): es el modo de transición hasta cargarla en el nodo |

## API

En producción está detrás de Kong, bajo `/api/v1/chat` (Kong saca ese prefijo). El usuario llega en
`X-User-Id`, que agrega Kong al validar el token. Los permisos los decide Server-Roles-Core.

- `GET /channels/:channelId/ws?last_message_id_seen=`: WebSocket del canal. El cliente manda
  `{"content": "..."}` y recibe cada mensaje nuevo del canal. Al reconectar con `last_message_id_seen`,
  recibe los posteriores a ese mensaje (como mucho los 100 más recientes; el resto, con el historial). Un id
  que no es un ObjectId no repone nada.
- Menciones en el texto: `<@userId>`, `<@&roleId>` y `@everyone`. Las de rol y `@everyone` exigen
  `MENTION_EVERYONE`; sin ese permiso quedan como texto. Cada mensaje trae en `mentions` las que notifican.
  Ver ADR-03.
- `GET /channels/:channelId/messages?limit=&before=`: historial en orden cronológico (50 por defecto, hasta 100).
  `before` es el id del mensaje más viejo que ya tiene el cliente, para cargar los anteriores. `400` si `limit`
  no es un entero entre 1 y 100 o `before` no es un id de mensaje.
- `GET /servers/:serverId/messages/search?q=&authorId=&limit=&before=`: busca mensajes del servidor por
  texto (`q`, sin distinguir mayúsculas ni tildes), por autor (`authorId`) o las dos cosas, solo en los
  canales que el usuario puede ver. Del más nuevo al más viejo, 25 por página (hasta 50):
  `{ messages, hasMore, nextCursor }`, con `nextCursor` como `before` de la siguiente. Sin coincidencias,
  `messages` vacío. Ver ADR-04.
- `GET /channels/:channelId/messages/search?q=&authorId=&limit=&before=`: la misma búsqueda dentro de un solo
  canal o DM (`dm-…`), con el acceso del historial: participante en un DM, `VIEW_CHANNELS` en un canal. En un
  DM, un `authorId` igual al `X-User-Id` de quien busca se toma como su id canónico. Ver ADR-04.
- `GET /channels/:channelId/messages/:messageId/thread?after=&limit=`: hilo de un mensaje (canal o DM):
  `{ parent, replies, hasMore, nextCursor }`. `parent` es el raíz, también si está borrado. Las respuestas van
  de la más vieja a la más nueva, 50 por página (hasta 100); `nextCursor` es el `after` de la siguiente. Ver ADR-07.
- Responder citando: `replyToId` en el body de `POST /channels/:channelId/messages`, del POST del hilo o en el
  mensaje del WebSocket. Se guarda una copia del citado y el mensaje la trae como
  `replyTo: { id, authorId, content, deleted? }`; editar o borrar el original actualiza las copias. Tiene que ser
  de la misma conversación (en el canal, un mensaje del canal; en un hilo, el raíz o una respuesta): `400` si no,
  `404` si no existe o está borrado.
- `POST /channels/:channelId/messages/:messageId/thread` con `{ content, attachments?, replyToId? }`: responde en el hilo
  (`201` con la respuesta, que trae `threadParentId`). Mismo permiso que escribir en el canal. `400` con
  `code: THREAD_NESTED` si el mensaje ya es una respuesta (un solo nivel), `404` si no es de ese canal. Por el
  WebSocket del canal: `{"content": "...", "threadParentId": "<id del raíz>"}`. Las respuestas no aparecen en
  el historial ni en la reconexión del canal, y no cuentan como no leídos; el raíz trae
  `thread: { replyCount, lastReplyAt, lastReplyId, participantIds, replierIds }`.
- `GET /unread`: canales con mensajes sin leer, con `unreadCount` y `mentionCount` (hasta 100 cada uno). Ver
  ADR-02 y ADR-03.
- `POST /channels/:channelId/read`: marca el canal leído hasta `messageId` (body opcional) o hasta el
  último mensaje. Nunca retrocede.
- `POST /read-states/read-all`: marca leídos todos los canales que el usuario puede ver.
- `GET /conversations`: conversaciones directas del usuario, las más recientes primero, sin las que rechazó.
- `PUT /conversations/with/:userId`: `{ conversation | null, canMessage }`. No crea nada; si ya son amigos, pasa
  una conversación pendiente o rechazada a `accepted`.
- `POST /conversations` con `{ recipientId, content, attachments? }`: manda el primer mensaje. Crea la
  conversación (`accepted` entre amigos, si no `pending`) o reutiliza la que hay: `201 { conversation, message }`.
- `POST /conversations/:id/accept` y `POST /conversations/:id/decline`: responden una solicitud de mensaje. Solo
  el destinatario. Aceptar no los hace amigos; rechazar la saca de su lista y a quien la inició no se le avisa.
  Si después escribe quien rechazó, la conversación pasa a `accepted`: escribir es arrepentirse.
- `POST /presence` con `{ userIds }` (hasta 100): `{ [userId]: "online" | "idle" | "dnd" | "offline" }`. Un
  usuario conectado figura con el estado que eligió; invisible, suspendido o desconectado, `offline`.
- `GET /presence/me` y `PUT /presence/me` con `{ status }`: estado elegido por el usuario (`online`, `idle`,
  `dnd` o `invisible`; `online` si nunca eligió uno). Otro valor es `400`.
- `GET /inbox/ws`: WebSocket del usuario. Ver abajo.
- `GET /livez`: el proceso está vivo. No consulta Mongo ni Redis, para que una caída de ellos no reinicie el
  contenedor.
- `GET /readyz`: ping a Mongo y Redis (1 s cada uno). `200` si los dos responden; `503` con el detalle si
  falla alguno. RabbitMQ se informa pero no define si está listo: sin eventos el chat sigue andando.

### Rutas internas

Las llaman otros servicios por la red del nodo (`http://chat-engine:3000`), sin JWT y sin pasar por Kong. Como
Kong enruta todo `/api/v1/chat` sacando el prefijo, `/api/v1/chat/internal/...` llegaría al servicio: lo que
trae `X-User-Id` o `X-Forwarded-Prefix` (los pone Kong) recibe `404`.

- `GET /internal/metrics/messages?from=&to=`: métricas de mensajes para el backoffice, que pide
  Notification-Audit-Metrics. `from` y `to` en ISO 8601 (`2026-11-01` o `2026-11-01T00:00:00Z`), rango
  `[from, to)` sobre `createdAt`. Responde `{ from, to, messages, activeUsers }` con las fechas en UTC.
  `messages` cuenta los de canales y DMs, borrados incluidos (se enviaron igual); `activeUsers` es la cantidad
  de autores distintos (usuario activo = mandó al menos un mensaje). `400` si falta una fecha, no es ISO 8601
  o `from >= to`. Usa el índice `{ createdAt: 1, authorId: 1 }`.

Las que siguen las usa Voice-Signaling para las llamadas privadas 1 a 1 (historia #50). Voice está en el mismo
nodo (realtime) y es el dueño de la llamada: Chat solo dice quién puede llamar y reparte los avisos.

- `GET /internal/conversations/:id/call-access?user_id=<X-User-Id crudo>`: si el usuario puede llamar en la
  conversación. Mismas reglas que para escribir, sin mandar nada ni cambiar el estado (una conversación que el
  próximo mensaje aceptaría también vale). Responde `{ conversationId, userId, otherUserId }` con ids
  canónicos. `404` con `code: CONVERSATION_NOT_FOUND` si no existe o el id no es `dm-…`; `403` si no participa; `403` con `code`
  `DM_NOT_DELIVERABLE` (no existe, suspendido o bloqueo, sin decir cuál) o `DM_PENDING`; `400` sin `user_id`;
  `503` si Auth no responde.
- `GET /internal/users/:id/canonical`: `{ userId, suspended }`, con la misma cache de un minuto que usan los
  DMs. `404` con `code: USER_NOT_FOUND` si no existe; `503` si Auth no responde.

  Los 404 de estas rutas siempre traen `code`: un 404 sin código es una ruta que este Chat no tiene, y Voice lo
  trata como Chat no disponible.
- `POST /internal/inbox/events` con `{ userIds, event }` y el header `X-Internal-Token` (ver
  `INTERNAL_API_TOKEN`; `401` si falta o no coincide): publica `event` tal cual en el inbox de cada usuario
  (`inbox:<id>`) y responde `202`. `userIds`: de 1 a 10 ids no vacíos (los repetidos reciben uno solo).
  `event.type` tiene que empezar con `CALL_` (Voice) o `NOTIFICATION_` (Notification, ADR 0017; `400` si no):
  el resto de los eventos los publica Chat. `413` si
  `event` pasa los 8 KB.

Los errores siguen RFC 7807 (`application/problem+json`): `400` datos inválidos, `401` sin usuario, `403`
sin acceso al canal, `404` canal inexistente o mensaje inexistente y `503` si Server-Roles (o Auth, en un DM) no
responde. Por el WebSocket, un error llega como `{"error": "...", "status": 403}`.

### Mensajes directos

Una conversación tiene un id `dm-<ObjectId>` y funciona como un canal: con ese id andan `GET` y
`POST /channels/:id/messages`, `POST /channels/:id/read`, `GET /channels/:id/ws` y los adjuntos. El acceso lo
decide ser participante, sin consultar a Core. `Message` y `ReadState` no cambian; las conversaciones están en la
colección `conversations`, con un índice único por par de usuarios.

Los participantes se guardan con su id canónico: `X-User-Id` puede ser un alias si el login es federado. En cada
envío, por REST o WebSocket, se vuelve a preguntar la relación a Auth. Los rechazos traen un campo `code`, en
Problem Details y en el error del WebSocket:

| Status | `code` | Cuándo |
|---|---|---|
| `403` | `DM_NOT_DELIVERABLE` | Hay un bloqueo en cualquier sentido, o el otro está suspendido o no existe. Es el mismo error en todos los casos: nunca dice "te bloquearon" |
| `403` | `DM_PENDING` | La conversación todavía no se aceptó (si escribe quien la rechazó, en cambio, se acepta y el mensaje sale) |
| `503` | | Auth no responde. No se guarda ni se entrega nada |

No leídos: `unreadCount` de cada conversación usa el mismo cálculo que `/unread`, que no incluye DMs.
A diferencia de un canal, una conversación sin registro de lectura no arranca leída.

### Inbox y presencia

`GET /inbox/ws` es un socket por usuario, para enterarse de lo que pasa en conversaciones que no tiene abiertas.
Recibe, por el canal de Redis `inbox:<userId>`:

```json
{ "type": "DM_MESSAGE", "conversationId": "dm-…", "message": {} }
{ "type": "DM_CONVERSATION", "conversation": {} }
{ "type": "SERVER_UPDATED", "serverId": "…" }
{ "type": "MY_STATUS", "status": "dnd" }
```

`MY_STATUS` avisa a las otras sesiones del usuario que cambió su estado elegido (`PUT /presence/me`).

Lo único que manda el cliente (lo demás se ignora, sin cerrar el socket):

| Mensaje | Respuesta |
|---|---|
| `{ "type": "PRESENCE_SUBSCRIBE", "userIds": [] }` (hasta 500) | `{ "type": "PRESENCE_SNAPSHOT", "statuses": { "<id>": "online" } }` con el estado actual. Reemplaza la lista anterior; desde ahí llega `{ "type": "PRESENCE_UPDATE", "userId", "status" }` cada vez que cambia uno, con el id tal como se pidió |
| `{ "type": "ACTIVITY", "idle": true }` | Ninguna. Si todas sus pestañas en esta instancia están sin actividad, quien eligió `online` se ve `idle`. No molestar e Invisible no cambian |

`SERVER_UPDATED` avisa que cambió el nombre, la descripción, el ícono o el banner de un servidor del usuario: el
cliente vuelve a pedir `GET /api/v1/servers` (ADR 0013 de `org-docs`).

Al reconectar, el cliente vuelve a pedir `GET /conversations`. Mientras el inbox está conectado, la clave Redis
`presence:<userId>` tiene un TTL de 60 s y la renueva cada pong del heartbeat. Al cerrarse el último socket de esa
instancia se borra; si el usuario tiene otro en otra instancia, vuelve en el próximo ping.
La clave vale `1` (activo) o `idle` (sin actividad). El estado elegido va en `presence:pref:<userId>`, sin TTL: se
conserva entre sesiones y solo se ve mientras existe `presence:<userId>`.

Cada cambio visible (conectarse, irse, cambiar el estado elegido, pasar a inactivo y volver) se publica en el canal
de Redis `presence-updates` como `{ userId, status }`. Lo reciben todas las instancias y cada una lo reenvía a sus
sockets suscriptos a ese usuario. Las renovaciones del heartbeat no publican nada (`SET … GET` compara con el valor
anterior). Si una instancia se cae, sus claves vencen sin aviso: el cliente lo ve en el próximo `POST /presence`.

### Mensajes del servidor por el WebSocket

| Mensaje o cierre | Cuándo |
|---|---|
| `{"type":"THREAD_REPLY_CREATED","parentId","reply","thread"}` | Alguien respondió en un hilo del canal. `thread` es el resumen nuevo del raíz. En un DM llega además por el inbox como `DM_THREAD_REPLY_CREATED`. Editar, borrar o reaccionar a una respuesta usa los `MESSAGE_*` de siempre, con `threadParentId` en el mensaje |
| `{"type":"PERMISSIONS_UPDATED","canSend":false}` | Al conectar, si el usuario puede leer pero no escribir (silenciado o sin `SEND_MESSAGES`), y cada vez que eso cambia |
| Cierre `4003` | Lo banearon del servidor (`member.banned`) |
| Cierre `4002` | Lo expulsaron o abandonó el servidor (`member.kicked`, `member.left`) |
| Cierre `4010` | El staff suspendió la cuenta (`user.suspended`). Se cierran todas sus conexiones; reconectar no sirve, Kong rechaza sus tokens |
| Cierre `4011` | El staff suspendió el servidor (`server.suspended`). Se cierran las conexiones a sus canales, de todos los miembros; reconectar no sirve hasta que se levante la suspensión (Server-Roles niega el acceso con `server-suspended`) |

Cada 30 s el servidor manda un ping de protocolo y cierra las conexiones que no responden (evita el corte de
Cloudflare a los ~100 s).

### Eventos que consume

Cola `chat_engine_events`, enlazada a `member.*`, `role.*`, `server.deleted`, `server.updated`, `channel.deleted` y
`server.suspended` del exchange `server.events`, y a
`user.suspended` del exchange `user.events` (Auth-User):

- `server.suspended`: cierra con `4011` las sesiones de los canales de ese servidor, de todos los miembros. Los DMs y
  la bandeja no son del servidor y siguen abiertos;
- `user.suspended`: cierra con `4010` todas las sesiones de la cuenta (canales, DMs y bandeja) de cada una
  de sus identidades (`identities`, la principal y sus alias federados);
- `member.joined`: guarda y emite en vivo un mensaje del sistema en el canal de bienvenida que eligió
  Server-Roles (`channel_id`; si viene `null`, nada). Llega como un mensaje más del canal, con
  `type: "system"`, `system: { event: "member_join", userId }`, `content` vacío y quien se unió como
  `authorId`: la interfaz arma "se unió …" con su nombre actual. No se puede editar ni fijar, se puede
  reaccionar ("saludalo") y no cuenta en las métricas ni aparece en la búsqueda. El `message_id` del evento
  queda en el mensaje (índice único), así una entrega repetida no lo duplica;
- `member.banned`, `member.kicked` y `member.left`: cierra las sesiones de ese usuario en ese servidor;
- `member.muted` y `member.unmuted`: bloquea o habilita la escritura, y programa el fin del silencio;
- `member.role_assigned`, `member.role_removed`, `role.permissions_updated` y `role.deleted`: vuelve a
  preguntar a Server-Roles si puede escribir;
- `server.updated`: pide los miembros a Server-Roles (`/internal/servers/{id}/member-ids`) y les manda
  `SERVER_UPDATED` por el inbox. Si Server-Roles no responde, el aviso se descarta.

### Eventos que publica

En el exchange `server.events`:

- `message.deleted_by_moderator`: un moderador borró el mensaje de otro (auditoría en Notification-Audit-Metrics).
- `chat.message.created`: una respuesta de hilo con participantes para avisar (ADR-07 y ADR 0017 de la
  organización). Lleva `server_id` (`null` en un DM), `channel_id`, `thread_id`, `message_id`, `author_id`,
  `thread_participant_ids` (sin el autor y sin quienes ya no son miembros), `mention_user_ids`,
  `mention_role_ids`, `mention_everyone`, `is_dm`, `preview` (140 caracteres) y `created_at`. Sale después de
  guardar la respuesta, con confirmación de RabbitMQ. Lo que no se confirmó (RabbitMQ o Server-Roles caídos, o el
  proceso cayéndose en el medio) queda en el outbox de la propia respuesta y lo reintenta `ThreadOutbox` cada 10 s,
  con el mismo `event_id`. Ver ADR-07.

Si RabbitMQ no está al arrancar, el consumidor reintenta solo (de 1 a 30 s) sin bloquear el servicio.

## Tests, lint y seguridad

Los mismos comandos que corre el CI:

```bash
npm run lint                   # ESLint, con reglas de seguridad
npm run typecheck              # tsc --noEmit
npm audit --audit-level=high   # dependencias con vulnerabilidades
npm run test:coverage          # tests + cobertura (mínimo 85 %, ver ADR-01)
```

Los tests no necesitan Docker: levantan un MongoDB en memoria (`mongodb-memory-server`, que la primera vez
descarga el binario) y simulan Redis, RabbitMQ y Server-Roles.

## Estructura

```text
src/
├── server.ts                  arranque: Mongo, Redis, consumidor de eventos y HTTP
├── app.ts                     app de Fastify, /livez y /readyz
├── plugins/websocket.ts       WebSocket del canal
├── plugins/history.ts         historial
├── plugins/threads.ts         hilos de un mensaje
├── plugins/conversations.ts   conversaciones directas y presencia
├── plugins/internalMetrics.ts /internal/metrics/messages (backoffice)
├── plugins/internalCalls.ts   /internal para las llamadas privadas (Voice-Signaling)
├── plugins/errorHandler.ts    errores RFC 7807
├── services/ChatService.ts    guardar mensajes, historial y mensajes perdidos
├── services/ThreadService.ts  respuestas de hilo y resumen del raíz
├── services/ThreadOutbox.ts   outbox de los hilos: aviso a Notification y recuento si algo quedó a medias
├── services/SessionManager.ts sesiones abiertas por canal y usuario (en memoria)
├── services/PubSubService.ts   distribución de mensajes multi-nodo (Redis Pub/Sub)
├── services/PermissionService.ts  consulta a Server-Roles
├── services/ConversationService.ts  conversaciones directas y solicitud de mensaje
├── services/RelationsService.ts  consulta a Auth: id canónico y relación entre usuarios
├── services/PresenceService.ts  presencia en Redis
├── services/MetricsService.ts  conteo de mensajes y usuarios activos por período
├── services/EventConsumer.ts  eventos de RabbitMQ
├── helpers/                   identidad, permisos y heartbeat
├── models/                    modelos de Mongoose (Message, ReadState, Conversation)
└── config/                    Mongo, Redis y readiness
tests/
```

## CI/CD

`.github/workflows/ci.yml`, en cada push y PR a `main` y `develop`:

1. `test`: lint, typecheck y tests con cobertura. `npm audit` se muestra en el log pero no bloquea.
2. `docker`: construye la imagen; en push la publica como `ghcr.io/discordia-g12/chat-engine-service:<sha>`.
3. `deploy`: en push a `main`, la despliega en el nodo **realtime** con el workflow del orquestador. Si no
   queda sana, vuelve sola a la versión anterior.

## Decisiones de arquitectura

| ADR | Tema |
|-----|------|
| [ADR-01](docs/ADR-01-CI-CD-Pipeline.md) | Pipeline de CI/CD |
| [ADR-02](docs/ADR-02-Read-States.md) | Estado de lectura y no leídos por canal |
| [ADR-03](docs/ADR-03-Mentions.md) | Menciones de usuario, de rol y @everyone |
| [ADR-04](docs/ADR-04-Message-Search.md) | Búsqueda de mensajes |
| [ADR-05](docs/ADR-05-Pinned-Messages.md) | Mensajes fijados |
| [ADR-06](docs/ADR-06-Presence.md) | Presencia |
| [ADR-07](docs/ADR-07-Threads.md) | Hilos de conversación |

Escalabilidad multi-nodo: implementada con Redis Pub/Sub (`channel:{channel_id}`) según ADR 0006 y el issue #7.
Cada réplica se suscribe a los canales activos y distribuye los mensajes entre pods sin duplicar envíos.
