import { api } from "../api";
import { reloadDetail, run, useStore } from "../store";
import { PHASES, type PhaseName } from "../../shared/types";

export const LABEL: Record<PhaseName, string> = { spec: "Spec", research: "Research", plan: "Plan", implement: "Implement" };

export function phaseStatus(taskPhase: string, status: string, p: PhaseName): string {
  const cur = PHASES.indexOf(taskPhase as PhaseName);
  const idx = PHASES.indexOf(p);
  if (taskPhase === "done" || idx < cur) return "approved";
  if (idx > cur) return "idle";
  return status;
}

export function PhaseStepper() {
  const detail = useStore((s) => s.detail);
  const me = useStore((s) => s.user);
  if (!detail || !me) return null;
  const { task } = detail;
  const cancelled = task.status === "cancelled";
  const cur = task.phase === "done" || cancelled ? null : task.phase;
  const live = detail.sessions.find((s) => s.status === "running");
  const post = (path: string, body?: unknown) => run(api(path, { method: "POST", body }).then(() => reloadDetail()));

  // Retroceder: a una fase aprobada (vuelve el worktree al commit de esa fase) o rehacer la actual (descarta su resultado)
  function rewind(p: PhaseName) {
    const redo = p === task.phase;
    const msg = redo
      ? `¿Rehacer ${LABEL[p]}? Se descarta lo que produjo (cambios sin aprobar del worktree) y queda lista para ejecutarse de nuevo.`
      : `¿Volver a ${LABEL[p]}? El worktree vuelve al estado en que se aprobó ${LABEL[p]}: se descartan el código y los artefactos de las fases siguientes. Las versiones anteriores quedan en el historial.`;
    if (confirm(msg)) post(`/api/tasks/${task.id}/rewind`, { to: p });
  }

  return (
    <div className="stepper" data-testid="stepper">
      {PHASES.map((p, i) => {
        const st = cancelled && p === task.phase ? "cancelled" : phaseStatus(task.phase, task.status, p);
        const canBack = !live && (st === "approved" || (p === task.phase && p !== "spec" && (task.status === "awaiting_review" || task.status === "failed")));
        return (
          <span key={p} style={{ display: "contents" }}>
            {i > 0 && <span style={{ color: "var(--mut)" }}>→</span>}
            <div className={`step ${st} ${cur === p ? "active" : ""}`}>
              <span className="dot" />
              {i + 1}. {LABEL[p]} <small>{st}</small>
              {canBack && (
                <button className="mini" title={p === task.phase ? `Rehacer ${LABEL[p]}` : `Volver a ${LABEL[p]}`} onClick={() => rewind(p)} data-testid={`rewind-${p}`}>
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
            <button className="pri" disabled={!cur || cur === "spec" || !(task.status === "idle" || task.status === "failed")} title={cur === "spec" ? "La spec se escribe a mano (pestaña Spec)" : undefined} onClick={() => post(`/api/tasks/${task.id}/phases/${cur}/run`)}>
              {task.status === "failed" ? "Reintentar" : "Ejecutar"} <kbd>Ctrl+↵</kbd>
            </button>
            <button className="ok" disabled={!cur || task.status !== "awaiting_review"} onClick={() => post(`/api/tasks/${task.id}/phases/${cur}/approve`)}>
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
