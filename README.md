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

El CI corre estos mismos comandos en cada push/PR contra `main`/`develop` y bloquea el merge si el lint o los tests fallan — ver [`.github/workflows/ci.yml`](.github/workflows/ci.yml) y [`docs/ADR-01-CI-CD-Pipeline.md`](docs/ADR-01-CI-CD-Pipeline.md) para el detalle de qué corre, qué queda como deuda técnica (`/readyz` sin chequear Mongo/Redis) y por qué CD todavía no está automatizado.
