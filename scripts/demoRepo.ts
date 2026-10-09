// Repo de ejemplo para la demo: una API pequeña en TypeScript, sin dependencias, con tests de `bun test`.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "demo-api", private: true, type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
  "README.md": "# demo-api\n\nAPI pequeña en TypeScript (sin framework) usada como repo de ejemplo de Flockline.\n",
  "src/http.ts": `export interface Req { ip: string; body: Record<string, unknown> }
export interface Res { status: number; headers: Record<string, string>; body?: unknown }
export type Middleware = (req: Req, res: Res, next: () => void) => void;

export class HttpError extends Error {
  constructor(public status: number, message = "") {
    super(message);
  }
}

/** Encadena middlewares; el último es el handler. Los HttpError se convierten en respuesta. */
export function compose(chain: Middleware[]): (req: Req) => Res {
  return (req) => {
    const res: Res = { status: 200, headers: {} };
    let i = 0;
    const next = () => {
      const fn = chain[i++];
      if (fn) fn(req, res, next);
    };
    try {
      next();
    } catch (e) {
      if (e instanceof HttpError) res.status = e.status;
      else throw e;
    }
    return res;
  };
}
`,
  "src/handlers/login.ts": `import type { Middleware } from "../http";

const USERS: Record<string, string> = { ana: "1234" };

export const login: Middleware = (req, res) => {
  const { user, password } = req.body as { user?: string; password?: string };
  if (user && USERS[user] === password) {
    res.status = 200;
    res.body = { token: \`token-\${user}\` };
  } else {
    res.status = 401;
    res.body = { error: "credenciales inválidas" };
  }
};
`,
  "src/middleware/rateLimit.ts": `import type { Middleware } from "../http";

// Middleware genérico preparado para limitar pedidos, todavía sin implementar ni usar.
export const rateLimit = (_opts?: { windowMs: number; max: number }): Middleware => (_req, _res, next) => next();
`,
  "src/routes/auth.ts": `import { compose } from "../http";
import { login } from "../handlers/login";

export const loginRoute = compose([login]);
`,
  "tests/login.test.ts": `import { expect, test } from "bun:test";
import { loginRoute } from "../src/routes/auth";

test("login correcto devuelve token", () => {
  const res = loginRoute({ ip: "1.1.1.1", body: { user: "ana", password: "1234" } });
  expect(res.status).toBe(200);
});

test("login incorrecto devuelve 401", () => {
  const res = loginRoute({ ip: "1.1.1.1", body: { user: "ana", password: "x" } });
  expect(res.status).toBe(401);
});
`,
};

async function sh(cwd: string, args: string[]) {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err || out}`);
  return out;
}

/** Crea (si no existe) el repo de ejemplo con un commit inicial. Devuelve su ruta. */
export async function ensureDemoRepo(dir: string): Promise<string> {
  if (existsSync(join(dir, ".git"))) return dir;
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  await sh(dir, ["init", "-b", "main"]);
  await sh(dir, ["add", "-A"]);
  await sh(dir, ["-c", "user.name=Demo", "-c", "user.email=demo@flockline.local", "commit", "-q", "-m", "Estado inicial de demo-api"]);
  return dir;
}
