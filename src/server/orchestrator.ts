import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { artifactRel, runAgent } from "./agent";
import { artifactFiles, artifacts, comments, events, now, projects, questions, sessions, tasks, users, uuid } from "./db";
import { config } from "./config";
import { bus } from "./bus";
import * as git from "./git";
import { HttpError } from "./http";
import { commentView, logActivity, mustTask, publishTask } from "./service";
import type { Artifact, Comment, PhaseName, Question, Session, SessionKind, Task, User } from "../shared/types";
import { allowsMockups, firstPhase, isPhase, isWorkflow, PHASE_DEFS, phasesOf, WORKFLOWS } from "../shared/workflows";

// Máquina de estados de fases (§5). TODA transición se valida acá, nunca en la UI.
//   idle → running → awaiting_review → (revise → running → awaiting_review)* → approved
// Las fases y su orden salen del flujo de la tarea (H12).
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
  if (!isPhase(p)) throw new HttpError(400, "Fase inválida");
  return p;
}

/** La fase tiene que ser la actual del flujo de la tarea. */
function assertCurrent(task: Task, phase: PhaseName) {
  if (task.status === "cancelled") throw new HttpError(409, "La tarea está cancelada: reabrila para seguir");
  if (task.phase === "done") throw new HttpError(409, "La tarea ya terminó");
  const flow = phasesOf(task.workflow);
  if (!flow.includes(phase)) throw new HttpError(400, `La fase ${phase} no es parte del flujo ${WORKFLOWS[task.workflow]?.label ?? task.workflow}`);
  const cur = flow.indexOf(task.phase as PhaseName);
  const want = flow.indexOf(phase);
  if (want > cur) throw new HttpError(409, `La fase ${flow[cur]} todavía no está aprobada`);
  if (want < cur) throw new HttpError(409, `La fase ${phase} ya fue aprobada`);
}

/** Bloque {{inputs}}: los artefactos aprobados de las fases anteriores que la fase declara (H12). */
function inputsBlock(task: Task, phase: PhaseName): string {
  const flow = phasesOf(task.workflow);
  const parts: string[] = [];
  for (const p of PHASE_DEFS[phase].inputs) {
    if (!flow.includes(p)) continue;
    const a = artifacts.latest(task.id, p);
    if (a) parts.push(`# ${PHASE_DEFS[p].label} aprobado (${PHASE_DEFS[p].artifact})\n\n${a.content.trim()}`);
  }
  return parts.join("\n\n---\n\n") || "(no hay artefactos previos)";
}

// ---------- ejecutar una fase ----------
export function runPhase(taskId: string, phaseParam: string, user: User): Promise<Session> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    const phase = mustPhase(phaseParam);
    const def = PHASE_DEFS[phase];
    if (def.kind === "manual") throw new HttpError(400, `La etapa ${def.label} se escribe a mano: no corre agente`);
    if (def.kind === "free") throw new HttpError(400, "En Freeform se abren sesiones con prompt libre");
    assertCurrent(task, phase);
    if (task.status !== "idle" && task.status !== "failed") throw new HttpError(409, `La fase está en estado ${task.status}`);

    const vars: Record<string, string> = {
      title: task.title,
      description: task.description,
      artifactPath: artifactRel(phase, task.slug),
      inputs: inputsBlock(task, phase),
      mockups: allowsMockups(task.workflow, phase) ? `Si la tarea toca UI, escribí además .flock/${task.slug}/mockup.html autocontenido (CSS en línea, sin recursos externos).` : "",
    };
    return startSession(task, phase, "run", user, render(loadPrompt(phase), vars));
  });
}

// ---------- pedir revisión: comentarios abiertos (documentos) o más preguntas (Questions) ----------
export function revisePhase(taskId: string, phaseParam: string, user: User): Promise<Session> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    const phase = mustPhase(phaseParam);
    const def = PHASE_DEFS[phase];
    assertCurrent(task, phase);
    if (def.kind === "manual" || def.code) throw new HttpError(400, `${def.label} no se revisa con el agente: editá el texto a mano`);
    if (task.status !== "awaiting_review") throw new HttpError(409, "Solo se puede pedir revisión en awaiting_review");

    if (def.kind === "questions") {
      const qa = questions.byTask(task.id).map((q) => `- ${q.text}\n  Respuesta: ${q.status === "skipped" ? "no aplica" : q.answer ?? "(sin responder)"}`).join("\n");
      logActivity(task.id, user, "questions.more", {});
      return startSession(task, phase, "revise", user, render(loadPrompt("questions-more"), { inputs: inputsBlock(task, phase), answers: qa }));
    }

    const art = artifacts.latest(task.id, phase);
    if (!art) throw new HttpError(409, "No hay artefacto para revisar");
    const open = comments.openFor(art.id);
    if (open.length === 0) throw new HttpError(400, "No hay comentarios abiertos");

    const list = open.map((c) => ({ quote: c.quote, body: c.body, author: users.byId(c.author_id)?.name ?? "?" }));
    const text = list.map((c, i) => `${i + 1}. [${c.author}] sobre «${c.quote}»: ${c.body}`).join("\n");
    const edited = art.created_by ? `\nLa versión actual (v${art.version}) la editó a mano ${users.byId(art.created_by)?.name ?? "una persona"}: releé el archivo antes de reescribirlo y conservá sus cambios.\n` : "";
    // Los comentarios pasan a `sent` junto con el arranque de la sesión.
    const sentIds = open.map((c) => c.id);
    for (const c of open) bus.publishTask(task.id, { type: "comment.updated", taskId: task.id, comment: comments.update(c.id, { status: "sent" }) });
    logActivity(task.id, user, "comments.sent", { phase, count: open.length });
    const prompt = render(loadPrompt("revise"), { artifactPath: artifactRel(phase, task.slug), comments: text }) + edited;
    return startSession(task, phase, "revise", user, prompt, list, sentIds);
  });
}

// ---------- Freeform: sesiones con prompt libre ----------
export function startFreeSession(taskId: string, userPrompt: string, user: User): Promise<Session> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    if (task.workflow !== "freeform") throw new HttpError(400, "Las sesiones libres son del flujo Freeform");
    if (task.status === "cancelled") throw new HttpError(409, "La tarea está cancelada: reabrila para seguir");
    if (task.phase === "done") throw new HttpError(409, "La tarea ya terminó");
    if (task.status === "running") throw new HttpError(409, "Ya hay una sesión en curso");
    const text = userPrompt.trim();
    if (!text) throw new HttpError(400, "Escribí qué tiene que hacer el agente");
    if (text.length > 8000) throw new HttpError(400, "El pedido supera los 8000 caracteres");
    const prompt = render(loadPrompt("freeform"), { title: task.title, description: task.description, prompt: text });
    return startSession(task, "freeform", "run", user, prompt, [], [], text);
  });
}

export function closeTask(taskId: string, user: User): Promise<Task> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    if (task.workflow !== "freeform") throw new HttpError(400, "Cerrar a mano es solo para Freeform: las demás terminan al aprobar Implement");
    if (task.status === "running") throw new HttpError(409, "Hay una sesión en curso");
    if (task.phase === "done") throw new HttpError(409, "La tarea ya terminó");
    await git.commitAll(task.worktree_path!, `freeform: ${task.title}`, user);
    const updated = tasks.update(task.id, { phase: "done", status: "idle" });
    logActivity(task.id, user, "task.closed", {});
    publishTask(updated);
    return updated;
  });
}

async function startSession(
  task: Task, phase: PhaseName, kind: SessionKind, user: User, prompt: string,
  list: { quote: string; body: string; author: string }[] = [], sentIds: string[] = [], userPrompt?: string,
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
  logActivity(task.id, user, phase === "freeform" ? "session.free" : kind === "run" ? "phase.run" : "phase.revise", { phase });

  const ac = new AbortController();
  running.set(session.id, ac);
  void drive(task, session, ac, prompt, resume, list, sentIds, userPrompt); // en segundo plano; el estado llega por WS
  return session;
}

const emit = (taskId: string, sessionId: string, type: Parameters<typeof events.insert>[1], payload: unknown) =>
  bus.publishTask(taskId, { type: "session.event", taskId, sessionId, event: events.insert(sessionId, type, payload) });

interface Outcome {
  turns: number;
  cost: number;
  error: string | null;
  structured?: unknown;
}

async function drive(task: Task, s: Session, ac: AbortController, prompt: string, resume: string | null, list: { quote: string; body: string; author: string }[], sentIds: string[], userPrompt?: string) {
  let session = s;
  let outcome: Outcome = { turns: 0, cost: 0, error: null };
  if (userPrompt) emit(task.id, s.id, "system", { userPrompt }); // el pedido de la sesión libre queda en su historial
  try {
    const gen = runAgent({
      phase: s.phase, kind: s.kind, slug: task.slug, title: task.title, description: task.description, worktree: task.worktree_path!,
      prompt, resume, signal: ac.signal, abortController: ac, comments: list, userPrompt,
      mode: (task.project_id ? projects.byId(task.project_id)?.agent_mode : null) ?? config.agentMode, // modo del proyecto (H17)
    });
    for await (const ev of gen) {
      if (ev.sdkSessionId && ev.sdkSessionId !== session.sdk_session_id) session = sessions.update(s.id, { sdk_session_id: ev.sdkSessionId });
      emit(task.id, s.id, ev.type, ev.payload);
      if (ev.changed) bus.publishTask(task.id, { type: "worktree.changed", taskId: task.id });
      if (ev.type === "result") {
        outcome = {
          turns: Number(ev.payload.num_turns ?? 0),
          cost: Number(ev.payload.total_cost_usd ?? 0),
          error: ev.payload.is_error ? String(ev.payload.text || "El agente terminó con error") : null,
          structured: ev.payload.structured,
        };
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

  // Al recibir `result`: registrar el artefacto de la fase como versión nueva (Freeform no tiene artefacto).
  let artifact: Artifact | null = null;
  if (!outcome.error && s.phase !== "freeform") {
    try {
      artifact = PHASE_DEFS[s.phase].kind === "questions" ? registerQuestions(task, outcome.structured) : registerArtifact(task, s);
    } catch (e) {
      outcome.error = e instanceof Error ? e.message : String(e);
    }
  }
  if (outcome.error) emit(task.id, s.id, "error", { message: outcome.error });
  if (artifact) bus.publishTask(task.id, { type: "artifact.created", taskId: task.id, artifact });
  await finish(task, s, outcome.error ? "failed" : "done", outcome, sentIds);
}

function registerArtifact(task: Task, s: Session): Artifact {
  const rel = artifactRel(s.phase, task.slug);
  let content: string;
  try {
    content = readFileSync(join(task.worktree_path!, rel), "utf8");
  } catch {
    throw new Error(`El agente no produjo ${rel}`);
  }
  const prev = artifacts.latest(task.id, s.phase);
  if (prev && prev.content === content && s.kind === "revise") throw new Error("La revisión no modificó el artefacto");
  const artifact = artifacts.create(task.id, s.phase, rel, content);
  snapshotFiles(task, artifact);
  return artifact;
}

// ---------- Questions (H13) ----------
interface RawQuestion {
  text?: unknown;
  why?: unknown;
  options?: unknown;
  suggestion?: unknown;
}

/** Inserta las preguntas de la salida estructurada (se agregan a las que ya hubiera) y genera questions.md. */
function registerQuestions(task: Task, structured: unknown): Artifact {
  const raw = (structured as { questions?: RawQuestion[] } | undefined)?.questions;
  const valid = Array.isArray(raw) ? raw.filter((q) => typeof q?.text === "string" && q.text.trim()) : [];
  if (valid.length === 0) throw new Error("El agente no devolvió preguntas en el formato esperado");
  for (const q of valid.slice(0, 10)) {
    const row = questions.insert(task.id, null, {
      text: String(q.text).trim(),
      why: typeof q.why === "string" ? q.why : "",
      options: Array.isArray(q.options) ? q.options.filter((x): x is string => typeof x === "string").slice(0, 6) : [],
      suggestion: typeof q.suggestion === "string" ? q.suggestion : "",
    });
    bus.publishTask(task.id, { type: "question.updated", taskId: task.id, question: row });
  }
  const artifact = writeQuestionsArtifact(task, null);
  questions.setArtifact(task.id, artifact.id);
  return artifact;
}

function questionsMarkdown(task: Task): string {
  const rows = questions.byTask(task.id);
  const name = (id: string | null) => (id ? users.byId(id)?.name ?? "?" : "?");
  const body = rows
    .map((q) => {
      const opts = JSON.parse(q.options) as string[];
      const answer =
        q.status === "answered" ? `**Respuesta (${name(q.answered_by)}):** ${q.answer}` : q.status === "skipped" ? `**No aplica** (marcado por ${name(q.answered_by)})` : "_Sin responder_";
      const meta = [q.why && `- _Por qué importa:_ ${q.why}`, opts.length ? `- _Opciones:_ ${opts.join(" · ")}` : "", q.suggestion && `- _Sugerencia del agente:_ ${q.suggestion}`]
        .filter(Boolean)
        .join("\n");
      return [`### ${q.idx}. ${q.text}`, meta, answer].filter(Boolean).join("\n\n");
    })
    .join("\n\n");
  return `# Preguntas y respuestas: ${task.title}\n\n${body}\n`;
}

function writeQuestionsArtifact(task: Task, createdBy: string | null): Artifact {
  const rel = artifactRel("questions", task.slug);
  const content = questionsMarkdown(task);
  mkdirSync(join(task.worktree_path!, ".flock", task.slug), { recursive: true });
  writeFileSync(join(task.worktree_path!, rel), content);
  return artifacts.create(task.id, "questions", rel, content, createdBy);
}

export function answerQuestion(questionId: string, body: { answer?: string; status?: string; useSuggestion?: boolean }, user: User): Promise<Question> {
  const q0 = questions.byId(questionId);
  if (!q0) throw new HttpError(404, "Pregunta no encontrada");
  return withLock(q0.task_id, async () => {
    const q = questions.byId(questionId)!;
    const task = mustTask(q.task_id);
    if (task.phase !== "questions" || task.status !== "awaiting_review") throw new HttpError(409, "Las preguntas solo se responden mientras la fase Questions está en revisión");
    let next: Question;
    if (body.useSuggestion) {
      if (!q.suggestion) throw new HttpError(400, "La pregunta no tiene sugerencia");
      next = questions.answer(q.id, { answer: q.suggestion, status: "answered", userId: user.id });
    } else if (body.status === "skipped") {
      next = questions.answer(q.id, { answer: null, status: "skipped", userId: user.id });
    } else if (body.status === "open") {
      next = questions.answer(q.id, { answer: null, status: "open", userId: null });
    } else {
      const text = (body.answer ?? "").trim();
      if (!text) throw new HttpError(400, "La respuesta no puede estar vacía");
      if (text.length > 4000) throw new HttpError(400, "La respuesta es demasiado larga");
      next = questions.answer(q.id, { answer: text, status: "answered", userId: user.id });
    }
    bus.publishTask(task.id, { type: "question.updated", taskId: task.id, question: next });
    logActivity(task.id, user, "question.answered", { idx: next.idx, status: next.status });
    return next;
  });
}

// ---------- mockups versionados con el artefacto (H14) ----------
const MOCKUP_EXT = [".html", ".svg", ".mmd"];
const MAX_FILE = 512 * 1024;

/** Copia los mockups de .flock/<slug>/ a la versión recién registrada, si la fase los admite. */
function snapshotFiles(task: Task, artifact: Artifact) {
  if (!allowsMockups(task.workflow, artifact.phase)) return;
  const dir = join(task.worktree_path!, ".flock", task.slug);
  if (!existsSync(dir)) return;
  const names = readdirSync(dir)
    .filter((n) => MOCKUP_EXT.includes(extname(n).toLowerCase()) && statSync(join(dir, n)).isFile() && statSync(join(dir, n)).size <= MAX_FILE)
    .sort()
    .slice(0, 5);
  for (const n of names) artifactFiles.put(artifact.id, n, readFileSync(join(dir, n), "utf8"));
}

async function finish(task: Task, s: Session, status: Session["status"], o: Outcome, sentIds: string[] = []) {
  await withLock(task.id, async () => {
    const ended = sessions.update(s.id, { status, num_turns: o.turns, cost_usd: o.cost, ended_at: now() });
    bus.publishTask(task.id, { type: "session.ended", taskId: task.id, session: ended });
    // Una revisión que falla o se aborta conserva el artefacto: vuelve a awaiting_review y reabre sus comentarios.
    if (s.kind === "revise" && status !== "done") {
      for (const id of sentIds) bus.publishTask(task.id, { type: "comment.updated", taskId: task.id, comment: comments.update(id, { status: "open" }) });
    }
    const next =
      s.phase === "freeform" ? "idle"
      : s.kind === "revise" && status !== "done" ? "awaiting_review"
      : status === "failed" ? "failed"
      : status === "aborted" ? "idle"
      : "awaiting_review";
    if (tasks.byId(task.id)?.status !== "cancelled") publishTask(tasks.update(task.id, { status: next }));
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
    const def = PHASE_DEFS[phase];
    if (def.code) throw new HttpError(400, `El resumen de ${def.label} lo escribe el agente`);
    if (def.kind === "questions") throw new HttpError(400, "Las preguntas se responden una por una, no se editan como texto");
    assertCurrent(task, phase);
    if (task.status === "running") throw new HttpError(409, "Hay una sesión en curso: esperá a que termine");
    const editable = task.status === "awaiting_review" || (def.kind === "manual" && (task.status === "idle" || task.status === "failed"));
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
    snapshotFiles(task, artifact);
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
    const def = PHASE_DEFS[phase];
    assertCurrent(task, phase);
    if (task.status !== "awaiting_review") throw new HttpError(409, "Solo se puede aprobar en awaiting_review");

    let art = artifacts.latest(task.id, phase);
    if (def.kind === "questions") {
      const open = questions.openCount(task.id);
      if (open > 0) throw new HttpError(409, `Quedan ${open} pregunta(s) sin responder`);
      // questions.md final, con las respuestas y sus autores
      if (art?.content !== questionsMarkdown(task)) {
        art = writeQuestionsArtifact(task, user.id);
        bus.publishTask(task.id, { type: "artifact.created", taskId: task.id, artifact: art });
      }
    }
    if (!art && !def.code) throw new HttpError(409, "No hay artefacto para aprobar");
    if (art) bus.publishTask(task.id, { type: "artifact.updated", taskId: task.id, artifact: artifacts.approve(art.id, user.id) });
    await git.commitAll(task.worktree_path!, `${phase}: ${task.title}`, user);
    const flow = phasesOf(task.workflow);
    const nextPhase = flow[flow.indexOf(phase) + 1] ?? "done";
    const updated = tasks.update(task.id, { phase: nextPhase, status: "idle" });
    logActivity(task.id, user, "phase.approved", { phase });
    publishTask(updated);
    bus.publishTask(task.id, { type: "worktree.changed", taskId: task.id });
    return updated;
  });
}

// ---------- cambiar de flujo (solo sin fases aprobadas) ----------
export function setWorkflow(taskId: string, workflow: string, user: User): Promise<Task> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    if (!isWorkflow(workflow)) throw new HttpError(400, "Flujo inválido");
    if (task.workflow === workflow) return task;
    if (task.status === "running") throw new HttpError(409, "Hay una sesión en curso");
    if (task.status === "cancelled") throw new HttpError(409, "La tarea está cancelada");
    if (task.phase === "done" || artifacts.byTask(task.id).some((a) => a.approved)) throw new HttpError(409, "Ya hay fases aprobadas: retrocedé antes de cambiar de flujo");
    const phase = firstPhase(workflow);
    tasks.update(task.id, { workflow });
    const updated = tasks.update(task.id, { phase, status: statusFor(task.id, phase) });
    logActivity(task.id, user, "task.workflow", { from: task.workflow, to: workflow });
    publishTask(updated);
    return updated;
  });
}

// ---------- cancelar, reabrir y retroceder ----------
function abortRunning(taskId: string) {
  for (const s of sessions.byTask(taskId)) if (s.status === "running") running.get(s.id)?.abort();
}

/** Estado al volver a una fase: en revisión si ya tiene artefacto, si no `idle`. */
const statusFor = (taskId: string, phase: Task["phase"]): Task["status"] =>
  phase !== "done" && phase !== "freeform" && artifacts.latest(taskId, phase) ? "awaiting_review" : "idle";

export function cancelTask(taskId: string, user: User): Promise<Task> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    if (task.phase === "done") throw new HttpError(409, "La tarea ya terminó");
    if (task.status === "cancelled") throw new HttpError(409, "La tarea ya está cancelada");
    abortRunning(task.id); // la sesión termina sola como `aborted`; finish respeta la cancelación
    const updated = tasks.update(task.id, { status: "cancelled" });
    logActivity(task.id, user, "task.cancelled", { phase: task.phase });
    publishTask(updated);
    return updated;
  });
}

export function reopenTask(taskId: string, user: User): Promise<Task> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    if (task.status !== "cancelled") throw new HttpError(409, "La tarea no está cancelada");
    const updated = tasks.update(task.id, { status: statusFor(task.id, task.phase) });
    logActivity(task.id, user, "task.reopened", { phase: task.phase });
    publishTask(updated);
    return updated;
  });
}

/**
 * Vuelve a una fase anterior (o rehace la actual). El worktree vuelve al commit con que se aprobó esa fase:
 * se descartan el código y los artefactos de las fases siguientes; las versiones quedan en el historial.
 * Volver a la fase actual descarta lo que produjo y la deja lista para ejecutarse de nuevo.
 */
export function rewindTask(taskId: string, toParam: string, user: User): Promise<Task> {
  return withLock(taskId, async () => {
    const task = mustTask(taskId);
    const to = mustPhase(toParam);
    if (task.workflow === "freeform") throw new HttpError(400, "Freeform no tiene fases a las que volver");
    const flow = phasesOf(task.workflow);
    if (!flow.includes(to)) throw new HttpError(400, `La fase ${to} no es parte del flujo`);
    if (task.status === "running") throw new HttpError(409, "Hay una sesión en curso: abortala antes de retroceder");
    const cur = task.phase === "done" ? flow.length : flow.indexOf(task.phase as PhaseName);
    const idx = flow.indexOf(to);
    if (idx > cur) throw new HttpError(409, `No se puede avanzar a ${to} retrocediendo`);
    const wt = task.worktree_path!;

    let status: Task["status"];
    if (idx === cur) {
      // Rehacer la fase actual: se descarta lo no aprobado y vuelve a idle
      await git.resetHard(wt, "HEAD");
      status = "idle";
    } else {
      const sha = await git.phaseCommit(wt, task.base_commit!, to);
      if (!sha) throw new HttpError(409, `No hay commit de aprobación de ${to} al que volver`);
      await git.resetHard(wt, sha);
      status = statusFor(task.id, to);
    }
    artifacts.unapprove(task.id, flow.slice(idx));
    const updated = tasks.update(task.id, { phase: to, status });
    logActivity(task.id, user, "phase.rewound", { from: task.phase, to });
    publishTask(updated);
    for (const a of artifacts.byTask(task.id)) if (flow.indexOf(a.phase) >= idx) bus.publishTask(task.id, { type: "artifact.updated", taskId: task.id, artifact: a });
    bus.publishTask(task.id, { type: "questions.changed", taskId: task.id });
    bus.publishTask(task.id, { type: "worktree.changed", taskId: task.id });
    return updated;
  });
}

/** Al arrancar el servidor, las sesiones que quedaron `running` se marcan como fallidas (el proceso murió). */
export function recoverOnBoot() {
  for (const t of tasks.all()) {
    if (t.status !== "running") continue;
    for (const s of sessions.byTask(t.id)) if (s.status === "running") sessions.update(s.id, { status: "failed", ended_at: now() });
    tasks.update(t.id, { status: t.workflow === "freeform" ? "idle" : "failed" });
  }
}

export type { Comment };
