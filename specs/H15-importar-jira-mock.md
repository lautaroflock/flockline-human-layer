# H15 — Importar tickets de Jira (mock)

**Objetivo:** mostrar en la demo cómo nace una tarea desde un ticket. Es **solo un mock**: tickets de ejemplo locales, sin conexión a Jira ni credenciales. La interfaz queda lista para enchufar Jira real después.

## Tickets de ejemplo

Archivo `src/server/integrations/jira-mock.json`, con proyecto `FLK`:

| Clave | Tipo | Resumen | Flujo sugerido |
|---|---|---|---|
| FLK-123 | Story | Agregar rate limiting por IP al endpoint /login | `rpi` |
| FLK-124 | Bug | El login devuelve 500 cuando el body viene vacío | `oneshot` |
| FLK-125 | Epic | Rediseñar el flujo de autenticación (MFA opcional) | `qrspi` |

Cada ticket trae:
- descripción, criterios de aceptación como lista, prioridad, etiquetas, reportero y fecha;
- una URL de ejemplo con el aviso de que es ficticia: `https://ejemplo.atlassian.net/browse/FLK-123`.

FLK-123 es el ticket del guion de demo (§9).

## Diseño

**Proveedor:** interfaz `TicketProvider { list(query): Ticket[]; get(key): Ticket | null }` en `src/server/integrations/tickets.ts`.
- La única implementación es `JiraMockProvider`, que lee el JSON.
- `TICKETS_MODE=mock` es el único valor aceptado. Si se configura `jira`, el servidor no arranca y explica que el modo real no está implementado.

**API**
- `GET /api/tickets?q=` busca por clave o resumen.
- `GET /api/tickets/:key` devuelve un ticket (inexistente → 404).
- `POST /api/tasks` acepta `ticketKey` además de los campos actuales:
  - `title`: viene del resumen (editable);
  - `description`: viene de la descripción;
  - `workflow`: el sugerido según el tipo (H12), editable;
  - `slug`: `<clave>-<resumen>` en minúsculas, por ejemplo `flk-123-agregar-rate-limiting-por-ip`.

**Spec inicial:** al crear la tarea desde un ticket, la primera fase manual (Spec o PRD) arranca con una v1 armada desde el ticket: objetivo, criterios de aceptación y prioridad. Esa v1 queda con `created_by = null` y la marca "importada de FLK-123". La persona la edita (v2) y la aprueba como siempre.

**Modelo de datos** (migración 6): `tasks.ticket_source` (`jira-mock`), `ticket_key` y `ticket_url`.

**UI**
- `NewTaskModal`: pestaña "Desde Jira" con un buscador que lista los tres tickets (clave, tipo, resumen, prioridad). Al elegir uno se completan título, descripción y flujo.
- Un aviso fijo en el modal: "Tickets de ejemplo (mock), sin conexión a Jira".
- `TaskList` y la cabecera de la tarea muestran un chip con la clave (FLK-123) y un tooltip con el resumen del ticket. Si se abre el link, se avisa que es una URL de ejemplo.

## Fuera de alcance
- Conexión real a Jira (REST v3, OAuth o API token).
- Sincronizar estado o comentarios de vuelta a Jira.
- Linear y webhooks.

## Verificación (`bun run e2e`, sección H15)
- `GET /api/tickets?q=login` devuelve FLK-123 y FLK-124.
- Crear desde FLK-123 deja título, slug `flk-123-…`, `workflow=rpi` y `ticket_key`, y la spec v1 queda importada con sus criterios de aceptación.
- Crear desde FLK-124 sugiere `oneshot`; desde FLK-125, `qrspi` (requiere H12 y H13; si no están, cae en `rpi`).
- Una clave inexistente → 404. `TICKETS_MODE=jira` → el servidor no arranca y explica el motivo.
