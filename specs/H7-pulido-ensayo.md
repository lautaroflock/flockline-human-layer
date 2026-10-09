# H7 — Pulido y ensayo

**Objetivo:** guion de demo completo sin tocar la terminal.

**Entregables**
- Atajos: `N`, `J/K`, `Ctrl+Enter`, `C`, `]`.
- Abortar (`AbortController`), estados de error con "Reintentar", reconexión del WS que recarga la tarea activa.
- `scripts/seed.ts`: crea un repo de ejemplo (API pequeña en TypeScript con `/login`, un `rateLimit.ts` sin uso y un test) y la tarea "Agregar rate limiting por IP al endpoint /login".
- `scripts/e2e.ts`: recorre el guion §9 por HTTP + WS en modo mock y afirma los criterios de aceptación.
- README completo (prerrequisitos, `.env`, comandos, reset: `rm data/flockline.db` y `git worktree prune`).

**Verificación:** `bun run e2e` pasa de punta a punta; reiniciar el servidor conserva tareas, artefactos, comentarios y eventos.
