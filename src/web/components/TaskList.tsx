import { useState } from "react";
import { api } from "../api";
import { run, selectTask, setState, useStore } from "../store";
import type { Task } from "../../shared/types";

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
          <span className={`badge ${t.phase === "done" ? "done" : t.status}`}>{t.phase === "done" ? "done" : t.status}</span>
          <span className="badge">{t.phase}</span>
        </div>
      ))}
      {modal && <NewTaskModal onClose={() => setModal(false)} />}
    </aside>
  );
}

export function NewTaskModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [repoPath, setRepoPath] = useState(localStorage.getItem("flockline.repo") ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const task = await api<Task>("/api/tasks", { body: { title, description, repoPath } });
      localStorage.setItem("flockline.repo", repoPath);
      onClose();
      await selectTask(task.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="box">
        <h3 style={{ margin: "0 0 6px" }}>Nueva tarea</h3>
        <label>Título</label>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Agregar rate limiting por IP al endpoint /login" />
        <label>Descripción</label>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        <label>Ruta del repo (local)</label>
        <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="~/.flockline/demo-api" />
        {err && <p style={{ color: "var(--err)", margin: "8px 0 0" }}>{err}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={onClose}>Cancelar</button>
          <button className="pri" disabled={busy || !title.trim() || !repoPath.trim()} onClick={submit}>
            {busy ? "Creando…" : "Crear"}
          </button>
        </div>
      </div>
    </div>
  );
}
