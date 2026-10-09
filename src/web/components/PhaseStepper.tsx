import { api } from "../api";
import { reloadDetail, run, useStore } from "../store";
import { PHASES, type PhaseName } from "../../shared/types";

const LABEL: Record<PhaseName, string> = { spec: "Spec", research: "Research", plan: "Plan", implement: "Implement" };

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
  const cur = task.phase === "done" ? null : task.phase;
  const live = detail.sessions.find((s) => s.status === "running");
  const post = (path: string) => run(api(path, { method: "POST" }).then(() => reloadDetail()));

  return (
    <div className="stepper" data-testid="stepper">
      {PHASES.map((p, i) => {
        const st = phaseStatus(task.phase, task.status, p);
        return (
          <span key={p} style={{ display: "contents" }}>
            {i > 0 && <span style={{ color: "var(--mut)" }}>→</span>}
            <div className={`step ${st} ${cur === p ? "active" : ""}`}>
              <span className="dot" />
              {i + 1}. {LABEL[p]} <small>{st}</small>
            </div>
          </span>
        );
      })}
      <div className="actions">
        <button className="pri" disabled={!cur || cur === "spec" || !(task.status === "idle" || task.status === "failed")} title={cur === "spec" ? "La spec se escribe a mano (pestaña Spec)" : undefined} onClick={() => post(`/api/tasks/${task.id}/phases/${cur}/run`)}>
          {task.status === "failed" ? "Reintentar" : "Ejecutar"} <kbd>Ctrl+↵</kbd>
        </button>
        <button className="ok" disabled={!cur || task.status !== "awaiting_review"} onClick={() => post(`/api/tasks/${task.id}/phases/${cur}/approve`)}>
          Aprobar como {me.name}
        </button>
        <button className="danger" disabled={!live} onClick={() => live && post(`/api/sessions/${live.id}/abort`)}>
          Abortar
        </button>
      </div>
    </div>
  );
}
