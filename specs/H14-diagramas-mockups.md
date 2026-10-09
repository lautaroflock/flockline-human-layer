# H14 — Diagramas y mockups en los artefactos

**Objetivo:** que los artefactos tengan diagramas y vistas previas de UI, no solo texto. Así se revisa un diseño mirándolo, como en HumanLayer (`mockup.html` y diagramas dentro de los artefactos).

## Diagramas (Mermaid)

- Un bloque ` ```mermaid ` en cualquier artefacto se muestra como diagrama en `Markdown.tsx`. Después de inyectar el HTML se buscan los `code.language-mermaid` y se reemplazan por el SVG.
- Librería: `mermaid` (npm, empaquetada por Bun), cargada de forma diferida solo si el documento tiene diagramas. Configuración:
  - `securityLevel: "strict"`, sin HTML dentro de las etiquetas;
  - `theme: "dark"`, alineado con la app.
- Si el diagrama tiene un error de sintaxis, se muestra el código con el aviso "No se pudo dibujar: <error>". El documento no se rompe.
- **Editor (H10):** el editor pasa a dos paneles, Markdown y vista previa en vivo, para que una persona edite un diagrama viendo el resultado.
- **Comentarios:** se comenta el texto del documento, no el interior del SVG. La cita del código Mermaid sigue disponible en el modo fuente.
- **Prompts:** Design (H13) exige al menos un diagrama de componentes o de secuencia. Research y Plan lo permiten cuando hay un flujo con ramas o varios componentes.

## Mockups (HTML)

- En las fases que lo permiten (Design, y Plan en `rpi`), el agente puede escribir `.flock/<slug>/mockup.html` o varios `mockup-<nombre>.html`. Deben ser autocontenidos: CSS en línea y nada externo.
- **Versionado:** tabla nueva `artifact_files (artifact_id, path, content)`, migración 5. Cuando el orquestador registra una versión del artefacto, también guarda una copia de los archivos extra de la fase en `.flock/<slug>/` con extensión `.html`, `.svg` o `.mmd`. Cada versión del documento tiene así sus mockups. Tope: 512 KB por archivo y 5 archivos por versión.
- **Visualización:** en el panel del artefacto, una subpestaña "Mockups" con un selector cuando hay varios. Se muestran en un `<iframe sandbox="allow-scripts" srcdoc=…>`:
  - sin `allow-same-origin`, así que no accede a la app, al token ni a la API;
  - con una CSP propia `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'`;
  - con botones de ancho escritorio y móvil (375 px).
- **Edición:** los mockups no se editan en la UI. Se piden cambios con un comentario general del artefacto ("comentario de documento", sin cita), que va en la próxima revisión.
- **Guarda:** las extensiones permitidas en `.flock/` para Write pasan a ser `.md`, `.html`, `.svg` y `.mmd`. Lo demás se rechaza.

## Mock

Design del agente mock en `demo-api` produce:
- un diagrama de secuencia: cliente → `compose` → `rateLimit` → `login`;
- un `mockup.html` simple con el mensaje de "Demasiados intentos, reintentá en N s".

## Fuera de alcance
- Editor visual de diagramas.
- Exportar a PNG o PDF.
- Comentar zonas de un mockup.

## Verificación
- **Unit:** el render de un bloque Mermaid válido produce un `<svg>`; uno inválido muestra el aviso y el código.
- **e2e:** una versión de Design guarda su `mockup.html` en `artifact_files`. Una revisión que cambia el mockup crea una versión nueva con su copia, y la v1 conserva el mockup original.
- **Seguridad:** el iframe no puede leer `localStorage` de la app. Lo verifica un script del mockup de prueba, que debe fallar. Escribir `.flock/<slug>/x.exe` → rechazado por la guarda.
- **Visual (navegador):** el diagrama se dibuja en tema oscuro y el mockup se ve en los dos anchos.
