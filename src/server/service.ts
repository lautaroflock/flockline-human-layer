import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { activity, artifactFiles, artifacts, comments, projects, questions, sessions, tasks, now, uuid } from "./db";
import { bus } from "./bus";
import { config } from "./config";
import * as git from "./git";
import { HttpError } from "./http";
import { presence } from "./presence";
import { specFromTicket, tickets } from "./integrations/tickets";
import { firstPhase, isWorkflow, PHASE_DEFS, type WorkflowId } from "../shared/workflows";
import type { ActivityEntry, AgentMode, Comment, Project, Task, TaskDetail, User } from "../shared/types";

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
  const latestIds = new Set(Object.keys(PHASE_DEFS).map((p) => artifacts.latest(taskId, p as never)?.id).filter(Boolean));
  return comments.byTask(taskId).map((c) => {
    if (c.status !== "open" || !latestIds.has(c.artifact_id)) return c;
    const art = artifacts.byId(c.artifact_id)!;
    return { ...c, orphan: !art.content.includes(c.quote) };
  });
}

/** Un comentario con su campo calculado `orphan` (solo aplica a abiertos sobre la última versión). */
export function commentView(c: Comment): Comment {
  if (c.status !== "open") return c;
  const art = artifacts.byId(c.artifact_id);
  if (!art || artifacts.latest(art.task_id, art.phase)?.id !== art.id) return c;
  return { ...c, orphan: !art.content.includes(c.quote) };
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
    questions: questions.byTask(id),
    artifactFiles: artifactFiles.metaByTask(id),
  };
}

const expandHome = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

export function publishProjects() {
  bus.publishGlobal({ type: "projects.changed" });
}

/** Abre (o reactiva) un proyecto sobre un repo git local (H17). */
export async function openProject(input: { repoPath: string; name?: string; agentMode?: string }, user: User | null): Promise<Project> {
  if (!input.repoPath?.trim()) throw new HttpError(400, "La ruta del repositorio es obligatoria");
  if (input.agentMode !== undefined && input.agentMode !== "real" && input.agentMode !== "mock") throw new HttpError(400, "Modo de agente inválido");
  const repoPath = resolve(expandHome(input.repoPath.trim()));
  try {
    await git.repoInfo(repoPath);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "Repositorio inválido");
  }
  const top = (await git.git(repoPath, ["rev-parse", "--show-toplevel"])).out.trim();
  const existing = projects.byPath(top);
  if (existing) {
    const patch: Partial<Project> = {};
    if (existing.archived) patch.archived = 0;
    if (input.agentMode && input.agentMode !== existing.agent_mode) patch.agent_mode = input.agentMode as AgentMode;
    if (input.name?.trim() && input.name.trim() !== existing.name) patch.name = input.name.trim().slice(0, 60);
    const p = Object.keys(patch).length ? projects.update(existing.id, patch) : existing;
    if (Object.keys(patch).length) publishProjects();
    return p;
  }
  const name = (input.name?.trim() || top.split("/").filter(Boolean).pop() || top).slice(0, 60);
  const p = projects.create({ name, repo_path: top, agent_mode: (input.agentMode as AgentMode) ?? config.agentMode, created_by: user?.id ?? null });
  publishProjects();
  return p;
}

export async function createTask(input: { title: string; description: string; repoPath: string; projectId?: string; workflow?: string; ticketKey?: string }, user: User): Promise<Task> {
  // Desde un ticket (H15): título, descripción y flujo sugerido salen del ticket si no vienen
  const ticket = input.ticketKey ? tickets.get(input.ticketKey) : null;
  if (input.ticketKey && !ticket) throw new HttpError(404, `No existe el ticket ${input.ticketKey}`);
  const title = (input.title || ticket?.summary || "").trim();
  const description = (input.description || ticket?.description || "").trim();
  const workflow: WorkflowId = input.workflow ? (isWorkflow(input.workflow) ? input.workflow : invalidWorkflow()) : ticket?.suggestedWorkflow ?? "rpi";
  if (!title) throw new HttpError(400, "El título es obligatorio");
  if (title.length > 120) throw new HttpError(400, "El título es demasiado largo");
  // Proyecto (H17): por id, o el del repo indicado (compatibilidad: lo crea si no existe)
  let project: Project | null = null;
  if (input.projectId) {
    project = projects.byId(input.projectId);
    if (!project) throw new HttpError(404, "Proyecto no encontrado");
    if (project.archived) throw new HttpError(409, "El proyecto está cerrado: abrilo de nuevo");
  } else if (input.repoPath?.trim()) {
    project = await openProject({ repoPath: input.repoPath }, user);
  } else {
    throw new HttpError(400, "Elegí un proyecto (o indicá la ruta del repositorio)");
  }
  let info;
  try {
    info = await git.repoInfo(project.repo_path);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "Repositorio inválido");
  }
  const top = project.repo_path;

  let slug = ticket ? `${ticket.key.toLowerCase()}-${git.slugify(ticket.summary)}`.slice(0, 48).replace(/-+$/, "") : "";
  if (!slug || tasks.slugExists(slug)) {
    do slug = `${ticket ? `${ticket.key.toLowerCase()}-` : ""}${git.slugify(title)}-${uuid().slice(0, 4)}`;
    while (tasks.slugExists(slug));
  }

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
    base_branch: info.branch, base_commit: info.commit, phase: firstPhase(workflow), status: "idle", workflow, project_id: project.id,
    ticket_source: ticket ? tickets.source : null, ticket_key: ticket?.key ?? null, ticket_url: ticket?.url ?? null,
    created_by: user.id, created_at: ts, updated_at: ts,
  };
  tasks.insert(task);
  logActivity(task.id, user, "task.created", { branch, workflow, ticket: ticket?.key ?? null, project: project.name });
  publishProjects();

  // La primera fase manual (Spec o PRD) arranca con una v1 importada del ticket, sin autor
  const first = PHASE_DEFS[task.phase as keyof typeof PHASE_DEFS];
  if (ticket && first?.kind === "manual") {
    const content = specFromTicket(ticket, first.label);
    const rel = `.flock/${slug}/${first.artifact}`;
    writeFileSync(join(worktreePath, rel), content);
    artifacts.create(task.id, first.id, rel, content, null);
    const updated = tasks.update(task.id, { status: "awaiting_review" });
    publishTask(updated);
    return updated;
  }
  publishTask(task);
  return task;
}

function invalidWorkflow(): never {
  throw new HttpError(400, "Flujo inválido");
}
