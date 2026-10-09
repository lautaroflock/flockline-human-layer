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

/**
 * Markdown renderizado a HTML estático e inyectado por ref: así las marcas de comentarios (que mutan el DOM)
 * no entran en conflicto con la reconciliación de React. react-markdown no admite HTML crudo, por lo que es seguro.
 */
export function Markdown({ source, marks = [], onMouseUp }: { source: string; marks?: Mark[]; onMouseUp?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>), [source]);
  const key = JSON.stringify(marks);
  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = html;
    applyMarks(ref.current, marks);
  }, [html, key]);
  return <div ref={ref} onMouseUp={onMouseUp} data-testid="markdown" />;
}
