# H11 — Cancelar, reabrir y retroceder (implementado)

**Estado:** implementado en `3fca49a`, con la seguridad del agente real en `28097b1`. Este archivo deja asentado el alcance.

**Comportamiento**
- `POST /api/tasks/:id/cancel`: corta la sesión en curso y pasa la tarea a `cancelled`. Mientras esté cancelada no se ejecuta, aprueba ni edita.
- `POST /api/tasks/:id/reopen`: vuelve a `awaiting_review` si la fase tiene artefacto; si no, a `idle`.
- `POST /api/tasks/:id/rewind { to }`:
  - A una fase anterior: el worktree vuelve al commit de aprobación de esa fase (`reset --hard` + `clean`). Las fases desde `to` quedan sin aprobar y las versiones viejas quedan en el historial.
  - A la fase actual ("rehacer"): descarta lo no aprobado y la deja en `idle`.
  - Con una sesión corriendo → 409. Hacia adelante → 409.
- Actividad: `task.cancelled`, `task.reopened`, `phase.rewound`.

**Verificación:** sección H11 de `bun run e2e`.
