import { useSyncExternalStore } from "react";
import type { AgentEventRow, ServerMessage, Tab, Task, TaskDetail, User } from "../shared/types";
import { api, getToken, TOKEN_KEY } from "./api";

export type UserInfo = User & { online?: boolean };

export interface State {
  user: User | null;
  users: UserInfo[];
  tasks: Task[];
  activeId: string | null;
  detail: TaskDetail | null;
  events: Record<string, AgentEventRow[]>;
  tab: Tab;
  version: Record<string, number>; // versión elegida por fase (research|plan)
  wsOk: boolean;
  error: string | null;
  worktreeTick: number; // sube con worktree.changed para refrescar el árbol
  draft: { phase: string; quote: string } | null; // texto seleccionado esperando comentario
  newTaskOpen: boolean;
}

let state: State = { user: null, users: [], tasks: [], activeId: null, detail: null, events: {}, tab: "research", version: {}, wsOk: false, error: null, worktreeTick: 0, draft: null, newTaskOpen: false };
const listeners = new Set<() => void>();

export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export const useStore = <T,>(sel: (s: State) => T): T => useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => sel(state));

let errTimer: ReturnType<typeof setTimeout> | undefined;
export function showError(e: unknown) {
  setState({ error: e instanceof Error ? e.message : String(e) });
  clearTimeout(errTimer);
  errTimer = setTimeout(() => setState({ error: null }), 4500);
}
export const run = <T,>(p: Promise<T>) => p.catch((e) => (showError(e), undefined));

export async function login(name: string) {
  const { user, token } = await api<{ user: User; token: string }>("/api/session", { body: { name } });
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
  setState({ user });
  await boot();
}

export function logout() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
  location.reload();
}

export async function loadTasks() {
  setState({ tasks: await api<Task[]>("/api/tasks") });
}
export async function loadUsers() {
  setState({ users: await api<UserInfo[]>("/api/users") });
}

export async function loadEvents(sessionId: string) {
  const rows = await api<AgentEventRow[]>(`/api/sessions/${sessionId}/events`);
  setState((s) => ({ events: { ...s.events, [sessionId]: rows } }));
}

export async function reloadDetail() {
  const id = state.activeId;
  if (!id) return;
  const detail = await api<TaskDetail>(`/api/tasks/${id}`);
  setState({ detail });
  const last = detail.sessions[detail.sessions.length - 1];
  if (last) await loadEvents(last.id);
}

export async function selectTask(id: string | null) {
  const prev = state.activeId;
  if (prev && prev !== id) sendWs({ type: "unsubscribe", taskId: prev });
  setState({ activeId: id, detail: null, version: {}, tab: "research", draft: null });
  history.replaceState(null, "", id ? `?task=${id}` : location.pathname);
  if (!id) return;
  sendWs({ type: "subscribe", taskId: id });
  await run(reloadDetail());
  const d = state.detail;
  if (d) setTab(d.task.phase === "plan" ? "plan" : d.task.phase === "implement" ? "diff" : "research");
}

export function setTab(tab: Tab) {
  setState({ tab });
  if (state.activeId) sendWs({ type: "presence", taskId: state.activeId, tab });
}

// ---- WebSocket ----
let ws: WebSocket | null = null;
let retry = 0;
const outbox: string[] = [];
export function sendWs(msg: object) {
  const raw = JSON.stringify(msg);
  if (ws?.readyState === WebSocket.OPEN) ws.send(raw);
  else outbox.push(raw);
}

export function connectWs() {
  const token = getToken();
  if (!token) return;
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    const reconnect = retry > 0;
    retry = 0;
    setState({ wsOk: true });
    if (state.activeId) ws!.send(JSON.stringify({ type: "subscribe", taskId: state.activeId }));
    for (const m of outbox.splice(0)) ws!.send(m);
    if (reconnect) run(Promise.all([loadTasks(), loadUsers(), reloadDetail()])); // §7: al reconectar, recargar la tarea activa
  };
  ws.onmessage = (e) => applyMessage(JSON.parse(e.data) as ServerMessage);
  ws.onclose = () => {
    setState({ wsOk: false });
    setTimeout(connectWs, Math.min(1000 * 2 ** retry++, 8000));
  };
}

function upsert<T extends { id: string }>(list: T[], item: T) {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];
}

function applyMessage(m: ServerMessage) {
  if (m.type === "tasks.changed") {
    run(Promise.all([loadTasks(), loadUsers()]));
    return;
  }
  setState((s) => {
    const d = s.detail && "taskId" in m && s.detail.task.id === m.taskId ? s.detail : null;
    switch (m.type) {
      case "task.updated":
        return { tasks: upsert(s.tasks, m.task), ...(d ? { detail: { ...d, task: m.task } } : {}) };
      case "session.started":
        return d ? { detail: { ...d, sessions: upsert(d.sessions, m.session) }, events: { ...s.events, [m.session.id]: [] } } : {};
      case "session.ended":
        return d ? { detail: { ...d, sessions: upsert(d.sessions, m.session) } } : {};
      case "session.event": {
        const cur = s.events[m.sessionId] ?? [];
        return cur.some((x) => x.id === m.event.id) ? {} : { events: { ...s.events, [m.sessionId]: [...cur, m.event] } };
      }
      case "artifact.created": {
        if (!d) return {};
        const next = { detail: { ...d, artifacts: upsert(d.artifacts, m.artifact) }, version: { ...s.version } as Record<string, number> };
        delete next.version[m.artifact.phase]; // seguir la última versión
        return next;
      }
      case "artifact.updated":
        return d ? { detail: { ...d, artifacts: upsert(d.artifacts, m.artifact) } } : {};
      case "comment.created":
      case "comment.updated":
        return d ? { detail: { ...d, comments: upsert(d.comments, m.comment) } } : {};
      case "activity.added":
        return d && !d.activity.some((a) => a.id === m.entry.id) ? { detail: { ...d, activity: [m.entry, ...d.activity].slice(0, 30) } } : {};
      case "presence.changed":
        return d ? { detail: { ...d, presence: m.presence } } : {};
      case "worktree.changed":
        return d ? { worktreeTick: s.worktreeTick + 1 } : {};
      default:
        return {};
    }
  });
  // Los comentarios huérfanos se recalculan en el servidor al crear una versión nueva.
  if (m.type === "artifact.created" && state.detail?.task.id === m.taskId) {
    run(reloadDetail());
    if (m.artifact.phase !== "implement" && state.tab !== m.artifact.phase) setTab(m.artifact.phase); // seguir al artefacto nuevo
  }
}

export async function boot() {
  const token = getToken();
  if (!token) return;
  try {
    const { user } = await api<{ user: User }>("/api/me");
    setState({ user });
  } catch {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {}
    return;
  }
  connectWs();
  await Promise.all([loadTasks(), loadUsers()]);
  const id = new URLSearchParams(location.search).get("task");
  if (id) await selectTask(id);
}

// ---- atajos de teclado (§7) ----
export const TAB_ORDER: Tab[] = ["research", "plan", "files", "diff"];

export function cycleTab() {
  const i = TAB_ORDER.indexOf(state.tab);
  setTab(TAB_ORDER[(i + 1) % TAB_ORDER.length]!);
}

export function cycleTask(dir: 1 | -1) {
  const { tasks, activeId } = state;
  if (tasks.length === 0) return;
  const i = tasks.findIndex((t) => t.id === activeId);
  const next = tasks[(i + dir + tasks.length) % tasks.length]!;
  run(selectTask(next.id));
}

/** Ctrl+Enter: ejecuta la fase activa o, si está en revisión, la aprueba. */
export function primaryAction() {
  const d = state.detail;
  if (!d || d.task.phase === "done") return;
  const { task } = d;
  const verb = task.status === "idle" || task.status === "failed" ? "run" : task.status === "awaiting_review" ? "approve" : null;
  if (verb) run(api(`/api/tasks/${task.id}/phases/${task.phase}/${verb}`, { method: "POST" }).then(() => reloadDetail()));
}
