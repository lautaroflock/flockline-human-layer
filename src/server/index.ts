import type { Server } from "bun";
import index from "../web/index.html";
import { issueToken, userFromRequest } from "./auth";
import { bus } from "./bus";
import { config } from "./config";
import { users } from "./db";
import { fail, json } from "./http";
import { recoverOnBoot } from "./orchestrator";
import { presence } from "./presence";
import { routes } from "./routes";
import type { ClientMessage, User } from "../shared/types";

const server = Bun.serve<{ user: User }>({
  hostname: config.host,
  port: config.port,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/api/health": () => json({ ok: true, agentMode: config.agentMode }),
    "/api/session": {
      POST: async (req: Request) => {
        const body = (await req.json().catch(() => ({}))) as { name?: string };
        const name = body.name?.trim();
        if (!name || name.length > 40) return fail(400, "Nombre inválido (1 a 40 caracteres)");
        const user = users.byName(name) ?? users.create(name);
        return json({ user, token: issueToken(user) });
      },
    },
    ...routes,
    "/ws": (req: Request, srv: Server<{ user: User }>) => {
      const user = userFromRequest(req);
      if (!user) return fail(401, "Sesión requerida");
      return srv.upgrade(req, { data: { user } }) ? undefined : fail(400, "Upgrade fallido");
    },
    "/*": index,
  },
  websocket: {
    open(ws) {
      ws.subscribe("tasks");
      presence.connect(ws, ws.data.user.id);
    },
    message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "subscribe") {
        ws.subscribe(`task:${msg.taskId}`);
        presence.set(ws, msg.taskId, "research");
      } else if (msg.type === "unsubscribe") {
        ws.unsubscribe(`task:${msg.taskId}`);
        presence.leave(ws, msg.taskId);
      } else if (msg.type === "presence") {
        presence.set(ws, msg.taskId, msg.tab);
      }
    },
    close(ws) {
      presence.disconnect(ws);
    },
  },
  fetch: () => fail(404, "No encontrado"),
});

recoverOnBoot();
bus.attach(server as never);
console.log(`Flockline en http://${config.host}:${config.port}  (agente: ${config.agentMode})`);
