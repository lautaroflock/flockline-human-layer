# H4 — Gates y fases

**Objetivo:** ninguna fase arranca sin la aprobación humana de la anterior, validado en el servidor.

**Entregables**
- `POST /phases/:phase/approve`: marca la última versión como aprobada, hace commit de fase en el worktree y avanza (`research → plan → implement → done`). Carrera entre dos aprobaciones → una sola transición, la otra recibe 409.
- `run` de una fase con la previa no aprobada → 409 (sin importar lo que haga la UI).
- Fase Plan: prompt con `{{research}}` aprobado; genera `plan.md`.
- UI: `PhaseStepper` (estados y botones Ejecutar/Aprobar/Reintentar/Abortar), `ArtifactPanel` con pestañas y selector de versión, Markdown con `react-markdown` + `remark-gfm`.
- `GET /api/artifacts/:id` y `/api/tasks/:id/artifacts/:phase/versions`.

**Verificación:** `run plan` antes de aprobar research → 409; aprobar research habilita Plan; Plan genera `plan.md` v1.
