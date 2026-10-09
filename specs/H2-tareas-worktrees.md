# H2 — Tareas y worktrees

**Objetivo:** crear una tarea genera una rama y un git worktree aislado, sin tocar la rama principal del repo.

**Entregables**
- `src/server/git.ts` (sobre `Bun.spawn`): `isRepo`, `addWorktree(repo, slug, base)`, `removeWorktree`, `diff(worktree, base)`, `commitAll(worktree, msg, author)`, `status(worktree)`. Rama `flock/<slug>`, directorio `WORKTREES_DIR/<slug>`.
- Endpoints `GET/POST /api/tasks`, `GET /api/tasks/:id` (§6). El slug sale del título (sin colisiones: sufijo corto).
- UI: `TaskList` y `NewTaskModal` (título, descripción, ruta del repo).
- Errores `{ error }` con 4xx/5xx; validar que `repoPath` sea un repo git con al menos un commit.

**Verificación:** crear una tarea → `git worktree list` en el repo muestra `flock/<slug>`; la rama principal no cambia; ruta inválida devuelve 400.
