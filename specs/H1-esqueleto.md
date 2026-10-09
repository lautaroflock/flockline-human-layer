# H1 — Esqueleto

**Objetivo:** un solo proceso Bun que sirve la SPA, la API y el WebSocket, con SQLite migrado.

**Entregables**
- `src/server/index.ts`: `Bun.serve` con HTML import (`src/web/index.html`), `routes`, `websocket`, `HOST`/`PORT` desde `.env`.
- `src/server/db.ts`: `bun:sqlite` en `data/flockline.db`, migraciones versionadas (`PRAGMA user_version`), tablas del §4 **y** las de la extensión §11.2 (`users`, `activity`, columnas de autor). Repositorios tipados.
- `src/shared/types.ts`: tipos compartidos.
- `src/web/{index.html,main.tsx}`: SPA vacía con tema oscuro.
- `.env.example`: `PORT`, `HOST`, `WORKTREES_DIR`, `AGENT_MODE`, `CLAUDE_MODEL`, `PUBLIC_URL`.
- `README.md`.

**Verificación:** `bun run dev` sirve la SPA en `http://localhost:3000`; `GET /api/health` devuelve `{ ok: true }`; reiniciar conserva `data/flockline.db`.
