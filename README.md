# Chat-Engine-Service

## Desarrollo local

```bash
npm install
docker compose up -d chat-mongo chat-redis
npm run dev
```

## Tests, lint y seguridad

```bash
npm run lint                  # ESLint (incluye reglas de seguridad)
npm run typecheck             # tsc --noEmit
npm audit --audit-level=high  # SAST de dependencias
npm run test:coverage         # tests + cobertura (mínimo 85%, ver ADR-01)
```

## API

Detrás de Kong, bajo `/api/v1/chat`. El usuario llega en el header `X-User-Id` (lo pone Kong al validar el token). Los permisos los decide Server-Roles-Core (`CORE_SERVICE_URL`).

- `GET /channels/:channelId/ws?last_message_id_seen=` — WebSocket del canal: envía y recibe mensajes; al reconectar, reenvía los posteriores a `last_message_id_seen`.
- `GET /channels/:channelId/messages?limit=&before=` — historial, en orden cronológico; `before` es el id del mensaje más viejo cargado.
- `GET /unread` — canales con mensajes sin leer (`unreadCount`, hasta 100, y `mentionCount`). Ver ADR-02.
- `POST /channels/:channelId/read` — marca el canal leído hasta `messageId` (body opcional) o hasta el último mensaje. Nunca retrocede.
- `POST /read-states/read-all` — marca leídos todos los canales que el usuario puede ver.

Los errores siguen RFC 7807 (`application/problem+json`): `400` datos inválidos, `401` sin usuario, `403` sin acceso al canal, `404` canal o mensaje inexistente, `503` si Server-Roles no responde.

## Health checks

- `GET /livez` — liveness: el proceso está vivo. No depende de Mongo/Redis (una caída de ellos no debe reiniciar el contenedor).
- `GET /readyz` — readiness: hace ping a Mongo y Redis (timeout 1s c/u). `200 {status:"ready"}` si ambos responden; `503 {status:"not_ready", checks:{mongo, redis}}` si alguno falla.
