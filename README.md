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

## Health checks

- `GET /livez` — liveness: el proceso está vivo. No depende de Mongo/Redis (una caída de ellos no debe reiniciar el contenedor).
- `GET /readyz` — readiness: hace ping a Mongo y Redis (timeout 1s c/u). `200 {status:"ready"}` si ambos responden; `503 {status:"not_ready", checks:{mongo, redis}}` si alguno falla.
