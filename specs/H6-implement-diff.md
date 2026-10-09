# H6 — Implement + diff

**Objetivo:** ejecutar el plan aprobado en el worktree y revisar el diff.

**Entregables**
- Fase Implement: herramientas `Read, Grep, Glob, Write, Edit, Bash`; entrada plan aprobado; salida cambios + `.flock/<slug>/summary.md`.
- `canUseTool` (real) y las mismas reglas en el mock: rechazar escrituras fuera del worktree y `Bash` con `git push`, `rm -rf /` o `/mnt/`.
- `GET /api/tasks/:id/diff`: `git diff` contra la base excluyendo `.flock/`.
- Commit de fase al aprobar (`git commit --author` del aprobador).
- UI: `DiffView` con `diff2html` en side-by-side por archivo.

**Verificación:** aprobar plan, correr Implement, ver diff por archivo sin `.flock/`; un `git push` simulado es rechazado y queda registrado.
