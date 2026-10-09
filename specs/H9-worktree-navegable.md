# H9 — Worktree navegable (spec §11.6)

**Objetivo:** recorrer la estructura de carpetas y los archivos del worktree desde la UI.

**Entregables**
- `src/server/files.ts`: `resolveInside(worktree, rel)` con `path.resolve` + `realpath`; rechaza `..`, symlinks que salen, rutas absolutas y `.git`. Límite 512 KB; binarios devuelven solo metadatos.
- `GET /api/tasks/:id/tree`: archivos del worktree (sin `.git/` ni `node_modules/`) con estado M/A según `git status --porcelain`.
- `GET /api/tasks/:id/file?path=` y `GET /api/tasks/:id/commits` (hash, asunto, autor, fecha).
- Evento `worktree.changed` tras cada `Write`/`Edit` del agente y al cerrar fase.
- UI: pestaña Archivos con `FileTree` plegable, `FileViewer` y cabecera (ruta del worktree, rama, base, commits). `]` recorre las cuatro pestañas.

**Verificación:** el árbol refleja el worktree con marcas M/A; `path=../../etc/passwd`, `.git/config` y un symlink hacia afuera devuelven 400.
