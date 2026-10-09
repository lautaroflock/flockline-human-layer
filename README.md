# Flockline

Clon web local del núcleo de HumanLayer: tareas que avanzan por **Spec → Research → Plan → Implement**. La **Spec** la escriben las personas a mano (sin agente); las demás fases las produce el agente. Cada fase deja un artefacto Markdown que el equipo puede **comentar o editar directamente** (cada edición crea una versión con autor) y aprobar antes de pasar a la siguiente, y la implementación queda como diff en un **git worktree** aislado. Incluye multiusuario liviano (autor en cada acción, presencia, feed de actividad) y un explorador del worktree.

El spec completo está en `specs/` (un archivo por hito) y en el documento "Spec — Clon web de HumanLayer".

## Requisitos

- **Bun 1.2+**. En esta máquina se instala como dependencia local: `npm install` deja `node_modules/.bin/bun`; con Bun global alcanza `bun`.
- **Git 2.40+** con `user.name` y `user.email`.
- Para `AGENT_MODE=real`: Claude Code autenticado (`claude login`) o `ANTHROPIC_API_KEY` en `.env`.
- Repos de trabajo en el filesystem local. Si usás WSL2, mantenelos en `~/repos/...` y no en `/mnt/c/...` (el acceso cruzado degrada git).

## Uso

```bash
npm install            # instala dependencias (incluye Bun local)
cp .env.example .env   # opcional
npx bun run dev        # http://localhost:3000
npx bun run seed       # crea el repo de ejemplo y la tarea demo (con el servidor corriendo)
npx bun run e2e        # guion completo en modo mock, dos usuarios, sin tocar la UI
npx bun run typecheck
```

Entrás con un nombre (sin contraseñas). Abrí la URL en dos navegadores con nombres distintos para ver presencia, comentarios y aprobaciones con autor.

### Agente mock vs. real

`AGENT_MODE=mock` (por defecto) ejecuta un agente guionado que **escribe archivos reales** en el worktree, sin gastar tokens; sirve para ensayar la demo (usa el repo de `seed`). `AGENT_MODE=real` usa el Claude Agent SDK con `cwd` en el worktree, una sesión por fase y `canUseTool` con las mismas reglas de seguridad.

### Variables

| Variable | Default | Uso |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Dirección del servidor |
| `WORKTREES_DIR` | `~/.flockline/worktrees` | Dónde viven los worktrees |
| `AGENT_MODE` | `mock` | `mock` o `real` |
| `CLAUDE_MODEL` | — | Modelo para modo real |
| `SESSION_SECRET` | dev | Firma de tokens de sesión |
| `DB_PATH` | `data/flockline.db` | Base SQLite |

## Que entren otras personas

El servidor escucha en `127.0.0.1`. Para compartirlo en una red de confianza: `HOST=0.0.0.0`. Con WSL2, `localhost` solo se reenvía a la propia máquina: usá `networkingMode=mirrored` en `.wslconfig` o un túnel. No hay autenticación real: no lo expongas a Internet.

## Spec manual y edición

- La etapa **Spec** no corre agente: pestaña Spec → "Escribir spec" (plantilla precargada) → guardar → aprobar. La spec aprobada entra en los prompts de Research, Plan e Implement.
- **✎ Editar** está disponible en el artefacto de la fase activa mientras espera revisión. Guardar crea una versión nueva (`PUT /api/tasks/:id/phases/:phase/artifact`), reescribe el archivo del worktree y migra los comentarios abiertos cuya cita sigue en el texto. Si otra persona guardó antes, el servidor responde 409.
- El resumen de Implement no se edita a mano.

## Abortar, cancelar y retroceder

- **Abortar sesión**: corta la ejecución del agente en curso; la fase vuelve a `idle`.
- **Cancelar tarea**: corta la sesión en curso y bloquea ejecutar/aprobar hasta **Reabrir**. El worktree y el historial se conservan.
- **↩ Volver a una fase** (en cada paso aprobado del stepper): el worktree vuelve al commit con que se aprobó esa fase; se descartan el código y los artefactos de las fases siguientes y esas fases quedan sin aprobar. Las versiones anteriores siguen en el historial.
- **↺ Rehacer** la fase actual: descarta su resultado sin aprobar y la deja lista para ejecutarse de nuevo.

## Seguridad del agente

En modo real cada herramienta pasa por la guarda (`src/server/guard.ts`) vía `canUseTool` y un hook `PreToolUse`: lecturas y escrituras confinadas al worktree (Research/Plan solo escriben en `.flock/<slug>/`), Bash por lista blanca (`BASH_ALLOW`) y sesión aislada de los settings, hooks y MCP del usuario. `npx bun run test` corre los tests de la guarda; `npx bun run check:real` lo verifica contra el SDK real (unos centavos).

## Atajos

`N` nueva tarea · `J`/`K` tarea siguiente/anterior · `Ctrl+Enter` ejecutar o aprobar la fase activa · `C` comentar la selección · `]` siguiente pestaña.

## Resetear

```bash
rm data/flockline.db       # borra tareas y comentarios
git -C <repo> worktree prune
```

## Estructura

```
src/server  index.ts · routes.ts · orchestrator.ts · agent.ts · guard.ts · git.ts · files.ts · db.ts · bus.ts · presence.ts · prompts/
src/shared  types.ts
src/web     main.tsx · store.ts · api.ts · components/
scripts     spike.ts · seed.ts · e2e.ts · autocommit.mjs
specs       un spec por hito (H0–H9)
```

## Commits automáticos

`.claude/settings.json` registra un hook `PostToolUse` (`Write|Edit`) que ejecuta `scripts/autocommit.mjs`: cada archivo que Claude Code implementa en este repo se commitea con el hito de `specs/.current` como prefijo.
