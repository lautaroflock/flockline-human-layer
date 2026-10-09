import { useState } from "react";
import { api } from "../api";
import { reloadDetail, run, useStore } from "../store";
import { PHASE_DEFS, phasesOf, WORKFLOWS, type PhaseName } from "../../shared/workflows";
import { AgentBadge } from "./Projects";

export const LABEL = (p: PhaseName) => PHASE_DEFS[p].label;

export function phaseStatus(flow: PhaseName[], taskPhase: string, status: string, p: PhaseName): string {
  const cur = flow.indexOf(taskPhase as PhaseName);
  const idx = flow.indexOf(p);
  if (taskPhase === "done" || idx < cur) return "approved";
  if (idx > cur) return "idle";
  return status;
}

export function PhaseStepper() {
  const detail = useStore((s) => s.detail);
  const me = useStore((s) => s.user);
  if (!detail || !me) return null;
  const { task } = detail;
  if (task.workflow === "freeform") return <FreeformBar />;

  const flow = phasesOf(task.workflow);
  const cancelled = task.status === "cancelled";
  const cur = task.phase === "done" || cancelled ? null : (task.phase as PhaseName);
  const def = cur ? PHASE_DEFS[cur] : null;
  const live = detail.sessions.find((s) => s.status === "running");
  const openQuestions = detail.questions.filter((q) => q.status === "open").length;
  const post = (path: string, body?: unknown) => run(api(path, { method: "POST", body }).then(() => reloadDetail()));

  // Retroceder: a una fase aprobada (vuelve el worktree al commit de esa fase) o rehacer la actual (descarta su resultado)
  function rewind(p: PhaseName) {
    const redo = p === task.phase;
    const msg = redo
      ? `¿Rehacer ${LABEL(p)}? Se descarta lo que produjo (cambios sin aprobar del worktree) y queda lista para ejecutarse de nuevo.`
      : `¿Volver a ${LABEL(p)}? El worktree vuelve al estado en que se aprobó ${LABEL(p)}: se descartan el código y los artefactos de las fases siguientes. Las versiones anteriores quedan en el historial.`;
    if (confirm(msg)) post(`/api/tasks/${task.id}/rewind`, { to: p });
  }

  const blockedByQuestions = def?.kind === "questions" && openQuestions > 0;

  return (
    <div className="stepper" data-testid="stepper">
      <AgentBadge />
      <span className="badge wf" title={WORKFLOWS[task.workflow].description}>{WORKFLOWS[task.workflow].label}</span>
      {flow.map((p, i) => {
        const st = cancelled && p === task.phase ? "cancelled" : phaseStatus(flow, task.phase, task.status, p);
        const manual = PHASE_DEFS[p].kind === "manual";
        const canBack = !live && (st === "approved" || (p === task.phase && !manual && (task.status === "awaiting_review" || task.status === "failed")));
        return (
          <span key={p} style={{ display: "contents" }}>
            {i > 0 && <span style={{ color: "var(--mut)" }}>→</span>}
            <div className={`step ${st} ${cur === p ? "active" : ""}`} title={PHASE_DEFS[p].description}>
              <span className="dot" />
              {i + 1}. {LABEL(p)} <small>{st}</small>
              {p === "questions" && detail.questions.length > 0 && (
                <small>· {detail.questions.length - openQuestions}/{detail.questions.length}</small>
              )}
              {canBack && (
                <button className="mini" title={p === task.phase ? `Rehacer ${LABEL(p)}` : `Volver a ${LABEL(p)}`} onClick={() => rewind(p)} data-testid={`rewind-${p}`}>
                  {p === task.phase ? "↺" : "↩"}
                </button>
              )}
            </div>
          </span>
        );
      })}
      <div className="actions">
        {cancelled ? (
          <button className="pri" onClick={() => post(`/api/tasks/${task.id}/reopen`)} data-testid="reopen">Reabrir tarea</button>
        ) : (
          <>
            <button
              className="pri"
              disabled={!cur || def?.kind === "manual" || !(task.status === "idle" || task.status === "failed")}
              title={def?.kind === "manual" ? `${def.label} se escribe a mano (pestaña ${def.label})` : undefined}
              onClick={() => post(`/api/tasks/${task.id}/phases/${cur}/run`)}
            >
              {task.status === "failed" ? "Reintentar" : "Ejecutar"} <kbd>Ctrl+↵</kbd>
            </button>
            <button
              className="ok"
              disabled={!cur || task.status !== "awaiting_review" || blockedByQuestions}
              title={blockedByQuestions ? `Quedan ${openQuestions} pregunta(s) sin responder` : undefined}
              onClick={() => post(`/api/tasks/${task.id}/phases/${cur}/approve`)}
            >
              Aprobar como {me.name}
            </button>
            <button className="danger" disabled={!live} onClick={() => live && post(`/api/sessions/${live.id}/abort`)} title="Corta la sesión del agente en curso">
              Abortar sesión
            </button>
            {task.phase !== "done" && (
              <button
                className="danger"
                onClick={() => confirm("¿Cancelar la tarea? Se corta la sesión en curso y no se podrá ejecutar ni aprobar hasta reabrirla. El worktree y el historial se conservan.") && post(`/api/tasks/${task.id}/cancel`)}
                data-testid="cancel-task"
              >
                Cancelar tarea
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Freeform: sin fases. Un pedido libre por sesión, sobre el mismo worktree. */
function FreeformBar() {
  const detail = useStore((s) => s.detail)!;
  const me = useStore((s) => s.user)!;
  const [prompt, setPrompt] = useState("");
  const { task } = detail;
  const live = detail.sessions.find((s) => s.status === "running");
  const closed = task.phase === "done";
  const cancelled = task.status === "cancelled";
  const post = (path: string, body?: unknown) => run(api(path, { method: "POST", body }).then(() => reloadDetail()));

  async function send() {
    if (!prompt.trim()) return;
    await post(`/api/tasks/${task.id}/sessions`, { prompt });
    setPrompt("");
  }

  return (
    <div className="stepper" data-testid="freeform">
      <AgentBadge />
      <span className="badge wf" title={WORKFLOWS.freeform.description}>Freeform</span>
      <span style={{ color: "var(--mut)", fontSize: 12 }}>
        {detail.sessions.length} sesión(es){closed ? " · cerrada" : cancelled ? " · cancelada" : ""}
      </span>
      {!closed && !cancelled && (
        <div style={{ display: "flex", gap: 8, width: "100%" }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !live && send()}
            placeholder={live ? "Hay una sesión en curso…" : `Pedido para el agente (como ${me.name})`}
            disabled={!!live}
            data-testid="free-prompt"
          />
          <button className="pri" disabled={!!live || !prompt.trim()} onClick={send}>Nueva sesión</button>
        </div>
      )}
      <div className="actions">
        {cancelled ? (
          <button className="pri" onClick={() => post(`/api/tasks/${task.id}/reopen`)}>Reabrir tarea</button>
        ) : (
          !closed && (
            <>
              <button className="danger" disabled={!live} onClick={() => live && post(`/api/sessions/${live.id}/abort`)}>Abortar sesión</button>
              <button className="ok" disabled={!!live} onClick={() => confirm("¿Cerrar la tarea? Se commitea lo que haya en el worktree.") && post(`/api/tasks/${task.id}/close`)}>Cerrar tarea</button>
              <button className="danger" onClick={() => confirm("¿Cancelar la tarea?") && post(`/api/tasks/${task.id}/cancel`)}>Cancelar</button>
            </>
          )
        )}
      </div>
    </div>
  );
}
