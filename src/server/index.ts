import index from "../web/index.html";
import { issueToken } from "./auth";
import { bus } from "./bus";
import { config } from "./config";
import { users } from "./db";

export const json = (data: unknown, status = 200) => Response.json(data, { status });
export const fail = (status: number, error: string) => Response.json({ error }, { status });

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/api/health": () => json({ ok: true, agentMode: config.agentMode }),
    "/api/session": {
      POST: async (req) => {
        const body = (await req.json().catch(() => ({}))) as { name?: string };
        const name = body.name?.trim();
        if (!name || name.length > 40) return fail(400, "Nombre inválido (1 a 40 caracteres)");
        const user = users.byName(name) ?? users.create(name);
        return json({ user, token: issueToken(user) });
      },
    },
    "/*": index,
  },
  fetch: () => fail(404, "No encontrado"),
});

bus.attach(server);
console.log(`Flockline en http://${config.host}:${config.port}  (agente: ${config.agentMode})`);
