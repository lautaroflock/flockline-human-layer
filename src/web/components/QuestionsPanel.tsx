import { useState } from "react";
import { api } from "../api";
import { reloadDetail, run, useStore } from "../store";
import { userColor, userName } from "./CommentLayer";
import type { Question } from "../../shared/types";

/** Fase Questions (H13): el agente pregunta, las personas responden. No se aprueba con preguntas abiertas. */
export function QuestionsPanel() {
  const detail = useStore((s) => s.detail)!;
  const me = useStore((s) => s.user)!;
  const { task } = detail;
  const editable = task.phase === "questions" && task.status === "awaiting_review";
  const qs = detail.questions;
  const answered = qs.filter((q) => q.status !== "open").length;

  return (
    <div className="log" data-testid="questions">
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <b>Preguntas del agente</b>
        <span className="badge">{answered}/{qs.length} respondidas</span>
        <span style={{ flex: 1 }} />
        {editable && (
          <button onClick={() => run(api(`/api/tasks/${task.id}/phases/questions/revise`, { method: "POST" }).then(() => reloadDetail()))} data-testid="more-questions">
            Pedir más preguntas
          </button>
        )}
      </div>
      {qs.length === 0 && <p className="empty">Todavía no hay preguntas. Ejecutá la fase.</p>}
      {qs.map((q) => (
        <QuestionCard key={q.id} q={q} editable={editable} me={me.name} />
      ))}
      {editable && answered === qs.length && qs.length > 0 && <p style={{ color: "var(--ok)" }}>Todas respondidas: ya se puede aprobar.</p>}
    </div>
  );
}

function QuestionCard({ q, editable, me }: { q: Question; editable: boolean; me: string }) {
  const users = useStore((s) => s.users);
  const [text, setText] = useState("");
  const [changing, setChanging] = useState(false);
  const options = JSON.parse(q.options) as string[];
  const patch = (body: object) => run(api(`/api/questions/${q.id}`, { method: "PATCH", body }).then(() => (setText(""), setChanging(false))));
  const open = q.status === "open" || changing;

  return (
    <div className={`qcard ${q.status}`} data-testid={`question-${q.idx}`}>
      <div className="qtext">
        {q.idx}. {q.text}
      </div>
      {q.why && <div className="qwhy">Por qué importa: {q.why}</div>}
      {!open ? (
        <div className="qanswer">
          {q.status === "skipped" ? <i>No aplica</i> : q.answer}
          <span style={{ color: userColor(users, q.answered_by ?? ""), fontSize: 12 }}> · {userName(users, q.answered_by ?? "")}</span>
          {editable && (
            <button className="mini" onClick={() => setChanging(true)} title="Cambiar la respuesta">✎</button>
          )}
        </div>
      ) : editable ? (
        <>
          {options.length > 0 && (
            <div className="qopts">
              {options.map((o) => (
                <button key={o} onClick={() => patch({ answer: o })}>{o}</button>
              ))}
            </div>
          )}
          <div className="composer">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && patch({ answer: text })} placeholder={`Tu respuesta (como ${me})`} />
            <button className="pri" disabled={!text.trim()} onClick={() => patch({ answer: text })}>Responder</button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {q.suggestion && (
              <button onClick={() => patch({ useSuggestion: true })} title={q.suggestion}>Usar sugerencia</button>
            )}
            <button onClick={() => patch({ status: "skipped" })}>No aplica</button>
            {changing && <button onClick={() => setChanging(false)}>Cancelar</button>}
            {q.suggestion && <span style={{ color: "var(--mut)", fontSize: 12 }}>Sugerencia: {q.suggestion}</span>}
          </div>
        </>
      ) : (
        <div className="qanswer"><i>Sin responder</i></div>
      )}
    </div>
  );
}
