import { tasks, users } from "./db";
import { authed, bodyOf } from "./http";
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
};
