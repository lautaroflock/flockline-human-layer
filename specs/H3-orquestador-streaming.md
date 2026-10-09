# H3 — Orquestador + streaming

**Objetivo:** ejecutar la fase Research con un agente y ver el log en vivo.

**Entregables**
- `src/server/bus.ts`: pub/sub en memoria; topics `task:<id>` y `tasks`.
- `src/server/agent.ts`: `run({ cwd, prompt, resume?, signal })` como generador asíncrono. Dos implementaciones tras la misma interfaz: `real` (Agent SDK) y `mock` (guion que escribe `.flock/<slug>/research.md` de verdad). Elegida por `AGENT_MODE`.
- `src/server/orchestrator.ts`: máquina de estados §5; `POST /phases/:phase/run` valida el estado, crea la fila `sessions`, itera mensajes, persiste cada uno en `events`, publica en el bus, y al `result` lee el artefacto, crea la versión y pasa a `awaiting_review`. Artefacto ausente → `failed`.
- WebSocket: `subscribe`/`unsubscribe` con topics nativos de Bun; eventos `session.started|event|ended`, `task.updated`, `artifact.created`, `tasks.changed`.
- `GET /api/sessions/:id/events` (replay) y `POST /api/sessions/:id/abort`.
- `canUseTool` (modo real): Research/Plan solo escriben en `.flock/<slug>/`.
- UI: `SessionLog` (texto, thinking plegable, tool calls con input resumido y resultado plegable, costo y turnos).

**Verificación:** ejecutar Research → el log llega por WS con latencia < 1 s por evento y aparece `research.md`; reiniciar el servidor conserva eventos.
