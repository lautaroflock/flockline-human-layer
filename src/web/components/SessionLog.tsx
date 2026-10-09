import { useEffect, useRef } from "react";
import { useStore } from "../store";
import type { AgentEventRow } from "../../shared/types";

const parse = (e: AgentEventRow) => JSON.parse(e.payload) as Record<string, any>;

function summarize(input: Record<string, any>): string {
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? "";
  return String(v).slice(0, 120);
}

export function SessionLog() {
  const detail = useStore((s) => s.detail);
  const events = useStore((s) => s.events);
  const end = useRef<HTMLDivElement>(null);
  const session = detail?.sessions[detail.sessions.length - 1];
  const rows = session ? events[session.id] ?? [] : [];

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [rows.length]);

  if (!session)
    return (
      <div className="log">
        <p className="empty">
          {detail?.task.phase === "spec" ? "La etapa Spec se escribe a mano: abrí la pestaña Spec, redactala y aprobala." : "Sin sesión activa. Ejecutá la fase."}
        </p>
      </div>
    );

  const results = new Map<string, Record<string, any>>();
  for (const e of rows) if (e.type === "tool_result") results.set(parse(e).tool_use_id, parse(e));

  return (
    <div className="log" data-testid="session-log">
      <div className="mut" style={{ color: "var(--mut)", fontSize: 12, marginBottom: 8 }}>
        Sesión {session.kind === "revise" ? "de revisión" : "de ejecución"} · {session.phase} · {session.status}
        {session.num_turns != null && ` · ${session.num_turns} turnos`}
        {session.cost_usd != null && ` · $${session.cost_usd.toFixed(2)}`}
      </div>
      {rows.map((e) => {
        const p = parse(e);
        if (e.type === "tool_result") return null; // se muestra dentro de su tool_use
        if (e.type === "tool_use") {
          const r = results.get(p.id);
          return (
            <div key={e.id} className="ev tool_use">
              <div className="h">tool · {p.name}</div>
              <details>
                <summary className="mono" style={r?.is_error ? { color: "var(--err)" } : undefined}>
                  {summarize(p.input ?? {})}
                  {!r && " …"}
                </summary>
                <div className="mono" style={{ color: r?.is_error ? "var(--err)" : "var(--mut)", marginTop: 4 }}>
                  {r ? String(r.content) : "ejecutando…"}
                </div>
              </details>
            </div>
          );
        }
        if (e.type === "thinking")
          return (
            <div key={e.id} className="ev thinking">
              <details>
                <summary>thinking</summary>
                {p.text}
              </details>
            </div>
          );
        if (e.type === "system") return null;
        const label = { assistant_text: "asistente", result: "resultado", error: "error" }[e.type as string] ?? e.type;
        const text = e.type === "result" ? `Fase terminada · ${p.num_turns} turnos${p.total_cost_usd ? ` · $${Number(p.total_cost_usd).toFixed(2)}` : ""}${p.mock ? " (mock)" : ""}` : p.text ?? p.message;
        return (
          <div key={e.id} className={`ev ${e.type}`}>
            <div className="h">{label}</div>
            {text}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}
