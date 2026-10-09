import { useEffect, useState } from "react";
import { html } from "diff2html";
import { ColorSchemeType } from "diff2html/lib/types";
import "diff2html/bundles/css/diff2html.min.css";
import { files } from "../api";
import { run, useStore } from "../store";
import { ContextView } from "./ContextView";
import { Markdown } from "./Markdown";

export function DiffView() {
  const detail = useStore((s) => s.detail)!;
  const tick = useStore((s) => s.worktreeTick);
  const [diff, setDiff] = useState<string | null>(null);
  const [mode, setMode] = useState<"diff" | "context">("diff");
  const summary = detail.artifacts.filter((a) => a.phase === "implement").sort((a, b) => b.version - a.version)[0];
  const t = detail.task;

  useEffect(() => {
    run(files.diff(t.id).then((r) => setDiff(r.diff)));
  }, [t.id, t.status, t.phase, tick]);

  if (diff === null) return <div className="doc"><p className="empty">Cargando diff…</p></div>;
  const empty = diff.trim() === "";
  return (
    <div className="doc" data-testid="diff-view">
      {summary && (
        <details open={mode === "diff"} style={{ marginBottom: 14 }}>
          <summary style={{ cursor: "pointer", color: "var(--mut)" }}>Resumen de la implementación</summary>
          <Markdown source={summary.content} />
        </details>
      )}
      {!empty && (
        <div className="seg" style={{ marginBottom: 10 }}>
          <button className={mode === "diff" ? "on" : ""} onClick={() => setMode("diff")}>Diff</button>
          <button className={mode === "context" ? "on" : ""} onClick={() => setMode("context")} data-testid="context-toggle">Contexto del cambio</button>
        </div>
      )}
      {empty ? (
        <p className="empty">Todavía no hay cambios de código. El diff aparece cuando Implement modifica archivos.</p>
      ) : mode === "context" ? (
        <ContextView />
      ) : (
        <div dangerouslySetInnerHTML={{ __html: html(diff, { drawFileList: true, matching: "lines", outputFormat: "side-by-side", colorScheme: ColorSchemeType.DARK }) }} />
      )}
    </div>
  );
}
