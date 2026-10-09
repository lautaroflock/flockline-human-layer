import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import type { ActivityEntry, AgentEventRow, Artifact, Comment, PhaseName, Session, Task, User } from "../shared/types";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

// Migraciones versionadas con PRAGMA user_version. Incluyen las tablas del §4 y la extensión del §11.2.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    worktree_path TEXT,
    branch TEXT,
    base_branch TEXT,
    base_commit TEXT,
    phase TEXT NOT NULL DEFAULT 'research',
    status TEXT NOT NULL DEFAULT 'idle',
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    phase TEXT NOT NULL,
    kind TEXT NOT NULL,
    sdk_session_id TEXT,
    status TEXT NOT NULL,
    cost_usd REAL,
    num_turns INTEGER,
    started_by TEXT REFERENCES users(id),
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    phase TEXT NOT NULL,
    version INTEGER NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 0,
    approved_by TEXT REFERENCES users(id),
    approved_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(task_id, phase, version)
  );
  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    quote TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    author_id TEXT NOT NULL REFERENCES users(id),
    resolved_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_events_session ON events(session_id, id);
  CREATE INDEX idx_artifacts_task ON artifacts(task_id, phase, version);
  CREATE INDEX idx_activity_task ON activity(task_id, id);
  `,
  // v2: autor de cada versión (edición manual, etapa Spec)
  `ALTER TABLE artifacts ADD COLUMN created_by TEXT REFERENCES users(id);`,
];

function migrate() {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}
migrate();

export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();

const COLORS = ["#6ea8fe", "#f5a3c7", "#e5b454", "#4cc38a", "#b48cf5", "#ef8f6b", "#5fd0d0"];

export const users = {
  byId: (id: string) => db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null,
  byName: (name: string) => db.query("SELECT * FROM users WHERE name = ? COLLATE NOCASE").get(name) as User | null,
  all: () => db.query("SELECT * FROM users ORDER BY created_at").all() as User[],
  create(name: string): User {
    const n = (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    const user: User = { id: uuid(), name, color: COLORS[n % COLORS.length]!, created_at: now() };
    db.query("INSERT INTO users (id, name, color, created_at) VALUES (?, ?, ?, ?)").run(user.id, user.name, user.color, user.created_at);
    return user;
  },
};

export const tasks = {
  byId: (id: string) => db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Task | null,
  all: () => db.query("SELECT * FROM tasks ORDER BY created_at DESC").all() as Task[],
  slugExists: (slug: string) => !!db.query("SELECT 1 FROM tasks WHERE slug = ?").get(slug),
  insert(t: Task) {
    db.query(
      `INSERT INTO tasks (id, slug, title, description, repo_path, worktree_path, branch, base_branch, base_commit, phase, status, created_by, created_at, updated_at)
       VALUES ($id, $slug, $title, $description, $repo_path, $worktree_path, $branch, $base_branch, $base_commit, $phase, $status, $created_by, $created_at, $updated_at)`,
    ).run(Object.fromEntries(Object.entries(t).map(([k, v]) => [`$${k}`, v])) as never);
  },
  update(id: string, patch: Partial<Pick<Task, "phase" | "status">>): Task {
    const cur = tasks.byId(id)!;
    const next = { ...cur, ...patch, updated_at: now() };
    db.query("UPDATE tasks SET phase = ?, status = ?, updated_at = ? WHERE id = ?").run(next.phase, next.status, next.updated_at, id);
    return next;
  },
};

export const sessions = {
  byId: (id: string) => db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Session | null,
  byTask: (taskId: string) => db.query("SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at").all(taskId) as Session[],
  lastSdkSession: (taskId: string, phase: PhaseName) =>
    (db.query("SELECT sdk_session_id FROM sessions WHERE task_id = ? AND phase = ? AND sdk_session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(taskId, phase) as { sdk_session_id: string } | null)?.sdk_session_id ?? null,
  insert(s: Session) {
    db.query(
      `INSERT INTO sessions (id, task_id, phase, kind, sdk_session_id, status, cost_usd, num_turns, started_by, started_at, ended_at)
       VALUES ($id, $task_id, $phase, $kind, $sdk_session_id, $status, $cost_usd, $num_turns, $started_by, $started_at, $ended_at)`,
    ).run(Object.fromEntries(Object.entries(s).map(([k, v]) => [`$${k}`, v])) as never);
  },
  update(id: string, patch: Partial<Session>): Session {
    const next = { ...sessions.byId(id)!, ...patch };
    db.query("UPDATE sessions SET sdk_session_id = ?, status = ?, cost_usd = ?, num_turns = ?, ended_at = ? WHERE id = ?").run(
      next.sdk_session_id, next.status, next.cost_usd, next.num_turns, next.ended_at, id,
    );
    return next;
  },
};

export const events = {
  bySession: (sessionId: string) => db.query("SELECT * FROM events WHERE session_id = ? ORDER BY id").all(sessionId) as AgentEventRow[],
  insert(sessionId: string, type: AgentEventRow["type"], payload: unknown): AgentEventRow {
    const created_at = now();
    const json = JSON.stringify(payload);
    const r = db.query("INSERT INTO events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)").run(sessionId, type, json, created_at);
    return { id: Number(r.lastInsertRowid), session_id: sessionId, type, payload: json, created_at };
  },
};

export const artifacts = {
  byId: (id: string) => db.query("SELECT * FROM artifacts WHERE id = ?").get(id) as Artifact | null,
  byTask: (taskId: string) => db.query("SELECT * FROM artifacts WHERE task_id = ? ORDER BY phase, version").all(taskId) as Artifact[],
  versions: (taskId: string, phase: PhaseName) => db.query("SELECT * FROM artifacts WHERE task_id = ? AND phase = ? ORDER BY version").all(taskId, phase) as Artifact[],
  latest: (taskId: string, phase: PhaseName) => db.query("SELECT * FROM artifacts WHERE task_id = ? AND phase = ? ORDER BY version DESC LIMIT 1").get(taskId, phase) as Artifact | null,
  create(taskId: string, phase: PhaseName, path: string, content: string, createdBy: string | null = null): Artifact {
    const version = (artifacts.latest(taskId, phase)?.version ?? 0) + 1;
    const a: Artifact = { id: uuid(), task_id: taskId, phase, version, path, content, approved: 0, approved_by: null, approved_at: null, created_by: createdBy, created_at: now() };
    db.query("INSERT INTO artifacts (id, task_id, phase, version, path, content, approved, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)").run(a.id, taskId, phase, version, path, content, createdBy, a.created_at);
    return a;
  },
  /** Quita la aprobación de las versiones de estas fases (al retroceder). */
  unapprove(taskId: string, phases: PhaseName[]) {
    for (const p of phases) db.query("UPDATE artifacts SET approved = 0, approved_by = NULL, approved_at = NULL WHERE task_id = ? AND phase = ?").run(taskId, p);
  },
  approve(id: string, userId: string): Artifact {
    const at = now();
    db.query("UPDATE artifacts SET approved = 1, approved_by = ?, approved_at = ? WHERE id = ?").run(userId, at, id);
    return artifacts.byId(id)!;
  },
};

export const comments = {
  byId: (id: string) => db.query("SELECT * FROM comments WHERE id = ?").get(id) as Comment | null,
  byTask: (taskId: string) =>
    db.query("SELECT c.* FROM comments c JOIN artifacts a ON a.id = c.artifact_id WHERE a.task_id = ? ORDER BY c.created_at").all(taskId) as Comment[],
  openFor: (artifactId: string) => db.query("SELECT * FROM comments WHERE artifact_id = ? AND status = 'open' ORDER BY created_at").all(artifactId) as Comment[],
  insert(c: Comment) {
    db.query("INSERT INTO comments (id, artifact_id, quote, body, status, author_id, resolved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      c.id, c.artifact_id, c.quote, c.body, c.status, c.author_id, c.resolved_by, c.created_at,
    );
  },
  /** Pasa un comentario a otra versión del mismo artefacto (cuando una edición conserva su cita). */
  reassign(id: string, artifactId: string) {
    db.query("UPDATE comments SET artifact_id = ? WHERE id = ?").run(artifactId, id);
    return comments.byId(id)!;
  },
  update(id: string, patch: Partial<Pick<Comment, "status" | "body" | "resolved_by">>): Comment {
    const next = { ...comments.byId(id)!, ...patch };
    db.query("UPDATE comments SET status = ?, body = ?, resolved_by = ? WHERE id = ?").run(next.status, next.body, next.resolved_by, id);
    return next;
  },
};

export const activity = {
  byTask: (taskId: string, limit = 30) => db.query("SELECT * FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(taskId, limit) as ActivityEntry[],
  insert(taskId: string, userId: string, kind: string, payload?: unknown): ActivityEntry {
    const created_at = now();
    const json = payload === undefined ? null : JSON.stringify(payload);
    const r = db.query("INSERT INTO activity (task_id, user_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(taskId, userId, kind, json, created_at);
    return { id: Number(r.lastInsertRowid), task_id: taskId, user_id: userId, kind, payload: json, created_at };
  },
};
