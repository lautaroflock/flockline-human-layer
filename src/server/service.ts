import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { activity, artifacts, comments, sessions, tasks, now, uuid } from "./db";
import { bus } from "./bus";
import { config } from "./config";
import * as git from "./git";
import { HttpError } from "./http";
import { presence } from "./presence";
import type { ActivityEntry, Comment, Task, TaskDetail, User } from "../shared/types";

export function logActivity(taskId: string, user: User, kind: string, payload?: unknown): ActivityEntry {
  const entry = activity.insert(taskId, user.id, kind, payload);
  bus.publishTask(taskId, { type: "activity.added", taskId, entry });
  return entry;
}

export function publishTask(task: Task) {
  bus.publishTask(task.id, { type: "task.updated", taskId: task.id, task });
  bus.publishGlobal({ type: "tasks.changed" });
}

export function mustTask(id: string): Task {
  const t = tasks.byId(id);
  if (!t) throw new HttpError(404, "Tarea no encontrada");
  return t;
}

/** Marca como huérfanos los comentarios abiertos cuyo texto citado ya no está en la última versión. */
export function commentsWithOrphans(taskId: string): Comment[] {
  const latestIds = new Set(["research", "plan", "implement"].map((p) => artifacts.latest(taskId, p as never)?.id).filter(Boolean));
  return comments.byTask(taskId).map((c) => {
    if (c.status !== "open" || !latestIds.has(c.artifact_id)) return c;
    const art = artifacts.byId(c.artifact_id)!;
    return { ...c, orphan: !art.content.includes(c.quote) };
  });
}

export function taskDetail(id: string): TaskDetail {
  const task = mustTask(id);
  return {
    task,
    sessions: sessions.byTask(id),
    artifacts: artifacts.byTask(id),
    comments: commentsWithOrphans(id),
    activity: activity.byTask(id),
    presence: presence.forTask(id),
  };
}

const expandHome = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

export async function createTask(input: { title: string; description: string; repoPath: string }, user: User): Promise<Task> {
  const title = input.title.trim();
  const description = input.description.trim();
  if (!title) throw new HttpError(400, "El título es obligatorio");
  if (title.length > 120) throw new HttpError(400, "El título es demasiado largo");
  if (!input.repoPath?.trim()) throw new HttpError(400, "La ruta del repositorio es obligatoria");

  const repoPath = resolve(expandHome(input.repoPath.trim()));
  let info;
  try {
    info = await git.repoInfo(repoPath);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "Repositorio inválido");
  }
  const top = (await git.git(repoPath, ["rev-parse", "--show-toplevel"])).out.trim();

  let slug = "";
  do slug = `${git.slugify(title)}-${uuid().slice(0, 4)}`;
  while (tasks.slugExists(slug));

  const branch = `flock/${slug}`;
  const worktreePath = git.worktreePathFor(config.worktreesDir, slug);
  mkdirSync(dirname(worktreePath), { recursive: true });
  try {
    await git.addWorktree(top, worktreePath, branch, info.commit);
  } catch (e) {
    throw new HttpError(500, `No se pudo crear el worktree: ${e instanceof Error ? e.message : e}`);
  }
  mkdirSync(join(worktreePath, ".flock", slug), { recursive: true });

  const ts = now();
  const task: Task = {
    id: uuid(), slug, title, description, repo_path: top, worktree_path: worktreePath, branch,
    base_branch: info.branch, base_commit: info.commit, phase: "research", status: "idle",
    created_by: user.id, created_at: ts, updated_at: ts,
  };
  tasks.insert(task);
  logActivity(task.id, user, "task.created", { branch });
  publishTask(task);
  return task;
}
