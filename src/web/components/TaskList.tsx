import { useEffect, useState } from "react";
import { api } from "../api";
import { run, selectTask, setState, useStore } from "../store";
import { PHASE_DEFS, WORKFLOWS, type WorkflowId } from "../../shared/workflows";
import type { Task, Ticket } from "../../shared/types";

export function TaskList() {
  const tasks = useStore((s) => s.tasks);
  const activeId = useStore((s) => s.activeId);
  const modal = useStore((s) => s.newTaskOpen);
  const setModal = (open: boolean) => setState({ newTaskOpen: open });

  return (
    <aside className="left">
      <button className="pri" style={{ width: "100%" }} onClick={() => setModal(true)} data-testid="new-task">
        + Nueva tarea <kbd>N</kbd>
      </button>
      {tasks.length === 0 && <p className="empty">Sin tareas todavía</p>}
      {tasks.map((t) => (
        <div key={t.id} className={`task ${t.id === activeId ? "sel" : ""}`} onClick={() => run(selectTask(t.id))}>
          <div className="t">{t.title}</div>
          {t.ticket_key && <TicketChip task={t} />}
          <span className={`badge ${t.phase === "done" ? "done" : t.status}`}>{t.phase === "done" ? "done" : t.status}</span>
          <span className="badge">{t.phase === "done" || t.phase === "freeform" ? WORKFLOWS[t.workflow]?.label : PHASE_DEFS[t.phase]?.label ?? t.phase}</span>
          <span className="badge wf">{WORKFLOWS[t.workflow]?.label ?? t.workflow}</span>
        </div>
      ))}
      {modal && <NewTaskModal onClose={() => setModal(false)} />}
    </aside>
  );
}

/** Chip con la clave del ticket de origen (H15). Los links del mock son de ejemplo: se avisa antes de abrir. */
export function TicketChip({ task }: { task: Task }) {
  return (
    <span
      className="chip"
      title={`Ticket de ejemplo (mock): ${task.ticket_key}`}
      onClick={(e) => {
        e.stopPropagation();
        alert(`${task.ticket_key} es un ticket de ejemplo (mock), sin conexión a Jira.\nURL ficticia: ${task.ticket_url}`);
      }}
    >
      {task.ticket_key}
    </span>
  );
}

export function NewTaskModal({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState<"inline" | "jira">("inline");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [workflow, setWorkflow] = useState<WorkflowId>("rpi");
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [repoPath, setRepoPath] = useState(localStorage.getItem("flockline.repo") ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function pick(t: Ticket) {
    setTicket(t);
    setTitle(t.summary);
    setDescription(t.description);
    setWorkflow(t.suggestedWorkflow);
  }

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const body = { title, description, repoPath, workflow, ...(source === "jira" && ticket ? { ticketKey: ticket.key } : {}) };
      const task = await api<Task>("/api/tasks", { body });
      localStorage.setItem("flockline.repo", repoPath);
      onClose();
      await selectTask(task.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const wf = WORKFLOWS[workflow];
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="box" style={{ width: 520 }}>
        <h3 style={{ margin: "0 0 6px" }}>Nueva tarea</h3>
        <div className="seg" style={{ marginBottom: 6 }}>
          <button className={source === "inline" ? "on" : ""} onClick={() => setSource("inline")}>Escribirla</button>
          <button className={source === "jira" ? "on" : ""} onClick={() => setSource("jira")} data-testid="from-jira">Desde Jira</button>
        </div>
        {source === "jira" && <TicketPicker selected={ticket?.key ?? null} onPick={pick} />}
        <label>Título</label>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Agregar rate limiting por IP al endpoint /login" />
        <label>Descripción</label>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        <label>Flujo de trabajo</label>
        <select value={workflow} onChange={(e) => setWorkflow(e.target.value as WorkflowId)} data-testid="workflow">
          {Object.values(WORKFLOWS).map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
              {ticket?.suggestedWorkflow === w.id ? " (sugerido por el ticket)" : ""}
            </option>
          ))}
        </select>
        <div style={{ color: "var(--mut)", fontSize: 12, marginTop: 4 }}>
          {wf.description} {wf.phases.length > 0 && <>Fases: {wf.phases.map((p) => PHASE_DEFS[p].label).join(" → ")}.</>}
        </div>
        <label>Ruta del repo (local)</label>
        <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="~/.flockline/demo-api" />
        {err && <p style={{ color: "var(--err)", margin: "8px 0 0" }}>{err}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={onClose}>Cancelar</button>
          <button className="pri" disabled={busy || !title.trim() || !repoPath.trim() || (source === "jira" && !ticket)} onClick={submit}>
            {busy ? "Creando…" : "Crear"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TicketPicker({ selected, onPick }: { selected: string | null; onPick: (t: Ticket) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<Ticket[]>([]);
  useEffect(() => {
    const t = setTimeout(() => run(api<{ tickets: Ticket[] }>(`/api/tickets?q=${encodeURIComponent(q)}`).then((r) => setList(r.tickets))), 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="tickets" data-testid="ticket-picker">
      <div className="mock-note">Tickets de ejemplo (mock), sin conexión a Jira.</div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por clave o resumen (FLK-123, login…)" />
      {list.map((t) => (
        <div key={t.key} className={`ticket ${selected === t.key ? "sel" : ""}`} onClick={() => onPick(t)} data-key={t.key}>
          <b>{t.key}</b> <span className="badge">{t.type}</span> <span className="badge">{t.priority}</span>
          <div>{t.summary}</div>
        </div>
      ))}
      {list.length === 0 && <p className="empty" style={{ margin: 8 }}>Sin resultados</p>}
    </div>
  );
}
