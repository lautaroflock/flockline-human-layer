// Tipos compartidos servidor/cliente. Las filas viajan tal cual salen de SQLite (snake_case).

import type { PhaseName, WorkflowId } from "./workflows";
export type { PhaseName, WorkflowId } from "./workflows";
export type TaskPhase = PhaseName | "done";
export type TaskStatus = "idle" | "running" | "awaiting_review" | "failed" | "cancelled";
export type SessionStatus = "running" | "done" | "failed" | "aborted";
export type SessionKind = "run" | "revise";
export type CommentStatus = "open" | "sent" | "resolved";
export type EventType = "system" | "assistant_text" | "thinking" | "tool_use" | "tool_result" | "result" | "error";
export type Tab = PhaseName | "files" | "diff";
export type QuestionStatus = "open" | "answered" | "skipped";

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
  workflow: WorkflowId;
  project_id: string | null;
  ticket_source: string | null;
  ticket_key: string | null;
  ticket_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentMode = "real" | "mock";

/** Un repo abierto en Flockline (H17). Las tareas viven dentro de un proyecto. */
export interface Project {
  id: string;
  name: string;
  repo_path: string;
  agent_mode: AgentMode;
  archived: number;
  created_by: string | null;
  created_at: string;
  task_count?: number;
  active_count?: number;
}

export interface Question {
  id: string;
  task_id: string;
  artifact_id: string | null;
  idx: number;
  text: string;
  why: string;
  options: string; // JSON: string[]
  suggestion: string;
  answer: string | null;
  status: QuestionStatus;
  answered_by: string | null;
  answered_at: string | null;
}

/** Archivo extra versionado junto a un artefacto (mockups, H14). Sin contenido: se pide aparte. */
export interface ArtifactFileMeta {
  artifact_id: string;
  path: string;
  size: number;
}

export interface Ticket {
  key: string;
  type: "Story" | "Bug" | "Epic" | "Task";
  summary: string;
  description: string;
  acceptance: string[];
  priority: string;
  labels: string[];
  reporter: string;
  created: string;
  url: string;
  suggestedWorkflow: WorkflowId;
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
  questions: Question[];
  artifactFiles: ArtifactFileMeta[];
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
  | { type: "projects.changed" }
  | { type: "session.started"; taskId: string; session: Session }
  | { type: "session.event"; taskId: string; sessionId: string; event: AgentEventRow }
  | { type: "session.ended"; taskId: string; session: Session }
  | { type: "artifact.created"; taskId: string; artifact: Artifact }
  | { type: "artifact.updated"; taskId: string; artifact: Artifact }
  | { type: "comment.created"; taskId: string; comment: Comment }
  | { type: "comment.updated"; taskId: string; comment: Comment }
  | { type: "activity.added"; taskId: string; entry: ActivityEntry }
  | { type: "presence.changed"; taskId: string; presence: PresenceEntry[] }
  | { type: "worktree.changed"; taskId: string }
  | { type: "question.updated"; taskId: string; question: Question }
  | { type: "questions.changed"; taskId: string };

export type ClientMessage =
  | { type: "subscribe"; taskId: string }
  | { type: "unsubscribe"; taskId: string }
  | { type: "presence"; taskId: string; tab: Tab };

// ---- Contexto del cambio (H16) ----
export interface CodeLoc {
  file: string; // relativa al worktree, con "/"
  line: number; // 1-based
  col: number; // 1-based
}

/** Una definición (hacia abajo) o un lugar de llamada (hacia arriba), con su código. */
export interface CodeRef extends CodeLoc {
  name: string;
  kind: string;
  snippet: string;
  snippetStart: number; // línea de la primera línea del snippet
  highlight: number[]; // líneas a resaltar dentro del snippet
  changed: boolean; // cae dentro del diff de la tarea
  expand: CodeLoc | null; // dónde pedir el siguiente nivel (el nombre del símbolo)
}

export interface ChangedSymbol extends CodeLoc {
  name: string;
  kind: string;
  status: "M" | "A";
  changedLines: number[];
  precision: "lsp" | "text";
  callees: CodeRef[];
  callers: CodeRef[];
}

export interface ChangeContext {
  engine: string;
  symbols: ChangedSymbol[];
  truncated: boolean;
}

export interface SymbolContext {
  symbol: CodeRef;
  precision: "lsp" | "text";
  callees: CodeRef[];
  callers: CodeRef[];
}
