import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDemoRepo } from "../scripts/demoRepo";
import { changeContext, symbolContext } from "../src/server/codeintel";
import type { ChangeContext, Task } from "../src/shared/types";

const root = mkdtempSync(join(tmpdir(), "flock-ci-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sh = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();
const taskFor = (dir: string) => ({ worktree_path: dir, base_commit: sh(dir, "rev-parse", "HEAD") }) as Task;

// El mismo cambio que hace Implement en la demo: rateLimit implementado y aplicado a /login
const RATE_LIMIT = `import { HttpError, type Middleware } from "../http";

export const rateLimit = ({ windowMs, max }: { windowMs: number; max: number }): Middleware => {
  const hits = new Map<string, { count: number; start: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const h = hits.get(req.ip);
    if (!h || now - h.start >= windowMs) {
      hits.set(req.ip, { count: 1, start: now });
      return next();
    }
    if (h.count >= max) {
      res.headers["Retry-After"] = String(Math.ceil((h.start + windowMs - now) / 1000));
      throw new HttpError(429, "Too Many Requests");
    }
    h.count++;
    next();
  };
};
`;
const AUTH = `import { compose } from "../http";
import { login } from "../handlers/login";
import { rateLimit } from "../middleware/rateLimit";

export const loginRoute = compose([rateLimit({ windowMs: 60_000, max: 5 }), login]);
`;

describe("motor TypeScript (LSP) sobre demo-api", () => {
  let demo: string;
  let ctx: ChangeContext;
  let task: Task;
  beforeAll(async () => {
    demo = await ensureDemoRepo(join(root, "demo"));
    task = taskFor(demo);
    writeFileSync(join(demo, "src/middleware/rateLimit.ts"), RATE_LIMIT);
    writeFileSync(join(demo, "src/routes/auth.ts"), AUTH);
    ctx = await changeContext(task);
  });

  test("agrupa los cambios por símbolo", () => {
    const names = ctx.symbols.map((s) => `${s.file}#${s.name}`);
    expect(names).toContain("src/middleware/rateLimit.ts#rateLimit");
    expect(names).toContain("src/routes/auth.ts#loginRoute");
    expect(ctx.engine).toContain("typescript");
    expect(ctx.symbols.every((s) => s.precision === "lsp")).toBe(true);
  });

  test("hacia abajo: auth.ts llama a compose y se ve su cuerpo", () => {
    const route = ctx.symbols.find((s) => s.name === "loginRoute")!;
    const compose = route.callees.find((c) => c.name === "compose")!;
    expect(compose.file).toBe("src/http.ts");
    expect(compose.snippet).toContain("export function compose");
    expect(compose.snippet).toContain("HttpError"); // el cuerpo, no solo la firma
    expect(compose.changed).toBe(false);
  });

  test("hacia abajo: rateLimit aparece y se marca como también cambiada", () => {
    const route = ctx.symbols.find((s) => s.name === "loginRoute")!;
    const rl = route.callees.find((c) => c.name === "rateLimit")!;
    expect(rl.file).toBe("src/middleware/rateLimit.ts");
    expect(rl.changed).toBe(true);
  });

  test("hacia abajo: new HttpError resuelve a la clase en src/http.ts", () => {
    const rl = ctx.symbols.find((s) => s.name === "rateLimit")!;
    const he = rl.callees.find((c) => c.name === "HttpError")!;
    expect(he.file).toBe("src/http.ts");
    expect(he.kind).toBe("clase");
  });

  test("hacia arriba: rateLimit se llama desde auth.ts (sin contar el import)", () => {
    const rl = ctx.symbols.find((s) => s.name === "rateLimit")!;
    expect(rl.callers.length).toBe(1);
    expect(rl.callers[0]!.file).toBe("src/routes/auth.ts");
    expect(rl.callers[0]!.name).toBe("loginRoute");
    expect(rl.callers[0]!.changed).toBe(true);
  });

  test("expandir compose: lo llama auth.ts", async () => {
    const route = ctx.symbols.find((s) => s.name === "loginRoute")!;
    const compose = route.callees.find((c) => c.name === "compose")!;
    const sc = await symbolContext(task, compose.expand!);
    expect(sc.symbol.name).toBe("compose");
    expect(sc.callers.some((c) => c.file === "src/routes/auth.ts")).toBe(true);
  });

  test("expandir loginRoute: lo llaman los tests", async () => {
    const route = ctx.symbols.find((s) => s.name === "loginRoute")!;
    const sc = await symbolContext(task, { file: route.file, line: route.line, col: route.col });
    expect(sc.callers.some((c) => c.file === "tests/login.test.ts")).toBe(true);
  });

  test("ruta fuera del worktree → error", async () => {
    await expect(symbolContext(task, { file: "../afuera.ts", line: 1, col: 1 })).rejects.toThrow("fuera del worktree");
  });
});

describe("motor de texto (aproximado) sobre Python", () => {
  test("encuentra la función llamada y quién la llama", async () => {
    const dir = join(root, "py");
    Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
    writeFileSync(join(dir, "util.py"), "def helper(x):\n    return x * 2\n");
    writeFileSync(join(dir, "app.py"), "from util import helper\n\ndef main():\n    print('hola')\n");
    sh(dir, "add", "-A");
    sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    const task = taskFor(dir);
    writeFileSync(join(dir, "app.py"), "from util import helper\n\ndef main():\n    print('hola')\n    return helper(21)\n");
    writeFileSync(join(dir, "util.py"), "def helper(x):\n    # duplica\n    return x * 2\n");
    const ctx = await changeContext(task);
    const main = ctx.symbols.find((s) => s.name === "main")!;
    expect(main.precision).toBe("text");
    expect(main.callees.find((c) => c.name === "helper")?.file).toBe("util.py");
    const helper = ctx.symbols.find((s) => s.name === "helper")!;
    expect(helper.callers.some((c) => c.file === "app.py" && c.name === "main")).toBe(true);
  });
});
