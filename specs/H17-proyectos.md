# H17 — Proyectos (abrir uno o varios repos) y agente real por defecto

**Problema:**
- Hoy cada tarea recibe una ruta de repo suelta y no hay noción de proyecto: no se puede "abrir" un repo, tener varios a la vez ni ver las tareas de cada uno.
- El agente es global. Por defecto es el mock, que en un repo cualquiera escribe cosas guionadas que no tienen nada que ver con la tarea.

## Comportamiento

- **Abrir proyecto:** ruta local de un repo git (validada: existe, es repo y tiene commits), nombre (por defecto, la carpeta) y modo de agente:
  - **real** (Claude Agent SDK, por defecto);
  - **mock** (solo para la demo `demo-api`).
  Abrir un repo que ya estaba abierto devuelve ese mismo proyecto y lo reactiva si estaba cerrado.
- **Varios proyectos:** la barra lateral lista los proyectos abiertos y una opción "Todos". Elegir uno filtra la lista de tareas, y "Nueva tarea" se crea en ese proyecto (ya no se escribe la ruta).
- **Cerrar proyecto:** lo oculta de la barra sin borrar tareas ni worktrees. Si hay una sesión corriendo → 409.
- **Modo de agente por proyecto:**
  - el orquestador usa el modo del proyecto de la tarea;
  - la cabecera de la tarea muestra "Agente: Claude (real)" o "Agente: mock";
  - se puede cambiar desde el proyecto, y vale para las sesiones siguientes.
- **Compatibilidad:** `POST /api/tasks` con `repoPath`, como antes, busca o crea el proyecto de ese repo. La migración crea un proyecto por cada `repo_path` distinto de las tareas existentes.
- **Default:** `AGENT_MODE` pasa a valer `real` por defecto. El e2e y el seed de la demo piden `mock` explícitamente.

## Modelo de datos (migración 7)

- Tabla `projects`: `id`, `name`, `repo_path` (UNIQUE), `agent_mode` (`real` o `mock`), `archived`, `created_by`, `created_at`.
- Columna `tasks.project_id`.

## API

- `GET /api/projects`: proyectos abiertos con su cantidad de tareas y de tareas activas. Con `?all=1` incluye los cerrados.
- `POST /api/projects { repoPath, name?, agentMode? }`.
- `PATCH /api/projects/:id { name?, agentMode?, archived? }`.
- `POST /api/tasks { projectId | repoPath, … }`.
- Evento WS `projects.changed`.

## Verificación

- **e2e (sección H17):**
  - abrir dos proyectos y crear tareas en cada uno; el filtro por proyecto funciona;
  - abrir el mismo repo dos veces devuelve el mismo proyecto;
  - una ruta inválida → 400;
  - un proyecto en mock usa el agente mock aunque el default sea real;
  - `repoPath` sigue funcionando;
  - cerrar un proyecto con una sesión corriendo → 409.
- **Visual:** abrir el repo `prospeccion-v2` como proyecto con agente real y correr ahí una tarea de punta a punta.
