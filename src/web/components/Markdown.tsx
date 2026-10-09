import { useLayoutEffect, useMemo, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface Mark {
  quote: string;
  color: string;
  title: string;
}

/** Envuelve en <mark> la primera aparición del texto citado dentro de un único nodo de texto. */
function applyMarks(root: HTMLElement, marks: Mark[]) {
  for (const m of marks) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue?.indexOf(m.quote) ?? -1;
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + m.quote.length);
      const el = document.createElement("mark");
      el.style.borderColor = m.color;
      el.title = m.title;
      range.surroundContents(el);
      break;
    }
  }
}

// ---- diagramas Mermaid (H14): la librería se carga solo si el documento tiene alguno ----
type MermaidApi = { initialize(c: object): void; render(id: string, code: string): Promise<{ svg: string }> };
let mermaidLoad: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  mermaidLoad ??= import("mermaid").then((m) => {
    const api = m.default as unknown as MermaidApi;
    // strict: sin HTML ni clics en las etiquetas; tema oscuro como la app
    api.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", fontFamily: "system-ui, sans-serif" });
    return api;
  });
  return mermaidLoad;
}
let diagramSeq = 0;

async function renderDiagrams(root: HTMLElement, isStale: () => boolean) {
  const blocks = [...root.querySelectorAll("pre > code.language-mermaid")] as HTMLElement[];
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid();
  for (const code of blocks) {
    if (isStale()) return;
    const pre = code.parentElement!;
    const source = code.textContent ?? "";
    const box = document.createElement("div");
    box.className = "diagram";
    try {
      const { svg } = await mermaid.render(`mmd-${++diagramSeq}`, source);
      if (isStale()) return;
      box.innerHTML = svg;
    } catch (e) {
      box.className = "diagram error";
      const warn = document.createElement("div");
      warn.textContent = `No se pudo dibujar el diagrama: ${e instanceof Error ? e.message.split("\n")[0] : e}`;
      const raw = document.createElement("pre");
      raw.textContent = source;
      box.append(warn, raw);
    }
    pre.replaceWith(box);
  }
}

/**
 * Markdown renderizado a HTML estático e inyectado por ref: así las marcas de comentarios (que mutan el DOM)
 * no entran en conflicto con la reconciliación de React. react-markdown no admite HTML crudo, por lo que es seguro.
 */
export function Markdown({ source, marks = [], onMouseUp }: { source: string; marks?: Mark[]; onMouseUp?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>), [source]);
  const key = JSON.stringify(marks);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let stale = false;
    el.innerHTML = html;
    applyMarks(el, marks);
    void renderDiagrams(el, () => stale);
    return () => {
      stale = true;
    };
  }, [html, key]);
  return <div ref={ref} onMouseUp={onMouseUp} data-testid="markdown" />;
}
