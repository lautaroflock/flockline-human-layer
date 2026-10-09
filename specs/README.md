# Specs por hito

Cada hito del plan (§8 del spec "Clon web de HumanLayer") tiene su archivo. Se implementan en orden; al cerrar uno se corre su verificación y se commitea como `H<n>: <descripción>`. El hook `scripts/autocommit.mjs` además commitea cada `Write`/`Edit` con el prefijo del hito que figure en `specs/.current`.

| Hito | Spec | Duración |
|---|---|---|
| H0 | [H0-spike-sdk.md](H0-spike-sdk.md) | 0,5 h |
| H1 | [H1-esqueleto.md](H1-esqueleto.md) | 0,5 h |
| H2 | [H2-tareas-worktrees.md](H2-tareas-worktrees.md) | 1 h |
| H3 | [H3-orquestador-streaming.md](H3-orquestador-streaming.md) | 1,5 h |
| H4 | [H4-gates-fases.md](H4-gates-fases.md) | 1 h |
| H5 | [H5-comentarios-revision.md](H5-comentarios-revision.md) | 1,5 h |
| H6 | [H6-implement-diff.md](H6-implement-diff.md) | 1 h |
| H7 | [H7-pulido-ensayo.md](H7-pulido-ensayo.md) | 1 h |
| H8 | [H8-multiusuario.md](H8-multiusuario.md) | 2 h |
| H9 | [H9-worktree-navegable.md](H9-worktree-navegable.md) | 1 h |
| H10 | [H10-spec-manual-y-edicion.md](H10-spec-manual-y-edicion.md) | 1,5 h |

## Decisiones de entorno (desvíos del spec)

- El spec pide Bun dentro de WSL2. Esta máquina no tiene Bun ni Node en WSL, así que se corre **nativo en Windows** con Bun instalado como dependencia local (`node_modules/.bin/bun`), sin instalar nada global. El código usa solo APIs de Bun y rutas con `node:path`, por lo que corre igual en WSL2.
- `AGENT_MODE=mock` (por defecto en tests y en el seed) ejecuta un agente guionado que escribe los artefactos reales en el worktree, sin gastar tokens. `AGENT_MODE=real` usa el Claude Agent SDK con la sesión de Claude Code ya autenticada.
