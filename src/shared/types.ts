// Tipos compartidos servidor/cliente. Las filas viajan tal cual salen de SQLite (snake_case).

export type PhaseName = "spec" | "research" | "plan" | "implement";
export type TaskPhase = PhaseName | "done";
export type TaskStatus = "idle" | "running" | "awaiting_review" | "failed" | "cancelled";
export type SessionStatus = "running" | "done" | "failed" | "aborted";
export type SessionKind = "run" | "revise";
export type CommentStatus = "open" | "sent" | "resolved";
export type EventType = "system" | "assistant_text" | "thinking" | "tool_use" | "tool_result" | "result" | "error";
export type Tab = "spec" | "research" | "plan" | "implement" | "files" | "diff";

export const PHASES: PhaseName[] = ["spec", "research", "plan", "implement"];
/** Fases donde corre el agente (la etapa Spec se escribe a mano). */
export const AGENT_PHASES: PhaseName[] = ["research", "plan", "implement"];

export interface User {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface Task {
  id: string;
  slug: string;
  title: string;
  description: string;
  repo_path: string;
  worktree_path: string | null;
  branch: string | null;
  base_branch: string | null;
  base_commit: string | null;
  phase: TaskPhase;
  status: TaskStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  task_id: string;
  phase: PhaseName;
  kind: SessionKind;
  sdk_session_id: string | null;
  status: SessionStatus;
  cost_usd: number | null;
  num_turns: number | null;
  started_by: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface AgentEventRow {
  id: number;
  session_id: string;
  type: EventType;
  payload: string; // JSON
  created_at: string;
}

export interface Artifact {
  id: string;
  task_id: string;
  phase: PhaseName;
  version: number;
  path: string;
  content: string;
  approved: number;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null; // null = lo generó el agente; si no, quién la editó a mano
  created_at: string;
}

export interface Comment {
  id: string;
  artifact_id: string;
  quote: string;
  body: string;
  status: CommentStatus;
  author_id: string;
  resolved_by: string | null;
  created_at: string;
  orphan?: boolean; // calculado: el texto citado ya no está en la última versión
}

export interface ActivityEntry {
  id: number;
  task_id: string;
  user_id: string;
  kind: string;
  payload: string | null;
  created_at: string;
}

export interface PresenceEntry {
  user_id: string;
  tab: Tab;
}

export interface TaskDetail {
  task: Task;
  sessions: Session[];
  artifacts: Artifact[];
  comments: Comment[];
  activity: ActivityEntry[];
  presence: PresenceEntry[];
}

export interface TreeEntry {
  path: string;
  status: "M" | "A" | null;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
}

export type ServerMessage =
  | { type: "task.updated"; taskId: string; task: Task }
  | { type: "tasks.changed" }
  | { type: "session.started"; taskId: string; session: Session }
  | { type: "session.event"; taskId: string; sessionId: string; event: AgentEventRow }
  | { type: "session.ended"; taskId: string; session: Session }
  | { type: "artifact.created"; taskId: string; artifact: Artifact }
  | { type: "artifact.updated"; taskId: string; artifact: Artifact }
  | { type: "comment.created"; taskId: string; comment: Comment }
  | { type: "comment.updated"; taskId: string; comment: Comment }
  | { type: "activity.added"; taskId: string; entry: ActivityEntry }
  | { type: "presence.changed"; taskId: string; presence: PresenceEntry[] }
  | { type: "worktree.changed"; taskId: string };

export type ClientMessage =
  | { type: "subscribe"; taskId: string }
  | { type: "unsubscribe"; taskId: string }
  | { type: "presence"; taskId: string; tab: Tab };
