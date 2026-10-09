import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactRel, runAgent } from "./agent";
import { artifacts, comments, events, now, sessions, tasks, users, uuid } from "./db";
import { bus } from "./bus";
import * as git from "./git";
import { HttpError } from "./http";
import { commentView, logActivity, mustTask, publishTask } from "./service";
import type { Artifact, Comment, PhaseName, Session, SessionKind, Task, User } from "../shared/types";
import { PHASES } from "../shared/types";

// Máquina de estados de fases (§5). TODA transición se valida acá, nunca en la UI.
//   idle → running → awaiting_review → (revise → running → awaiting_review)* → approved
const PROMPTS = join(import.meta.dir, "prompts");

const locks = new Map<string, Promise<unknown>>();
/** Serializa las operaciones de una misma tarea (§11.3): dos acciones simultáneas no se pisan. */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

const running = new Map<string, AbortController>(); // sessionId → controlador

function render(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}
const loadPrompt = (name: string) => readFileSync(join(PROMPTS, `${name}.md`), "utf8");

function mustPhase(p: string): PhaseName {
  if (!PHASES.includes(p as PhaseName)) throw new HttpError(400, "Fase inválida");
  return p as PhaseName;
}

function assertCurrent(task: Task, phase: PhaseName) {
  if (task.phase === "done") throw new HttpError(409, "La tarea ya terminó");
  const cur = PHASES.indexOf(task.phase);
  const want = PHASES.indexOf(phase);
  if (want > cur) throw new HttpError(409, `La fase ${PHASES[cur]} todavía no está aprobada`);
  if (want < cur) throw new HttpError(409, `La fase ${phase} ya fue aprobada`);
}

// ---------- ejecutar una fase ----------
export function runPhase(taskId: string, phaseParam: string, user: User): Promise<Session> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    const phase = mustPhase(phaseParam);
    if (phase === "spec") throw new HttpError(400, "La etapa Spec se escribe a mano: no corre agente");
    assertCurrent(task, phase);
    if (task.status !== "idle" && task.status !== "failed") throw new HttpError(409, `La fase está en estado ${task.status}`);

    const vars: Record<string, string> = {
      title: task.title,
      description: task.description,
      artifactPath: artifactRel(phase, task.slug),
      spec: artifacts.latest(task.id, "spec")?.content ?? "(sin spec)",
      research: artifacts.latest(task.id, "research")?.content ?? "",
      plan: artifacts.latest(task.id, "plan")?.content ?? "",
    };
    return startSession(task, phase, "run", user, render(loadPrompt(phase), vars), []);
  });
}

// ---------- pedir revisión con los comentarios abiertos ----------
export function revisePhase(taskId: string, phaseParam: string, user: User): Promise<Session> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    const phase = mustPhase(phaseParam);
    assertCurrent(task, phase);
    if (phase === "implement" || phase === "spec") throw new HttpError(400, `${phase === "spec" ? "Spec" : "Implement"} no se revisa con el agente: editá el texto a mano`);
    if (task.status !== "awaiting_review") throw new HttpError(409, "Solo se puede pedir revisión en awaiting_review");
    const art = artifacts.latest(task.id, phase);
    if (!art) throw new HttpError(409, "No hay artefacto para revisar");
    const open = comments.openFor(art.id);
    if (open.length === 0) throw new HttpError(400, "No hay comentarios abiertos");

    const list = open.map((c) => ({ quote: c.quote, body: c.body, author: users.byId(c.author_id)?.name ?? "?" }));
    const text = list.map((c, i) => `${i + 1}. [${c.author}] sobre «${c.quote}»: ${c.body}`).join("\n");
    // Los comentarios pasan a `sent` junto con el arranque de la sesión.
    const sentIds = open.map((c) => c.id);
    for (const c of open) bus.publishTask(task.id, { type: "comment.updated", taskId: task.id, comment: comments.update(c.id, { status: "sent" }) });
    logActivity(task.id, user, "comments.sent", { phase, count: open.length });
    const prompt = render(loadPrompt("revise"), { artifactPath: artifactRel(phase, task.slug), comments: text });
    return startSession(task, phase, "revise", user, prompt, list, sentIds);
  });
}

async function startSession(
  task: Task, phase: PhaseName, kind: SessionKind, user: User, prompt: string,
  list: { quote: string; body: string; author: string }[], sentIds: string[] = [],
): Promise<Session> {
  const resume = kind === "revise" ? sessions.lastSdkSession(task.id, phase) : null;
  const session: Session = {
    id: uuid(), task_id: task.id, phase, kind, sdk_session_id: null, status: "running",
    cost_usd: null, num_turns: null, started_by: user.id, started_at: now(), ended_at: null,
  };
  sessions.insert(session);
  const updated = tasks.update(task.id, { status: "running" });
  publishTask(updated);
  bus.publishTask(task.id, { type: "session.started", taskId: task.id, session });
  logActivity(task.id, user, kind === "run" ? "phase.run" : "phase.revise", { phase });

  const ac = new AbortController();
  running.set(session.id, ac);
  void drive(task, session, ac, prompt, resume, list, sentIds); // en segundo plano; el estado llega por WS
  return session;
}

const emit = (taskId: string, sessionId: string, type: Parameters<typeof events.insert>[1], payload: unknown) =>
  bus.publishTask(taskId, { type: "session.event", taskId, sessionId, event: events.insert(sessionId, type, payload) });

async function drive(task: Task, s: Session, ac: AbortController, prompt: string, resume: string | null, list: { quote: string; body: string; author: string }[], sentIds: string[]) {
  let session = s;
  let outcome: { turns: number; cost: number; error: string | null } = { turns: 0, cost: 0, error: null };
  try {
    const gen = runAgent({
      phase: s.phase, kind: s.kind, slug: task.slug, title: task.title, description: task.description, worktree: task.worktree_path!,
      prompt, resume, signal: ac.signal, abortController: ac, comments: list,
    });
    for await (const ev of gen) {
      if (ev.sdkSessionId && ev.sdkSessionId !== session.sdk_session_id) session = sessions.update(s.id, { sdk_session_id: ev.sdkSessionId });
      emit(task.id, s.id, ev.type, ev.payload);
      if (ev.changed) bus.publishTask(task.id, { type: "worktree.changed", taskId: task.id });
      if (ev.type === "result") {
        outcome = { turns: Number(ev.payload.num_turns ?? 0), cost: Number(ev.payload.total_cost_usd ?? 0), error: ev.payload.is_error ? String(ev.payload.text || "El agente terminó con error") : null };
      }
    }
  } catch (e) {
    if (ac.signal.aborted) {
      await finish(task, s, "aborted", outcome, sentIds);
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    emit(task.id, s.id, "error", { message: msg });
    outcome.error = msg;
  } finally {
    running.delete(s.id);
  }
  if (ac.signal.aborted) return;

  // Al recibir `result`: leer el artefacto esperado del worktree y registrarlo como versión nueva.
  const rel = artifactRel(s.phase, task.slug);
  let artifact: Artifact | null = null;
  if (!outcome.error) {
    try {
      const content = readFileSync(join(task.worktree_path!, rel), "utf8");
      const prev = artifacts.latest(task.id, s.phase);
      if (prev && prev.content === content && s.kind === "revise") outcome.error = "La revisión no modificó el artefacto";
      else artifact = artifacts.create(task.id, s.phase, rel, content);
    } catch {
      outcome.error = `El agente no produjo ${rel}`;
    }
  }
  if (outcome.error) emit(task.id, s.id, "error", { message: outcome.error });
  if (artifact) bus.publishTask(task.id, { type: "artifact.created", taskId: task.id, artifact });
  await finish(task, s, outcome.error ? "failed" : "done", outcome, sentIds);
}

async function finish(task: Task, s: Session, status: Session["status"], o: { turns: number; cost: number; error: string | null }, sentIds: string[] = []) {
  await withLock(task.id, async () => {
    const ended = sessions.update(s.id, { status, num_turns: o.turns, cost_usd: o.cost, ended_at: now() });
    bus.publishTask(task.id, { type: "session.ended", taskId: task.id, session: ended });
    // Una revisión que falla o se aborta conserva el artefacto: vuelve a awaiting_review y reabre sus comentarios.
    if (s.kind === "revise" && status !== "done") {
      for (const id of sentIds) bus.publishTask(task.id, { type: "comment.updated", taskId: task.id, comment: comments.update(id, { status: "open" }) });
    }
    const next = s.kind === "revise" && status !== "done" ? "awaiting_review" : status === "failed" ? "failed" : status === "aborted" ? "idle" : "awaiting_review";
    publishTask(tasks.update(task.id, { status: next }));
    bus.publishTask(task.id, { type: "worktree.changed", taskId: task.id });
  });
}

export async function abortSession(sessionId: string, user: User) {
  const s = sessions.byId(sessionId);
  if (!s) throw new HttpError(404, "Sesión no encontrada");
  const ac = running.get(sessionId);
  if (!ac) throw new HttpError(409, "La sesión no está en ejecución");
  logActivity(s.task_id, user, "phase.aborted", { phase: s.phase });
  ac.abort();
  return { ok: true };
}

// ---------- edición manual de un artefacto (H10) ----------
const MAX_ARTIFACT_BYTES = 200 * 1024;

export function saveArtifact(taskId: string, phaseParam: string, content: string, baseVersion: number, user: User): Promise<Artifact> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    const phase = mustPhase(phaseParam);
    if (phase === "implement") throw new HttpError(400, "El resumen de Implement lo escribe el agente");
    assertCurrent(task, phase);
    if (task.status === "running") throw new HttpError(409, "Hay una sesión en curso: esperá a que termine");
    const editable = task.status === "awaiting_review" || (phase === "spec" && (task.status === "idle" || task.status === "failed"));
    if (!editable) throw new HttpError(409, `No se puede editar ${phase} en estado ${task.status}`);
    const text = content.replace(/\r\n/g, "\n");
    if (!text.trim()) throw new HttpError(400, "El texto no puede estar vacío");
    if (Buffer.byteLength(text) > MAX_ARTIFACT_BYTES) throw new HttpError(400, "El texto supera los 200 KB");

    const prev = artifacts.latest(task.id, phase);
    if ((prev?.version ?? 0) !== baseVersion) throw new HttpError(409, `Alguien editó antes: ya existe la v${prev?.version}. Recargá y volvé a aplicar tu cambio`);
    if (prev && prev.content === text) throw new HttpError(400, "No hay cambios respecto de la versión actual");

    const rel = artifactRel(phase, task.slug);
    mkdirSync(join(task.worktree_path!, ".flock", task.slug), { recursive: true });
    writeFileSync(join(task.worktree_path!, rel), text);
    const artifact = artifacts.create(task.id, phase, rel, text, user.id);
    // Los comentarios abiertos cuya cita sigue en el texto nuevo migran a la versión nueva
    if (prev) {
      for (const c of comments.openFor(prev.id)) {
        if (text.includes(c.quote)) bus.publishTask(task.id, { type: "comment.updated", taskId: task.id, comment: commentView(comments.reassign(c.id, artifact.id)) });
      }
    }
    bus.publishTask(task.id, { type: "artifact.created", taskId: task.id, artifact });
    logActivity(task.id, user, "artifact.edited", { phase, version: artifact.version });
    publishTask(tasks.update(task.id, { status: "awaiting_review" }));
    bus.publishTask(task.id, { type: "worktree.changed", taskId: task.id });
    return artifact;
  });
}

// ---------- aprobar ----------
export function approvePhase(taskId: string, phaseParam: string, user: User): Promise<Task> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    const phase = mustPhase(phaseParam);
    assertCurrent(task, phase);
    if (task.status !== "awaiting_review") throw new HttpError(409, "Solo se puede aprobar en awaiting_review");

    const art = artifacts.latest(task.id, phase);
    if (!art && phase !== "implement") throw new HttpError(409, "No hay artefacto para aprobar");
    if (art) bus.publishTask(task.id, { type: "artifact.updated", taskId: task.id, artifact: artifacts.approve(art.id, user.id) });
    await git.commitAll(task.worktree_path!, `${phase}: ${task.title}`, user);
    const nextPhase = PHASES[PHASES.indexOf(phase) + 1] ?? "done";
    const updated = tasks.update(task.id, { phase: nextPhase, status: "idle" });
    logActivity(task.id, user, "phase.approved", { phase });
    publishTask(updated);
    bus.publishTask(task.id, { type: "worktree.changed", taskId: task.id });
    return updated;
  });
}

/** Al arrancar el servidor, las sesiones que quedaron `running` se marcan como fallidas (el proceso murió). */
export function recoverOnBoot() {
  for (const t of tasks.all()) {
    if (t.status !== "running") continue;
    for (const s of sessions.byTask(t.id)) if (s.status === "running") sessions.update(s.id, { status: "failed", ended_at: now() });
    tasks.update(t.id, { status: "failed" });
  }
}

export type { Comment };
