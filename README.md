# Flockline

**Flockline es un espacio de trabajo local donde un agente de código (Claude) hace tareas de ingeniería por etapas, y un equipo de personas revisa, corrige y aprueba cada etapa antes de que avance.** Está inspirado en [HumanLayer](https://humanlayer.com/): el agente no escribe 500 líneas de código sin contexto. Primero investiga y planifica, y las personas revisan esos documentos cortos. Recién después implementa, en una copia aislada del repo.

```
 Spec ──► Research ──► Plan ──► Implement ──► (merge manual)
  │          │          │          │
 personas   agente     agente     agente        cada flecha es una aprobación humana
            ▲ comentar / editar / pedir revisión / volver atrás ▲
```

## La idea en 30 segundos

1. **Abrís un proyecto**: la ruta de un repo git local.
2. **Creás una tarea**: escribiéndola o importando un ticket. Flockline crea una **rama y un git worktree** solo para esa tarea; tu rama principal no se toca nunca.
3. **Escribís la spec** a mano: qué se quiere, el alcance y los criterios de aceptación.
4. **El agente investiga** el código y escribe `research.md`. Vos y tu equipo lo **comentan, editan o aprueban**.
5. **El agente planifica** (`plan.md`) con lo aprobado. Mismo ciclo: comentarios → revisión → aprobación.
6. **El agente implementa** el plan en el worktree y corre los tests. Revisás el **diff**, con el **contexto del cambio**: qué llama el código nuevo y desde dónde se lo usa.
7. Si te convence, aprobás, y la rama queda lista para mergear.

Todo queda registrado: versiones de cada documento con su autor, comentarios, sesiones del agente con cada herramienta que usó, costo y commits por fase.

## Qué incluye

| Área | Qué hace |
|---|---|
| **Proyectos** | Varios repos abiertos a la vez, con un filtro de tareas por proyecto. Cada proyecto elige su agente: **Claude real** (por defecto) o **mock** (demo sin costo). |
| **Flujos de trabajo** | RPI, QRSPI, Outline, PRD, Oneshot y Freeform (ver tabla abajo). |
| **Agente** | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk): una sesión por fase, en el worktree de la tarea, con log en vivo de texto, razonamiento y herramientas. |
| **Revisión humana** | Comentarios sobre texto seleccionado, edición directa con versiones y autor, pedir una nueva versión al agente con los comentarios, aprobar, volver a una fase anterior, rehacer, abortar y cancelar. |
| **Preguntas** | En QRSPI, el agente pregunta lo que cambia el diseño y las personas responden antes de que siga. |
| **Diagramas y mockups** | Mermaid dibujado dentro de los documentos. `mockup.html` versionados y mostrados en un iframe aislado. |
| **Contexto del cambio** | En el diff: qué funciones usa el código cambiado (con su cuerpo) y quién lo llama. Se expande nivel por nivel. Para TS/JS usa el LanguageService de TypeScript (el motor del LSP); para otros lenguajes, búsqueda de texto. |
| **Worktree navegable** | Árbol de archivos con marcas M/A, visor con números de línea y commits por fase. |
| **Multiusuario** | Identidad por nombre, presencia (quién mira qué pestaña), autor en cada acción y feed de actividad. Todo en vivo por WebSocket. |
| **Tickets** | Importar desde Jira: hoy es un **mock** con tres tickets de ejemplo, listo para conectar el real. |
| **Seguridad del agente** | Cada herramienta pasa por una guarda: lecturas y escrituras solo dentro del worktree, Bash por lista blanca y sesión aislada de tu configuración. |

## Flujos de trabajo

| Flujo | Fases | Para qué |
|---|---|---|
| **RPI** (default) | Spec → Research → Plan → Implement | Cambios medianos |
| **QRSPI** | Spec → Questions → Research → Design → Structure → Plan → Implement | Cambios grandes o ambiguos |
| **Outline** | Spec → Research → Outline → Implement | Cambios acotados: un esquema corto en vez de un plan detallado |
| **PRD** | PRD → Research → Design → Plan → Implement | Funcionalidades nuevas de producto |
| **Oneshot** | Spec → Implement | Bugs chicos y tareas obvias |
| **Freeform** | Sin fases | Sesiones sueltas con un pedido libre sobre el mismo worktree |

Las fases **Spec** y **PRD** las escriben personas, con una plantilla precargada. Las demás las produce el agente, y cada una recibe los documentos aprobados de las anteriores.

## Empezar

**Requisitos**
- Node 20+ y Git 2.40+, con `user.name` y `user.email` configurados.
- Bun se instala solo como dependencia local con `npm install`. No hace falta tenerlo global.
- Para el agente real: Claude Code con la sesión iniciada (`claude login`) o `ANTHROPIC_API_KEY` en `.env`.

**Levantar la app**

```bash
npm install
```
```bash
npx bun run dev
```

Abrí http://localhost:3000, entrá con tu nombre (no hay contraseñas), tocá **+ Abrir** en la barra lateral y elegí la ruta de un repo. Abrí la app en dos navegadores con nombres distintos para ver la colaboración en vivo.

**Probar sin gastar tokens.** Con el servidor corriendo, en otra terminal:

```bash
npx bun run seed
```

Crea un repo de ejemplo (`~/.flockline/demo-api`), lo abre como proyecto en modo **mock** y le agrega la tarea del guion de demo: "Agregar rate limiting por IP al endpoint /login".

## Cómo se trabaja una tarea

1. **Spec**: pestaña Spec → "Escribir spec" → Guardar → **Aprobar**.
2. **Ejecutar** la fase (o `Ctrl+Enter`). El log muestra en vivo lo que hace el agente.
3. **Revisar** el documento:
   - seleccioná texto → **Comentar**;
   - **✎ Editar** para corregir a mano (crea una versión nueva con tu nombre);
   - **Enviar comentarios al agente** para que reescriba el documento con esos cambios.
4. **Aprobar como…**: deja un commit de fase en la rama de la tarea y avanza a la siguiente.
5. En **Implement**, revisá **Diff** y **Contexto del cambio**, y si hace falta **Archivos**.
6. **Merge**: Flockline no mergea solo. Desde tu repo:

```bash
git merge flock/<slug-de-la-tarea>
```

**Si algo sale mal:**
- **Abortar sesión** corta al agente.
- **↺ Rehacer** descarta el resultado de la fase actual.
- **↩ Volver** lleva el worktree al momento en que se aprobó una fase anterior.
- **Cancelar tarea** la congela hasta reabrirla.

**Atajos:** `N` nueva tarea · `J`/`K` tarea siguiente/anterior · `Ctrl+Enter` ejecutar o aprobar · `C` comentar la selección · `]` siguiente pestaña.

## El agente: real y mock

- **Real** (por defecto): Claude Agent SDK con `cwd` en el worktree.
  - Cada fase tiene sus herramientas y un **tope de turnos y de dólares** (`PHASE_LIMITS` en `src/server/agent.ts`, escalable con `AGENT_BUDGET_SCALE`).
  - Cuando una revisión pide cambios, retoma la sesión anterior (`resume`).
- **Mock**: un guion determinista que escribe archivos de verdad, pensado **solo** para el repo de demo. En otros repos no hace el trabajo real. Sirve para ensayar y para los tests.

**La guarda** (`src/server/guard.ts`) se aplica con `canUseTool` y con un hook `PreToolUse` que corre antes de **toda** herramienta:
- Lecturas y escrituras solo dentro del worktree. Research, Plan y las demás fases de documentos solo escriben en `.flock/<slug>/`.
- Bash por **lista blanca** (`bun test`, `npm test`, `node --test`, `git status/diff/log`…), sin operadores de shell. Configurable con `BASH_ALLOW`.
- Sesión **aislada**: no carga tus hooks, MCP ni settings, ni los del repo destino. El `CLAUDE.md` del repo se le pasa como contexto.

## Pruebas

| Comando | Qué prueba | Costo |
|---|---|---|
| `npx bun run test` | Guarda de herramientas y motor de contexto del cambio (unitarios) | — |
| `npx bun run e2e` | Guion completo por HTTP + WebSocket con dos usuarios y el agente mock: los 17 hitos, unas 190 verificaciones | — |
| `npx bun run e2e:real` | RPI completo, QRSPI hasta Design y Freeform con **Claude real** sobre el repo de demo. Verificaciones estructurales e informe del costo | ~US$1,5–2 |
| `npx bun run check:real` | La guarda contra el SDK real: intenta leer y escribir fuera de lo permitido | centavos |
| `npx bun run typecheck` | Tipos (TypeScript estricto) | — |

## Configuración

| Variable | Default | Uso |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Dirección del servidor. `HOST=0.0.0.0` para compartirlo en una red de confianza |
| `AGENT_MODE` | `real` | Agente por defecto de los proyectos nuevos (`real` o `mock`) |
| `CLAUDE_MODEL` | el del SDK | Modelo del agente real |
| `AGENT_BUDGET_SCALE` | `1` | Escala los topes de US$ por fase |
| `BASH_ALLOW` | lista de tests y git de lectura | Comandos que el agente puede correr |
| `WORKTREES_DIR` | `~/.flockline/worktrees` | Dónde viven los worktrees |
| `DB_PATH` | `data/flockline.db` | Base SQLite |
| `TICKETS_MODE` | `mock` | Único valor válido por ahora: con otro valor el servidor no arranca |
| `SESSION_SECRET` | de desarrollo | Firma de los tokens de sesión. Cambialo si compartís la app |

No hay autenticación real: no expongas la app a Internet. Con WSL2, `localhost` solo se reenvía a la propia máquina; para compartirla usá `networkingMode=mirrored` o un túnel.

## Arquitectura

Un solo proceso [Bun](https://bun.sh): servidor HTTP + WebSocket, SQLite (`bun:sqlite`) y el bundle de la interfaz en React. El estado en vivo viaja por WebSocket, con una suscripción por tarea.

```
src/server/
  index.ts          Bun.serve: rutas REST, WebSocket y la SPA
  routes.ts         API REST
  orchestrator.ts   máquina de estados de las fases: toda transición se valida acá, no en la UI
  agent.ts          agente real (Agent SDK) y mock, topes por fase
  guard.ts          guarda de herramientas
  service.ts        proyectos, tareas y detalle
  git.ts            worktrees, diff, commits, reset al retroceder
  files.ts          lectura segura de archivos del worktree
  codeintel/        contexto del cambio (TypeScript LanguageService + búsqueda de texto)
  integrations/     tickets (Jira mock)
  prompts/          un prompt por fase, en Markdown y editable
  db.ts · bus.ts · presence.ts · auth.ts
src/shared/
  types.ts          tipos compartidos servidor/cliente
  workflows.ts      catálogo de fases y flujos
src/web/            React: store, componentes (stepper, log, documentos, diff, archivos, preguntas…)
scripts/            seed, e2e, e2e-real, spike del SDK, autocommit
tests/              unitarios (bun test)
specs/              un spec por hito, H0 a H17
```

Datos: tareas, sesiones, eventos del agente, versiones de cada documento, comentarios, preguntas, actividad y proyectos en SQLite. El código y los documentos aprobados viven en la rama `flock/<slug>` de cada worktree.

## Estado y límites

- Pensado para uso local y demos de equipo, no para producción: la identidad es solo un nombre.
- Los tickets de Jira son de ejemplo. No hay integración real con Jira ni con Linear.
- El merge a la rama principal es manual, a propósito.
- El contexto del cambio es exacto en TS/JS y aproximado en el resto de los lenguajes; conectar servidores LSP de otros lenguajes queda pendiente.
- La historia completa del diseño está en [`specs/`](specs/), un archivo por hito, con lo que se decidió y cómo se verificó.

## Resetear

```bash
rm data/flockline.db
```
```bash
git -C <repo> worktree prune
```

El primero borra proyectos, tareas e historial. El segundo limpia los worktrees huérfanos de un repo.

## Desarrollo de Flockline con Claude Code

`.claude/settings.json` registra un hook `PostToolUse` (`Write|Edit`) que corre `scripts/autocommit.mjs`: cada archivo que Claude Code escribe en este repo se commitea, con el hito de `specs/.current` como prefijo.
