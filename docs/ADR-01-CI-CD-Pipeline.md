## ADR 01: Pipeline de CI y alcance de CD

**Contexto:**
El enunciado del TP exige un pipeline de CI que corra automáticamente ante cada push y **bloquee el merge** ante fallas en los tests, con cobertura mínima del 70% en los servicios backend, y recomienda incorporar análisis estático de seguridad (SAST). También exige CD (despliegue automático a producción desde `main` o por tags), documentado. No existía ningún workflow de CI/CD ni carpeta `docs/` en este repo todavía — es el primer ADR de `Chat-Engine-Service`.

Como paso previo (commit aparte, antes de este ADR) se migró el repo de JavaScript plano a **TypeScript**, alineándolo con el ADR 0002 del org (`docs/architecture/decisions/0002-backend-technology-stack.md`, repo `.github`), que especifica "Node.js / TypeScript" para este servicio — el código había arrancado en JS puro, sin `tsconfig.json` ni archivos `.ts`, en drift respecto a esa decisión. Este ADR ya trabaja sobre el código en TypeScript.

**Decisión:**

* **Refactor previo necesario (antes de la migración a TS):** `src/server.js` creaba la app Fastify y arrancaba el `listen()` en la misma función, sin forma de importar el servidor sin bindear un puerto real. Se separó `src/app.js` (nuevo, antes vacío) — exporta `buildApp()`, crea el Fastify app y registra `/livez`/`/readyz`, sin escuchar — de `src/server.js`, que ahora importa `buildApp()` y hace el `listen()`, guardado con `if (require.main === module)` para poder importarlo desde los tests sin efectos secundarios. Cero cambios de comportamiento en las rutas existentes. Ambos archivos son hoy `.ts` (`src/app.ts`, `src/server.ts`), compilados con `tsc` (`npm run build`) para producción; `tsx` se usa para desarrollo (`npm run dev`, sin paso de compilación) y para correr los tests directo sobre `.ts`.
* **Test runner:** `node:test` (vía `tsx --test`) + `c8` para cobertura — built-in de Node 20, cero framework de testing nuevo (Jest, etc.) para minimizar dependencias dado que hoy el repo tiene cero lógica de negocio además de los health checks. Se agregaron los primeros tests del repo (`tests/health.test.ts`), usando `app.inject()` de Fastify (equivalente a un test client, sin bindear puerto). Nota técnica: `node --test` no reconoce `.ts` en sus patrones de descubrimiento por defecto, así que los scripts de `package.json` pasan el glob explícito (`tests/*.test.ts`, expandido por la shell) en vez de solo el directorio.
* **Type checking:** `tsc --noEmit` como paso de CI aparte (`npm run typecheck`) — detecta errores de tipos sin generar output, independiente del build de producción.
* **Lint:** ESLint con flat config (`eslint.config.js`, formato default desde ESLint 9), vía `typescript-eslint` (parser + reglas para `.ts`) + `eslint-plugin-security`.
* **SAST:** `eslint-plugin-security` (integrado al paso de lint, cero costo extra) + `npm audit --audit-level=high` como paso aparte, informativo (no bloquea el merge).
* **Cobertura:** `c8 --check-coverage` con gate en **85%** (lines/functions/branches/statements), bloqueando merge por debajo — mismo umbral que se usa en Auth-User-Service, por consistencia del estándar de CI del equipo.
* **Servicios en CI:** `mongo:7.0` y `redis:7-alpine` como service containers (mismas imágenes que `docker-compose.yml`). Hoy ningún test los usa (`/readyz` es un stub, ver más abajo), pero deja el patrón listo para cuando se corrija `/readyz` o llegue lógica real de chat que dependa de Mongo/Redis.
* **Build de imagen:** job separado `docker-build`, corre `docker build` sobre el `Dockerfile` existente, sin push — no hay registry/target de deploy configurado todavía.
* **Bloqueo de merge:** el job `test` se configura como *required status check* en `main`/`develop` desde GitHub (Settings → Branches), una vez confirmada una corrida verde real en un PR. El merge nunca es automático.

**CD — explícitamente fuera de alcance de este ADR:**
El enunciado exige documentar en un ADR la elección de plataforma de despliegue (PaaS, orquestador de contenedores gestionado, o cloud provider) antes de automatizar el deploy. A la fecha de este ADR no existe esa decisión en `docs/architecture/decisions/` del repo `.github` (llega hasta el ADR 0009, ninguno cubre infraestructura de despliegue) — mismo motivo por el que CD quedó pendiente en Auth-User-Service (ver su ADR-03). **CD queda pendiente** hasta que exista esa decisión.

**Consecuencias:**

* El pipeline queda verde con solo 2 tests reales (health checks) — la cobertura del 85% se alcanza porque `app.ts` hoy es casi todo lo que hay. A medida que se agregue lógica real de chat (mensajería, WebSockets, persistencia en Mongo), el umbral va a exigir tests reales de esa lógica.
* `/readyz` sigue sin verificar Mongo/Redis — un servicio puede reportarse "ready" sin poder realmente operar. No se corrige acá; queda anotado para que el equipo lo resuelva como cambio de lógica de negocio, no de configuración de CI.
* Cuando exista un ADR de infraestructura de despliegue, este ADR debe actualizarse (o crearse uno nuevo) agregando el job de CD correspondiente.
