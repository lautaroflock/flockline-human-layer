import { artifacts, events, sessions, tasks, users } from "./db";
import { abortSession, approvePhase, revisePhase, runPhase } from "./orchestrator";
import { authed, bodyOf, HttpError } from "./http";
import { presence } from "./presence";
import { createTask, mustTask, taskDetail } from "./service";

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
      const body = await bodyOf<{ title: string; description: string; repoPath: string }>(req);
      return createTask({ title: body.title ?? "", description: body.description ?? "", repoPath: body.repoPath ?? "" }, user);
    }),
  },

  "/api/tasks/:id": { GET: authed(({ params }) => taskDetail(mustTask(params.id!).id)) },

  // Fases (§5): toda validación vive en orchestrator.ts
  "/api/tasks/:id/phases/:phase/run": { POST: authed(({ params, user }) => runPhase(params.id!, params.phase!, user)) },
  "/api/tasks/:id/phases/:phase/approve": { POST: authed(({ params, user }) => approvePhase(params.id!, params.phase!, user)) },
  "/api/tasks/:id/phases/:phase/revise": { POST: authed(({ params, user }) => revisePhase(params.id!, params.phase!, user)) },

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
  "/api/tasks/:id/artifacts/:phase/versions": {
    GET: authed(({ params }) => {
      mustTask(params.id!);
      if (!["research", "plan", "implement"].includes(params.phase!)) throw new HttpError(400, "Fase inválida");
      return artifacts.versions(params.id!, params.phase as never).map(({ content: _c, ...meta }) => meta);
    }),
  },
};
