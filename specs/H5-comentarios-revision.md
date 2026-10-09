# H5 — Comentarios y revisión

**Objetivo:** comentar sobre un artefacto y regenerarlo con `resume`.

**Entregables**
- `POST /api/artifacts/:id/comments` `{ quote, body }` (autor desde la sesión), `PATCH /api/comments/:id` (estado/texto).
- `POST /phases/:phase/revise`: toma todos los comentarios `open` de la última versión, los pasa a `sent` en una transacción, abre una sesión `kind=revise` con `resume` del `sdk_session_id` anterior y el prompt `revise.md`; al terminar crea la versión n+1.
- Solo se comenta la última versión en `awaiting_review`.
- Comentarios cuyo `quote` ya no existe en la versión nueva: huérfanos (visibles, sin marca).
- UI: `CommentLayer` (selección de texto → popover → composer, marcas con el color del autor, lista con cita, Resolver, "Enviar comentarios al agente").

**Verificación:** comentario sobre el plan v1 → `revise` → v2 que lo incorpora y el comentario queda `sent`.
