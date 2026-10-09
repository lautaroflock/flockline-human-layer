# H16 — Contexto del cambio en la revisión

**Problema** (de la conversación con el equipo): al revisar lo que hizo el agente, el diff muestra solo las líneas modificadas. Si el cambio llama a un método que ya existía, no se ve qué hace ese método. Tampoco se ve desde dónde se llama la función modificada. Para revisar hay que ir a un editor a buscar. El contexto tiene que ir en las dos direcciones:
- **hacia abajo**: qué hace lo que el código cambiado llama;
- **hacia arriba**: quién llama a lo que cambió.

**Objetivo:** en la pestaña Diff, una vista "Contexto del cambio" centrada en los cambios. Agrupa por función modificada y muestra, sin salir de la revisión, las definiciones que esa función usa y los lugares desde donde se la llama. Se puede expandir un nivel más en cualquier dirección.

## Motor: navegación de código tipo LSP

> Nota de implementación: el `typescript` del proyecto es la versión 7 (nativa), que no expone la API de JavaScript. El motor usa TypeScript 5.9 instalado como alias `ts-api`.

Interfaz `CodeIntel` en `src/server/codeintel/` con dos implementaciones:

| Motor | Lenguajes | Precisión | Cómo |
|---|---|---|---|
| `ts` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | Exacta | `ts.LanguageService` de TypeScript, el mismo motor que `tsserver` y el servidor LSP de TS, sobre los archivos del worktree. Usa *go to definition*, *find references* y el árbol de sintaxis. |
| `text` | Resto (Python, Go, Java, C#…) | Aproximada | Búsqueda de texto: definiciones por patrón (`def`, `func`, `function`, `fn`, asignaciones) y llamadas por `nombre(`. La UI lo marca "aproximado". |

Un cliente LSP genérico por stdio (pyright, gopls, etc.) queda como mejora futura detrás de la misma interfaz.

## Qué calcula

1. **Líneas cambiadas:** `git diff -U0 <base>` contra la base de la tarea, sin `.flock/`. Cuenta lo nuevo y lo modificado, del lado nuevo.
2. **Símbolo que contiene cada cambio:** la función, método o arrow con nombre más interno que contiene la línea. También cuentan:
   - las constantes de primer nivel, como `export const loginRoute = compose([...])`;
   - los callbacks anónimos pasados a una llamada, nombrados por esa llamada (`test("…")`), solo si no hay una función con nombre que los contenga. No tienen llamadores propios ni se expanden.

   Lo que no está dentro de ninguno se agrupa como "(nivel de módulo)". Si ese grupo no tiene llamadas (un `import` o un tipo), se omite.
3. **Por cada símbolo cambiado:**
   - **Llama a** (hacia abajo): las llamadas (`f()`, `obj.m()`, `new C()`) que aparecen en las líneas cambiadas y cuya definición está en el repo. Excluye librerías, `node_modules`, parámetros y variables locales de la propia función. Para cada una muestra:
     - archivo:línea de la definición;
     - la firma y el cuerpo, con tope de 40 líneas;
     - la marca "también cambió" si la definición está dentro del diff.
   - **Se llama desde** (hacia arriba): las referencias al símbolo en el repo, sin la propia declaración ni los `import`. Para cada una muestra:
     - archivo:línea y la función que hace la llamada;
     - 2 líneas antes y 2 después, con la línea de la llamada resaltada.
4. **Expandir un nivel:** `GET /api/tasks/:id/context/symbol?file=&line=&col=` devuelve el mismo análisis para cualquier símbolo, con todo su cuerpo y no solo las líneas cambiadas. Así se sigue la cadena hacia arriba o hacia abajo cuanto haga falta, de a un paso.

## API

- `GET /api/tasks/:id/context` → `{ engine, symbols: ChangedSymbol[], truncated }`.
- `GET /api/tasks/:id/context/symbol?file=&line=&col=` → `{ symbol, callees, callers, precision }`.

Las rutas de archivo se validan contra el worktree, igual que en H9.

**Topes:** 30 símbolos, 15 llamadas y 20 referencias por símbolo, 2000 archivos analizados y 512 KB por archivo. Si se pasa alguno, `truncated: true` y la UI lo avisa.

## UI

- La pestaña **Diff** suma un selector **Diff | Contexto del cambio**.
- **Tarjeta por símbolo cambiado:**
  - `archivo:línea · nombre (tipo)`, rango de líneas cambiadas, M o A;
  - indicador del motor: "TypeScript (LSP)" o "aproximado";
  - secciones plegables **Llama a (n)** y **Se llama desde (n)**.
- **Cada ítem:**
  - código con números de línea y la línea relevante resaltada;
  - **↳ Expandir**: carga el contexto de ese símbolo anidado, hasta 4 niveles en pantalla;
  - **Abrir en Archivos**: salta a la pestaña Archivos con el archivo abierto en esa línea. El visor de archivos pasa a tener números de línea y resaltado.
- El contexto se recalcula cuando cambia el worktree (`worktree.changed`).

## Fuera de alcance

- Cliente LSP genérico para otros lenguajes (queda la interfaz).
- Jerarquía de llamadas completa de una vez: se expande de a un nivel.
- Tipos inferidos y hover.

## Verificación

- **Unit** (`tests/codeintel.test.ts`), sobre `demo-api` con el cambio de rate limiting aplicado:
  - en `src/routes/auth.ts`, la constante `loginRoute` **llama a** `compose`, definida en `src/http.ts`, con su cuerpo, y a `rateLimit`, marcada "también cambió";
  - `rateLimit` **se llama desde** `src/routes/auth.ts`;
  - en `rateLimit.ts`, `new HttpError(...)` resuelve a la clase en `src/http.ts`;
  - expandir `compose` muestra que la llama `auth.ts`;
  - el motor de texto encuentra una función Python y su llamada.
- **e2e** (sección H16): `/context` de una tarea implementada devuelve los símbolos esperados. Una ruta fuera del worktree en `/context/symbol` → 400.
- **Visual** (navegador): la tarjeta de `auth.ts` muestra `compose` con su cuerpo, y "Abrir en Archivos" salta a la línea.
