import { activity, artifactFiles, artifacts, comments, events, now, sessions, tasks, users, uuid } from "./db";
import { bus } from "./bus";
import { abortSession, answerQuestion, approvePhase, cancelTask, closeTask, reopenTask, revisePhase, rewindTask, runPhase, saveArtifact, setWorkflow, startFreeSession } from "./orchestrator";
import { tickets } from "./integrations/tickets";
import { WORKFLOWS, isPhase } from "../shared/workflows";
import { authed, bodyOf, HttpError } from "./http";
import { presence } from "./presence";
import * as git from "./git";
import { readSafe } from "./files";
import { changeContext, symbolContext } from "./codeintel";
import { commentView, createTask, logActivity, mustTask, taskDetail } from "./service";
import type { Comment } from "../shared/types";

// REST: comandos y lecturas (§6). Las rutas de fases, comentarios y archivos se suman en sus hitos.
export const routes = {
  "/api/me": { GET: authed(({ user }) => ({ user })) },

  "/api/users": {
    GET: authed(() => {
      const online = presence.onlineUserIds();
      return users.all().map((u) => ({ ...u, online: online.has(u.id) }));
    }),
  },

  "/api/tasks": {
    GET: authed(() => tasks.all()),
    POST: authed(async ({ req, user }) => {
      const body = await bodyOf<{ title: string; description: string; repoPath: string; workflow: string; ticketKey: string }>(req);
      return createTask({ title: body.title ?? "", description: body.description ?? "", repoPath: body.repoPath ?? "", workflow: body.workflow, ticketKey: body.ticketKey }, user);
    }),
  },

  "/api/workflows": { GET: authed(() => Object.values(WORKFLOWS)) },

  // Tickets de ejemplo (H15): mock, sin conexión a Jira
  "/api/tickets": { GET: authed(({ req }) => ({ source: tickets.source, tickets: tickets.list(new URL(req.url).searchParams.get("q") ?? "") })) },
  "/api/tickets/:key": {
    GET: authed(({ params }) => {
      const t = tickets.get(params.key!);
      if (!t) throw new HttpError(404, "Ticket no encontrado");
      return t;
    }),
  },

  // Preguntas de la fase Questions (H13)
  "/api/questions/:id": {
    PATCH: authed(async ({ req, params, user }) => answerQuestion(params.id!, await bodyOf<{ answer: string; status: string; useSuggestion: boolean }>(req), user)),
  },

  // Freeform (H12)
  "/api/tasks/:id/sessions": {
    POST: authed(async ({ req, params, user }) => startFreeSession(params.id!, (await bodyOf<{ prompt: string }>(req)).prompt ?? "", user)),
  },
  "/api/tasks/:id/close": { POST: authed(({ params, user }) => closeTask(params.id!, user)) },

  "/api/tasks/:id": {
    GET: authed(({ params }) => taskDetail(mustTask(params.id!).id)),
    PATCH: authed(async ({ req, params, user }) => {
      const body = await bodyOf<{ workflow: string }>(req);
      if (!body.workflow) throw new HttpError(400, "Nada para cambiar");
      return setWorkflow(params.id!, body.workflow, user);
    }),
  },

  // Fases (§5): toda validación vive en orchestrator.ts
  "/api/tasks/:id/phases/:phase/run": { POST: authed(({ params, user }) => runPhase(params.id!, params.phase!, user)) },
  "/api/tasks/:id/phases/:phase/approve": { POST: authed(({ params, user }) => approvePhase(params.id!, params.phase!, user)) },
  "/api/tasks/:id/phases/:phase/revise": { POST: authed(({ params, user }) => revisePhase(params.id!, params.phase!, user)) },

  "/api/tasks/:id/phases/:phase/artifact": {
    PUT: authed(async ({ req, params, user }) => {
      const body = await bodyOf<{ content: string; baseVersion: number }>(req);
      if (typeof body.content !== "string" || typeof body.baseVersion !== "number") throw new HttpError(400, "Faltan content y baseVersion");
      return saveArtifact(params.id!, params.phase!, body.content, body.baseVersion, user);
    }),
  },

  "/api/tasks/:id/cancel": { POST: authed(({ params, user }) => cancelTask(params.id!, user)) },
  "/api/tasks/:id/reopen": { POST: authed(({ params, user }) => reopenTask(params.id!, user)) },
  "/api/tasks/:id/rewind": {
    POST: authed(async ({ req, params, user }) => {
      const body = await bodyOf<{ to: string }>(req);
      if (!body.to) throw new HttpError(400, "Falta la fase destino (to)");
      return rewindTask(params.id!, body.to, user);
    }),
  },

  "/api/sessions/:id/abort": { POST: authed(({ params, user }) => abortSession(params.id!, user)) },
  "/api/sessions/:id/events": {
    GET: authed(({ params }) => {
      if (!sessions.byId(params.id!)) throw new HttpError(404, "Sesión no encontrada");
      return events.bySession(params.id!);
    }),
  },

  "/api/artifacts/:id": {
    GET: authed(({ params }) => {
      const a = artifacts.byId(params.id!);
      if (!a) throw new HttpError(404, "Artefacto no encontrado");
      return a;
    }),
  },
  "/api/artifacts/:id/files": {
    GET: authed(({ req, params }) => {
      const path = new URL(req.url).searchParams.get("path") ?? "";
      const f = artifactFiles.get(params.id!, path);
      if (!f) throw new HttpError(404, "Archivo no encontrado en esta versión");
      return { path, content: f.content };
    }),
  },
  "/api/artifacts/:id/comments": {
    POST: authed(async ({ req, params, user }) => {
      const art = artifacts.byId(params.id!);
      if (!art) throw new HttpError(404, "Artefacto no encontrado");
      const task = mustTask(art.task_id);
      const body = await bodyOf<{ quote: string; body: string }>(req);
      const quote = (body.quote ?? "").trim();
      const text = (body.body ?? "").trim();
      if (!quote || !text) throw new HttpError(400, "Faltan la cita y el comentario");
      if (quote.length > 600 || text.length > 2000) throw new HttpError(400, "Comentario demasiado largo");
      // Solo se comenta la última versión, en revisión (§11.3)
      if (artifacts.latest(task.id, art.phase)?.id !== art.id) throw new HttpError(409, "Solo se puede comentar la última versión");
      if (task.phase !== art.phase || task.status !== "awaiting_review") throw new HttpError(409, "La fase no está en revisión");
      if (!art.content.includes(quote)) throw new HttpError(400, "La cita no aparece en el artefacto");
      const c: Comment = { id: uuid(), artifact_id: art.id, quote, body: text, status: "open", author_id: user.id, resolved_by: null, created_at: now() };
      comments.insert(c);
      bus.publishTask(task.id, { type: "comment.created", taskId: task.id, comment: commentView(c) });
      logActivity(task.id, user, "comment.created", { phase: art.phase });
      return c;
    }),
  },
  "/api/comments/:id": {
    PATCH: authed(async ({ req, params, user }) => {
      const c = comments.byId(params.id!);
      if (!c) throw new HttpError(404, "Comentario no encontrado");
      const art = artifacts.byId(c.artifact_id)!;
      const body = await bodyOf<{ status: string; body: string }>(req);
      const patch: Parameters<typeof comments.update>[1] = {};
      if (body.body !== undefined) {
        if (c.author_id !== user.id) throw new HttpError(403, "Solo el autor puede editar el texto");
        if (c.status !== "open") throw new HttpError(409, "Solo se editan comentarios abiertos");
        if (!body.body.trim()) throw new HttpError(400, "El comentario no puede estar vacío");
        patch.body = body.body.trim();
      }
      if (body.status !== undefined) {
        if (body.status === "resolved" && c.status === "open") Object.assign(patch, { status: "resolved", resolved_by: user.id });
        else if (body.status === "open" && c.status === "resolved") Object.assign(patch, { status: "open", resolved_by: null });
        else throw new HttpError(409, `Transición inválida: ${c.status} → ${body.status}`);
      }
      const next = comments.update(c.id, patch);
      bus.publishTask(art.task_id, { type: "comment.updated", taskId: art.task_id, comment: commentView(next) });
      if (patch.status === "resolved") logActivity(art.task_id, user, "comment.resolved", { phase: art.phase, author: c.author_id });
      return next;
    }),
  },
  // Worktree navegable (§11.6): solo lectura, rutas validadas contra el worktree
  "/api/tasks/:id/tree": {
    GET: authed(async ({ params }) => {
      const t = mustTask(params.id!);
      return git.tree(t.worktree_path!, t.base_commit!);
    }),
  },
  "/api/tasks/:id/file": {
    GET: authed(({ req, params }) => {
      const t = mustTask(params.id!);
      const path = new URL(req.url).searchParams.get("path") ?? "";
      return readSafe(t.worktree_path!, path);
    }),
  },
  // Contexto del cambio (H16): qué llama lo que cambió y desde dónde se lo llama
  "/api/tasks/:id/context": { GET: authed(({ params }) => changeContext(mustTask(params.id!))) },
  "/api/tasks/:id/context/symbol": {
    GET: authed(({ req, params }) => {
      const q = new URL(req.url).searchParams;
      return symbolContext(mustTask(params.id!), { file: q.get("file") ?? "", line: Number(q.get("line")), col: Number(q.get("col")) });
    }),
  },
  "/api/tasks/:id/commits": {
    GET: authed(async ({ params }) => {
      const t = mustTask(params.id!);
      return git.commits(t.worktree_path!, t.base_commit!);
    }),
  },
  "/api/tasks/:id/activity": { GET: authed(({ params }) => activity.byTask(mustTask(params.id!).id, 50)) },

  // Diff de la rama contra la base, sin .flock/ (§6)
  "/api/tasks/:id/diff": {
    GET: authed(async ({ params }) => {
      const t = mustTask(params.id!);
      return { diff: await git.diff(t.worktree_path!, t.base_commit!) };
    }),
  },
  "/api/tasks/:id/artifacts/:phase/versions": {
    GET: authed(({ params }) => {
      mustTask(params.id!);
      if (!isPhase(params.phase)) throw new HttpError(400, "Fase inválida");
      return artifacts.versions(params.id!, params.phase as never).map(({ content: _c, ...meta }) => meta);
    }),
  },
};
