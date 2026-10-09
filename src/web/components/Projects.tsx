import { useState } from "react";
import { api } from "../api";
import { loadProjects, run, setProject, useStore } from "../store";
import type { Project } from "../../shared/types";

/** Proyectos abiertos (H17): elegir uno filtra las tareas; "Todos" muestra todas. */
export function ProjectBar() {
  const projects = useStore((s) => s.projects);
  const current = useStore((s) => s.projectId);
  const [open, setOpen] = useState(false);
  const total = projects.reduce((n, p) => n + (p.task_count ?? 0), 0);

  async function close(p: Project) {
    if (!confirm(`¿Cerrar el proyecto ${p.name}? Sus tareas y worktrees se conservan; se vuelve a abrir con la misma ruta.`)) return;
    await run(api(`/api/projects/${p.id}`, { method: "PATCH", body: { archived: true } }).then(() => (current === p.id && setProject(null), loadProjects())));
  }
  async function toggleMode(p: Project) {
    const next = p.agent_mode === "real" ? "mock" : "real";
    const msg = next === "real" ? `¿Usar el agente real (Claude) en ${p.name}? Las sesiones gastan tokens, con tope por fase.` : `¿Pasar ${p.name} al agente mock? Solo sirve para la demo: no investiga ni implementa de verdad.`;
    if (confirm(msg)) await run(api(`/api/projects/${p.id}`, { method: "PATCH", body: { agentMode: next } }).then(loadProjects));
  }

  return (
    <div className="projects" data-testid="projects">
      <div className="proj-head">
        <b>Proyectos</b>
        <button className="mini" onClick={() => setOpen(true)} data-testid="open-project">+ Abrir</button>
      </div>
      <div className={`proj ${current === null ? "sel" : ""}`} onClick={() => setProject(null)}>
        <span>Todos</span>
        <small>{total}</small>
      </div>
      {projects.map((p) => (
        <div key={p.id} className={`proj ${current === p.id ? "sel" : ""}`} onClick={() => setProject(p.id)} title={p.repo_path} data-project={p.name}>
          <span className="pname">{p.name}</span>
          <span
            className={`badge ${p.agent_mode === "real" ? "wf" : ""}`}
            onClick={(e) => (e.stopPropagation(), toggleMode(p))}
            title={p.agent_mode === "real" ? "Agente real (Claude Agent SDK). Clic para cambiar." : "Agente mock (demo). Clic para cambiar."}
          >
            {p.agent_mode === "real" ? "Claude" : "mock"}
          </span>
          <small>{p.active_count ?? 0}/{p.task_count ?? 0}</small>
          <button className="mini x" onClick={(e) => (e.stopPropagation(), close(p))} title="Cerrar proyecto">×</button>
        </div>
      ))}
      {projects.length === 0 && <p className="empty" style={{ margin: "8px 0" }}>Abrí un repo para empezar</p>}
      {open && <OpenProjectModal onClose={() => setOpen(false)} />}
    </div>
  );
}

export function OpenProjectModal({ onClose }: { onClose: () => void }) {
  const [repoPath, setRepoPath] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"real" | "mock">("real");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const p = await api<Project>("/api/projects", { body: { repoPath, name: name || undefined, agentMode: mode } });
      await loadProjects();
      setProject(p.id);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="box">
        <h3 style={{ margin: "0 0 6px" }}>Abrir proyecto</h3>
        <label>Ruta del repo git (local)</label>
        <input autoFocus value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="C:\ruta\a\mi-repo  o  ~/repos/mi-repo" data-testid="project-path" />
        <label>Nombre (opcional)</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="por defecto, el nombre de la carpeta" />
        <label>Agente</label>
        <div className="seg">
          <button className={mode === "real" ? "on" : ""} onClick={() => setMode("real")}>Claude (real)</button>
          <button className={mode === "mock" ? "on" : ""} onClick={() => setMode("mock")}>Mock (demo)</button>
        </div>
        <div style={{ color: "var(--mut)", fontSize: 12, marginTop: 4 }}>
          {mode === "real"
            ? "Investiga, planifica e implementa de verdad con el Claude Agent SDK, en un worktree aislado. Gasta tokens, con tope por fase."
            : "Guion fijo pensado para el repo de demo (demo-api). En otros repos no hace el trabajo real."}
        </div>
        {err && <p style={{ color: "var(--err)", margin: "8px 0 0" }}>{err}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={onClose}>Cancelar</button>
          <button className="pri" disabled={busy || !repoPath.trim()} onClick={submit} data-testid="open-project-submit">
            {busy ? "Abriendo…" : "Abrir"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Insignia del agente de la tarea activa (según su proyecto). */
export function AgentBadge() {
  const detail = useStore((s) => s.detail);
  const projects = useStore((s) => s.projects);
  const p = projects.find((x) => x.id === detail?.task.project_id);
  if (!p) return null;
  return (
    <span className={`badge ${p.agent_mode === "real" ? "wf" : ""}`} title={`Proyecto ${p.name} · ${p.repo_path}`}>
      {p.name} · {p.agent_mode === "real" ? "Agente: Claude (real)" : "Agente: mock"}
    </span>
  );
}

