# H12 — Tipos de flujo de trabajo

**Objetivo:** que cada tarea elija su flujo, como en HumanLayer, en lugar del único Spec → Research → Plan → Implement. Es la base de H13 (fases Questions, Design y Structure) y de H15 (sugerir el flujo según el ticket).

## Flujos

| Id | Nombre | Fases | Cuándo usarlo |
|---|---|---|---|
| `rpi` | RPI (default) | Spec → Research → Plan → Implement | El flujo actual. Cambios medianos. |
| `qrspi` | QRSPI | Spec → Questions → Research → Design → Structure → Plan → Implement | Cambios grandes o ambiguos (H13). |
| `outline` | Outline | Spec → Research → Outline → Implement | Cambios acotados: un esquema corto reemplaza al plan detallado. |
| `prd` | PRD | PRD → Research → Design → Plan → Implement | Funcionalidad nueva de producto: requisitos y diseño técnico antes del plan. |
| `oneshot` | Oneshot | Spec → Implement | Bugs chicos y tareas obvias. |
| `freeform` | Freeform | sin fases | Sesiones sueltas con prompt libre (ver abajo). |

Con esto la etapa Spec deja de ser fija: es la primera fase manual de los flujos que la usan. En `prd`, esa primera fase manual se llama PRD y usa otra plantilla.

## Diseño

**Catálogo de fases** (`src/shared/workflows.ts`, reemplaza a `PHASES` y `AGENT_PHASES`). Cada fase declara:
- `id` y `label`;
- `kind`: `manual` (la escriben personas), `agent` o `questions` (H13);
- `artifact`: archivo en `.flock/<slug>/`, por ejemplo `outline.md` o `prd.md`;
- `tools`: herramientas de la guarda;
- `prompt`: archivo en `src/server/prompts/`;
- `inputs`: qué artefactos aprobados de fases anteriores recibe;
- `editable` y `commentable`.

`WORKFLOWS[id]` es la lista ordenada de fases. Todo lo que hoy hace `PHASES.indexOf(...)` pasa a usar `phasesOf(task.workflow)`:
- `assertCurrent`, `approvePhase` (siguiente fase), `rewindTask` y `statusFor` en `orchestrator.ts`;
- `TOOLS` en `guard.ts`;
- `PhaseStepper`, `ArtifactPanel` (pestañas dinámicas), `store.ts` (`TAB_ORDER`, pestaña por defecto).

**Prompts:** una variable genérica `{{inputs}}` arma un bloque con los artefactos aprobados que declara la fase. Las variables actuales (`{{spec}}`, `{{research}}`, `{{plan}}`) siguen funcionando. Prompts nuevos: `outline.md`, `prd.md` (plantilla manual) y `oneshot-implement.md`; `design.md` y `structure.md` llegan en H13.

**Modelo de datos** (migración 3):
- `tasks.workflow TEXT NOT NULL DEFAULT 'rpi'`. Las tareas existentes quedan en `rpi`.
- `artifacts.phase` y `sessions.phase` pasan a ser cualquier id del catálogo; no hace falta tocar el esquema.

**API**
- `POST /api/tasks` acepta `workflow` (si es inválido → 400).
- `GET /api/workflows` devuelve el catálogo para la UI.
- `PATCH /api/tasks/:id { workflow }` solo mientras no se aprobó ninguna fase (si no → 409). Así se corrige una elección equivocada sin perder trabajo.

**Freeform**
- La tarea no tiene stepper. Muestra una lista de sesiones y el botón "Nueva sesión" con un prompt libre.
- `POST /api/tasks/:id/sessions { prompt }` corre el agente con las herramientas de Implement y la misma guarda.
- No hay artefactos ni aprobaciones. El diff y los archivos se ven igual que en el resto.
- "Cerrar tarea" la pasa a `done`.

**UI**
- `NewTaskModal`: selector de flujo con su descripción y la lista de fases.
- El stepper y las pestañas salen del flujo de la tarea.
- `TaskList`: badge con el nombre del flujo.

## Fuera de alcance
- Flujos definidos por el usuario desde la UI: el catálogo vive en código.
- Cambiar de flujo con fases ya aprobadas.

## Verificación (`bun run e2e`, sección H12)
- Una tarea `oneshot` va de Spec directo a Implement; ejecutar `research` → 400 (la fase no es del flujo).
- Una tarea `outline` genera `outline.md`, e Implement lo recibe en `{{inputs}}`.
- `prd` arranca con plantilla de PRD; `rpi` sigue pasando todo el e2e actual sin cambios.
- `PATCH workflow` con una fase aprobada → 409.
- Freeform: dos sesiones con prompt libre sobre el mismo worktree; la segunda ve los cambios de la primera.
- Retroceder respeta el orden del flujo de la tarea.
