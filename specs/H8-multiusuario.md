# H8 — Multiusuario (spec §11.1–11.4, 11.5 parcial, 11.7)

**Objetivo:** varias personas sobre la misma tarea, con autoría en cada acción.

**Entregables**
- `POST /api/session { name }`: crea o reutiliza el usuario, asigna color fijo, devuelve un token firmado (HMAC con `SESSION_SECRET`). Cookie `flock_session` y header `Authorization`. Sin token → 401 en la API y el WS.
- Autor tomado siempre del token: `created_by`, `started_by`, `approved_by/at`, `author_id`, `resolved_by`.
- Tabla `activity` + `GET /api/tasks/:id/activity`; entradas en cada acción.
- Presencia en memoria: el cliente envía `{ type: "presence", taskId, tab }`; el servidor emite `presence.changed`.
- Eventos nuevos: `comment.created`, `activity.added`, `presence.changed`.
- Concurrencia: mutex por tarea para transiciones; 409 en la segunda aprobación.
- Red: `HOST` configurable; README documenta mirrored networking / túnel.
- UI: pantalla de nombre, `UserSwitcher`, `PresenceBar`, `ActivityFeed`, "Aprobar como <nombre>".

**Verificación:** dos clientes WS (dos usuarios) ven los mismos eventos y comentarios con autor; dos aprobaciones simultáneas → una sola transición.
