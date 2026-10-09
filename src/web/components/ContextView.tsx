import { useEffect, useState } from "react";
import { api } from "../api";
import { run, setState, setTab, useStore } from "../store";
import type { ChangeContext, ChangedSymbol, CodeRef, SymbolContext } from "../../shared/types";

const MAX_DEPTH = 4;

/** Abre el archivo en la pestaña Archivos, en esa línea. */
export const openInFiles = (path: string, line: number) => {
  setState({ fileJump: { path, line } });
  setTab("files");
};

/** Código con números de línea y líneas resaltadas. */
export function CodeSnippet({ code, start, highlight = [] }: { code: string; start: number; highlight?: number[] }) {
  return (
    <pre className="snippet">
      {code.split(/\r?\n/).map((l, i) => (
        <div key={i} className={highlight.includes(start + i) ? "hl" : ""}>
          <span className="ln">{start + i}</span>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

/**
 * Contexto del cambio (H16): por cada función tocada, qué llama (hacia abajo) y desde dónde se la llama (hacia arriba),
 * para revisar sin ir a un editor. Cada ítem se puede expandir un nivel más.
 */
export function ContextView() {
  const detail = useStore((s) => s.detail)!;
  const tick = useStore((s) => s.worktreeTick);
  const [ctx, setCtx] = useState<ChangeContext | null>(null);
  const t = detail.task;

  useEffect(() => {
    run(api<ChangeContext>(`/api/tasks/${t.id}/context`).then(setCtx));
  }, [t.id, t.status, t.phase, tick]);

  if (!ctx) return <p className="empty">Analizando el código…</p>;
  if (ctx.symbols.length === 0) return <p className="empty">No hay cambios de código para analizar todavía.</p>;
  return (
    <div data-testid="context-view">
      <div style={{ color: "var(--mut)", fontSize: 12, marginBottom: 8 }}>
        {ctx.symbols.length} símbolo(s) cambiado(s) · motor: {ctx.engine}
        {ctx.truncated && <span style={{ color: "var(--warn)" }}> · resultado recortado por tamaño</span>}
      </div>
      {ctx.symbols.map((s) => (
        <SymbolCard key={`${s.file}:${s.line}:${s.name}`} s={s} taskId={t.id} />
      ))}
    </div>
  );
}

const range = (ls: number[]) => (ls.length === 1 ? `${ls[0]}` : `${ls[0]}–${ls[ls.length - 1]}`);

function SymbolCard({ s, taskId }: { s: ChangedSymbol; taskId: string }) {
  return (
    <div className="ctx-card" data-testid="ctx-symbol">
      <div className="ctx-head">
        <span className={`st ${s.status}`}>{s.status}</span>
        <b>{s.name}</b> <span className="badge">{s.kind}</span>
        <a className="mono link" onClick={() => openInFiles(s.file, s.line)}>
          {s.file}:{s.line}
        </a>
        <span style={{ color: "var(--mut)", fontSize: 12 }}>líneas cambiadas {range(s.changedLines)}</span>
        <span className={`badge ${s.precision === "lsp" ? "wf" : ""}`} title={s.precision === "lsp" ? "Resuelto con el LanguageService de TypeScript (motor del LSP)" : "Búsqueda de texto: puede tener falsos positivos"}>
          {s.precision === "lsp" ? "TypeScript (LSP)" : "aproximado"}
        </span>
      </div>
      <RefSection title="Llama a" hint="lo que el código cambiado usa: así se ve qué hace sin abrir otro archivo" refs={s.callees} taskId={taskId} depth={1} open />
      <RefSection title="Se llama desde" hint="quién usa lo que cambió" refs={s.callers} taskId={taskId} depth={1} open={s.callers.length > 0} />
    </div>
  );
}

function RefSection({ title, hint, refs, taskId, depth, open }: { title: string; hint: string; refs: CodeRef[]; taskId: string; depth: number; open: boolean }) {
  return (
    <details className="ctx-sec" open={open}>
      <summary>
        {title} ({refs.length}) <span style={{ color: "var(--mut)", fontSize: 11 }}>— {hint}</span>
      </summary>
      {refs.length === 0 && <div style={{ color: "var(--mut)", fontSize: 12, padding: "4px 0" }}>Nada en el repositorio.</div>}
      {refs.map((r) => (
        <RefItem key={`${r.file}:${r.line}:${r.col}`} r={r} taskId={taskId} depth={depth} />
      ))}
    </details>
  );
}

function RefItem({ r, taskId, depth }: { r: CodeRef; taskId: string; depth: number }) {
  const [showCode, setShowCode] = useState(false);
  const [more, setMore] = useState<SymbolContext | null>(null);
  const [loading, setLoading] = useState(false);
  const signature = r.snippet.split("\n").find((l) => l.trim()) ?? "";

  async function expand() {
    if (!r.expand) return;
    if (more) return setMore(null);
    setLoading(true);
    const q = `file=${encodeURIComponent(r.expand.file)}&line=${r.expand.line}&col=${r.expand.col}`;
    await run(api<SymbolContext>(`/api/tasks/${taskId}/context/symbol?${q}`).then(setMore));
    setLoading(false);
  }

  return (
    <div className="ctx-ref">
      <div className="ctx-ref-head">
        <b>{r.name}</b> <span className="badge">{r.kind}</span>
        {r.changed && <span className="badge awaiting_review" title="Está dentro del diff de esta tarea">también cambió</span>}
        <a className="mono link" onClick={() => openInFiles(r.file, r.line)} title="Abrir en Archivos">
          {r.file}:{r.line}
        </a>
        <span style={{ flex: 1 }} />
        <button className="mini" onClick={() => setShowCode((v) => !v)}>{showCode ? "Ocultar código" : "Ver código"}</button>
        {r.expand && depth < MAX_DEPTH && (
          <button className="mini" onClick={expand} disabled={loading} title="Ver qué llama y quién llama a este símbolo">
            {more ? "Contraer" : loading ? "…" : "↳ Expandir"}
          </button>
        )}
      </div>
      {showCode ? <CodeSnippet code={r.snippet} start={r.snippetStart} highlight={r.highlight} /> : <div className="mono sig">{signature.trim()}</div>}
      {more && (
        <div className="ctx-nested">
          <RefSection title={`${more.symbol.name} llama a`} hint="un nivel más abajo" refs={more.callees} taskId={taskId} depth={depth + 1} open />
          <RefSection title={`${more.symbol.name} se llama desde`} hint="un nivel más arriba" refs={more.callers} taskId={taskId} depth={depth + 1} open />
        </div>
      )}
    </div>
  );
}
