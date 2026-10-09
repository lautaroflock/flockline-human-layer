# H10 — Etapa Spec manual y edición de artefactos

**Objetivo:** que las personas puedan (1) definir el spec a mano como primera etapa y (2) editar directamente cualquier artefacto, no solo comentarlo.

**Flujo nuevo:** `Spec (manual) → Research → Plan → Implement`. La etapa Spec no corre agente: la persona escribe el Markdown (con plantilla precargada), lo guarda y lo aprueba. El spec aprobado entra como `{{spec}}` en los prompts de Research, Plan e Implement.

**Entregables**
- `PHASES` pasa a 4 fases; las tareas nuevas arrancan en `spec` / `idle`. Tareas existentes siguen en su fase.
- `PUT /api/tasks/:id/phases/:phase/artifact { content, baseVersion }`: crea una versión nueva con autor.
  - Solo en la fase activa; en `spec` desde `idle` o `awaiting_review`; en research/plan solo en `awaiting_review`; nunca en `implement` ni con una sesión corriendo.
  - Concurrencia optimista: si `baseVersion` no es la última → 409 (alguien editó antes).
  - Escribe `.flock/<slug>/<fase>.md` en el worktree para que las fases siguientes y los commits vean el texto editado.
  - Los comentarios abiertos cuya cita sigue en el texto nuevo se pasan a la versión nueva; el resto queda en la versión vieja.
  - `run` y `revise` sobre `spec` → 400 (no hay agente).
- Actividad `artifact.edited` y evento `artifact.created` por WS.
- UI: pestaña Spec, paso Spec en el stepper (sin "Ejecutar"), botón **Editar** en cada artefacto editable con textarea, plantilla de spec, aviso de conflicto de versión.

**Verificación (`bun run e2e`):** spec escrito a mano → aprobado → habilita Research; editar research crea v2 con el autor y reescribe el archivo; `baseVersion` viejo → 409; editar `implement` → 400; `run spec` → 400; los comentarios abiertos migran a la versión nueva; Plan recibe el spec aprobado.
