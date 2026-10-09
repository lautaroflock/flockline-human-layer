# H13 — Fase de preguntas, Design y Structure (QRSPI)

**Objetivo:** completar el flujo `qrspi` de H12. Antes de investigar, el agente hace preguntas aclaratorias que responden personas. Entre Research y Plan se agregan dos fases: Design (qué enfoque y por qué) y Structure (cómo se organiza el código). Cada una tiene su punto de control humano.

Flujo: Spec → **Questions** → Research → **Design** → **Structure** → Plan → Implement.

## Questions

**Qué hace el agente:** lee la spec y recorre el código por encima (Read, Grep, Glob, sin escribir). Devuelve entre 3 y 10 preguntas cuya respuesta cambia el diseño. No pregunta lo que puede averiguar leyendo el código.

**Salida estructurada:** se usa `outputFormat` con JSON schema del SDK (confirmado en `sdk.d.ts`). Cada pregunta tiene:
- `text`: la pregunta;
- `why`: qué decisión depende de la respuesta;
- `options` (opcional): alternativas concretas;
- `suggestion`: la respuesta que el agente elegiría si nadie contesta.

**Modelo de datos** (migración 4): tabla `questions` con `id`, `task_id`, `artifact_id`, `idx`, `text`, `why`, `options` (JSON), `suggestion`, `answer`, `status` (`open | answered | skipped`), `answered_by` y `answered_at`.

**Respuestas (multiusuario)**
- `PATCH /api/questions/:id { answer }` o `{ status: "skipped" }`, con el autor tomado de la sesión.
- Evento WS `question.updated` y actividad `question.answered`.
- Cualquier persona puede responder o cambiar una respuesta mientras la fase esté en revisión.

**Aprobación**
- Exige que no quede ninguna pregunta `open`; si queda alguna → 409 con el número de pendientes.
- "Usar sugerencia" responde con la `suggestion` del agente y deja registrado quién la aceptó.
- Al aprobar, el servidor genera `.flock/<slug>/questions.md` con preguntas, respuestas y autores, y lo commitea como cualquier artefacto.

**Hacia adelante:** las respuestas entran como `{{answers}}` en Research, Design, Structure, Plan e Implement.

**Re-preguntar:** "Pedir más preguntas" corre una sesión `revise` con las respuestas dadas. Las preguntas nuevas se agregan sin borrar las respondidas.

## Design

- Artefacto `design.md`. El prompt `src/server/prompts/design.md` pide:
  - el enfoque elegido;
  - 2 o 3 alternativas descartadas, con su motivo;
  - riesgos y su mitigación;
  - al menos un diagrama Mermaid (H14);
  - si toca UI, un `mockup.html` (H14).
- Herramientas: las de Research (solo escribe en `.flock/<slug>/`).
- Entradas: spec, respuestas y research aprobados.
- Se comenta, edita, revisa, aprueba y retrocede igual que Research.

## Structure

- Artefacto `structure.md`. El prompt `src/server/prompts/structure.md` pide:
  - archivos a crear y modificar, con su responsabilidad;
  - firmas públicas (funciones, tipos, endpoints);
  - formas de los datos;
  - orden de dependencias.
  Sin implementación.
- Entradas: spec, respuestas, research y design aprobados.
- Plan recibe Structure y debe respetarla: cada paso referencia los archivos de Structure.

## UI

- **Pestaña Questions:** una tarjeta por pregunta con `why`, opciones como botones, campo de respuesta, "Usar sugerencia" y "No aplica". Muestra autor y hora de cada respuesta, y un contador "3/7 respondidas" en la pestaña y el stepper.
- **Pestañas Design y Structure:** el mismo `ArtifactView` de hoy, con comentarios, edición y versiones.
- **Fase activa:** las tarjetas de preguntas se muestran también en el centro, en lugar del log, para que no queden escondidas en una pestaña.

## Mock

El agente mock devuelve 4 preguntas fijas para `demo-api`, por ejemplo:
- ¿La IP sale de `X-Forwarded-For`?
- ¿El límite es por IP o por IP y usuario?
- ¿Hace falta persistir los contadores?
- ¿Cuál es el valor de `Retry-After`?

También escribe un `design.md` con un diagrama Mermaid y un `structure.md` coherentes con esas respuestas.

## Fuera de alcance
- Preguntas que el agente hace a mitad de otra fase (pausar una sesión de Implement para preguntar). Va en otro hito, junto con aprobar permisos desde la UI.

## Verificación (`bun run e2e`, sección H13)
- `qrspi`: Questions genera 4 preguntas; aprobar con 1 abierta → 409.
- Ana responde 2, Lautaro acepta 1 sugerencia y marca 1 como no aplica; todas quedan con su autor.
- `questions.md` queda commiteado con las respuestas.
- Research recibe `{{answers}}`: el mock lo refleja en su texto.
- Design produce `design.md` con un bloque ` ```mermaid `. Structure produce `structure.md`, y Plan cita sus archivos.
- Retroceder a Questions deja editables las respuestas y desaprueba las fases siguientes.
