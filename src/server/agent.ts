import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { config } from "./config";
import { checkTool, TOOLS, type GuardCtx } from "./guard";
import type { EventType, PhaseName, SessionKind } from "../shared/types";

export interface AgentRunOpts {
  phase: PhaseName;
  kind: SessionKind;
  slug: string;
  title: string;
  description: string;
  worktree: string;
  prompt: string;
  resume: string | null;
  signal: AbortSignal;
  abortController: AbortController;
  comments: { quote: string; body: string; author: string }[];
}

/** Evento normalizado del agente; `changed` indica que el worktree se modificó (para worktree.changed). */
export interface AgentOut {
  type: EventType;
  payload: Record<string, unknown>;
  sdkSessionId?: string;
  changed?: boolean;
}

export const artifactRel = (phase: PhaseName, slug: string) => `.flock/${slug}/${phase === "implement" ? "summary" : phase}.md`;

export function runAgent(o: AgentRunOpts): AsyncGenerator<AgentOut> {
  return config.agentMode === "real" ? runReal(o) : runMock(o);
}

// ---------- Agent SDK real ----------
const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function* runReal(o: AgentRunOpts): AsyncGenerator<AgentOut> {
  const ctx: GuardCtx = { phase: o.phase, slug: o.slug, worktree: o.worktree };
  const q = query({
    prompt: o.prompt,
    options: {
      cwd: o.worktree,
      abortController: o.abortController,
      permissionMode: "acceptEdits",
      allowedTools: TOOLS[o.phase],
      model: config.claudeModel,
      ...(o.resume ? { resume: o.resume } : {}),
      canUseTool: async (tool, input) => {
        const r = checkTool(ctx, tool, input);
        return r.ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: r.reason };
      },
    },
  });

  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init") {
      yield { type: "system", payload: { model: (m as { model?: string }).model ?? null, tools: m.tools.length }, sdkSessionId: m.session_id };
    } else if (m.type === "assistant") {
      for (const b of m.message.content as unknown as { type: string; [k: string]: unknown }[]) {
        if (b.type === "text") yield { type: "assistant_text", payload: { text: String(b.text) } };
        else if (b.type === "thinking") yield { type: "thinking", payload: { text: String(b.thinking ?? "") } };
        else if (b.type === "tool_use") yield { type: "tool_use", payload: { id: b.id, name: b.name, input: b.input } };
      }
    } else if (m.type === "user") {
      const content = (m.message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const b of content as { type: string; [k: string]: unknown }[]) {
          if (b.type !== "tool_result") continue;
          const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          yield { type: "tool_result", payload: { tool_use_id: b.tool_use_id, is_error: !!b.is_error, content: clip(text) }, changed: true };
        }
      }
    } else if (m.type === "result") {
      yield {
        type: "result",
        payload: { subtype: m.subtype, is_error: m.is_error, num_turns: m.num_turns, total_cost_usd: m.total_cost_usd, text: "result" in m ? clip(String(m.result)) : "" },
        sdkSessionId: m.session_id,
      };
    }
  }
}

// ---------- Agente mock: guion determinista que escribe artefactos reales en el worktree ----------
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("abortado", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("abortado", "AbortError"))), { once: true });
  });

function listFiles(dir: string, root = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if ([".git", ".flock", "node_modules"].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, root, out);
    else out.push(relative(root, full).replace(/\\/g, "/"));
  }
  return out.sort();
}

let toolSeq = 0;
async function* tool(o: AgentRunOpts, name: string, input: Record<string, unknown>, exec: () => Promise<string> | string, changes = false): AsyncGenerator<AgentOut, string> {
  const id = `mock_${++toolSeq}`;
  yield { type: "tool_use", payload: { id, name, input } };
  await sleep(config.mockDelayMs, o.signal);
  const verdict = checkTool({ phase: o.phase, slug: o.slug, worktree: o.worktree }, name, input);
  if (!verdict.ok) {
    yield { type: "tool_result", payload: { tool_use_id: id, is_error: true, content: `Denegado: ${verdict.reason}` } };
    return "";
  }
  const out = await exec();
  yield { type: "tool_result", payload: { tool_use_id: id, is_error: false, content: clip(out, 1500) }, changed: changes };
  return out;
}

async function* say(o: AgentRunOpts, type: "assistant_text" | "thinking", text: string): AsyncGenerator<AgentOut> {
  await sleep(config.mockDelayMs, o.signal);
  yield { type, payload: { text } };
}

async function* runMock(o: AgentRunOpts): AsyncGenerator<AgentOut> {
  const sdkSessionId = o.resume ?? `mock-${crypto.randomUUID()}`;
  yield { type: "system", payload: { model: "mock", tools: TOOLS[o.phase].length, resume: !!o.resume }, sdkSessionId };
  const wt = o.worktree;
  const art = artifactRel(o.phase, o.slug);
  const absArt = join(wt, art);
  let turns = 1;

  if (o.kind === "revise") {
    yield* say(o, "assistant_text", `Recibí ${o.comments.length} comentario(s). Reescribo ${art} completo incorporándolos.`);
    const cur = yield* tool(o, "Read", { file_path: art }, () => readFileSync(absArt, "utf8"));
    const next = reviseDoc(cur, o.comments);
    yield* tool(o, "Write", { file_path: art, content: next }, () => (writeFileSync(absArt, next), `Escrito ${art} (${next.length} bytes)`), true);
    turns = 3;
  } else if (o.phase === "research") {
    yield* say(o, "thinking", "Voy a ubicar el código relacionado con la tarea y revisar qué middlewares o patrones ya existen.");
    const files = yield* tool(o, "Glob", { pattern: "**/*" }, () => listFiles(wt).join("\n"));
    const flist = files.split("\n").filter(Boolean);
    const keyword = (/login|auth|rate|limit/i.exec(o.title)?.[0] ?? "login").toLowerCase();
    const hits = yield* tool(o, "Grep", { pattern: keyword }, () => flist.filter((f) => readFileSync(join(wt, f), "utf8").toLowerCase().includes(keyword)).join("\n") || "(sin coincidencias)");
    const hitList = hits.split("\n").filter((x) => x && !x.startsWith("("));
    for (const f of hitList.slice(0, 3)) yield* tool(o, "Read", { file_path: f }, () => clip(readFileSync(join(wt, f), "utf8"), 1200));
    const hasLimiter = flist.includes("src/middleware/rateLimit.ts");
    yield* say(o, "assistant_text", hasLimiter ? "Existe un middleware de rate limit sin uso. Redacto research.md." : "Tengo lo necesario. Redacto research.md.");
    const md = researchDoc(o, flist, hitList, hasLimiter);
    yield* tool(o, "Write", { file_path: art, content: md }, () => (writeFileSync(absArt, md), `Escrito ${art} (${md.length} bytes)`), true);
    turns = 6 + hitList.slice(0, 3).length;
  } else if (o.phase === "plan") {
    yield* say(o, "thinking", "Con el research aprobado, armo pasos concretos con archivos, pruebas y criterios.");
    yield* tool(o, "Read", { file_path: `.flock/${o.slug}/research.md` }, () => clip(readFileSync(join(wt, ".flock", o.slug, "research.md"), "utf8"), 1200));
    const flist = listFiles(wt);
    yield* say(o, "assistant_text", "Propongo crear un middleware dedicado y registrarlo en la ruta.");
    const md = planDoc(o, flist);
    yield* tool(o, "Write", { file_path: art, content: md }, () => (writeFileSync(absArt, md), `Escrito ${art} (${md.length} bytes)`), true);
    turns = 5;
  } else {
    yield* say(o, "thinking", "Ejecuto el plan aprobado paso por paso.");
    yield* tool(o, "Read", { file_path: `.flock/${o.slug}/plan.md` }, () => clip(readFileSync(join(wt, ".flock", o.slug, "plan.md"), "utf8"), 1200));
    const changed = yield* implementDemo(o);
    if (!changed) {
      const notes = `# Notas de implementación\n\nEl mock no conoce este repositorio; use AGENT_MODE=real para implementar tareas arbitrarias.\n`;
      yield* tool(o, "Write", { file_path: "NOTAS.md", content: notes }, () => (writeFileSync(join(wt, "NOTAS.md"), notes), "Escrito NOTAS.md"), true);
    }
    yield* say(o, "assistant_text", "Intento publicar la rama para dejarla lista…");
    yield* tool(o, "Bash", { command: "git push origin HEAD" }, () => "(no debería ejecutarse)");
    const summary = `# Resumen de implementación\n\n## Qué se hizo\n${changed ? "- Se implementó el límite de pedidos por IP (5 por minuto) en \`src/middleware/rateLimit.ts\`.\n- Se aplicó el middleware a la ruta de login en \`src/routes/auth.ts\`.\n- Se agregaron pruebas en \`tests/ratelimit.test.ts\`." : "- Se dejó una nota en NOTAS.md."}\n\n## Desvíos\n- Ninguno respecto del plan aprobado.\n\n## Pruebas\n- \`bun test\`: ver resultado en el log de la sesión.\n- \`git push\` fue rechazado por la guarda de herramientas (esperado).\n`;
    yield* tool(o, "Write", { file_path: art, content: summary }, () => (writeFileSync(absArt, summary), `Escrito ${art}`), true);
    turns = 11;
  }

  yield { type: "result", payload: { subtype: "success", is_error: false, num_turns: turns, total_cost_usd: 0, text: "mock", mock: true }, sdkSessionId };
}

async function* implementDemo(o: AgentRunOpts): AsyncGenerator<AgentOut, boolean> {
  const wt = o.worktree;
  const rl = join(wt, "src/middleware/rateLimit.ts");
  const au = join(wt, "src/routes/auth.ts");
  if (!existsSync(rl) || !existsSync(au)) return false;

  const rateLimit = `import { HttpError, type Middleware } from "../http";

/** Limita pedidos por IP en una ventana fija: pasado el máximo responde 429 con Retry-After. */
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
  yield* tool(o, "Write", { file_path: "src/middleware/rateLimit.ts", content: rateLimit }, () => (writeFileSync(rl, rateLimit), "Escrito src/middleware/rateLimit.ts"), true);

  const before = readFileSync(au, "utf8");
  const after = before
    .replace('import { login } from "../handlers/login";', 'import { login } from "../handlers/login";\nimport { rateLimit } from "../middleware/rateLimit";')
    .replace("compose([login])", "compose([rateLimit({ windowMs: 60_000, max: 5 }), login])");
  yield* tool(o, "Edit", { file_path: "src/routes/auth.ts", old_string: "compose([login])", new_string: "compose([rateLimit({ windowMs: 60_000, max: 5 }), login])" }, () => (writeFileSync(au, after), "Editado src/routes/auth.ts"), true);

  const test = `import { expect, test } from "bun:test";
import { loginRoute } from "../src/routes/auth";

const body = { user: "ana", password: "x" };

test("el sexto intento por IP devuelve 429 con Retry-After", () => {
  for (let i = 0; i < 5; i++) expect(loginRoute({ ip: "9.9.9.9", body }).status).toBe(401);
  const res = loginRoute({ ip: "9.9.9.9", body });
  expect(res.status).toBe(429);
  expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);
});

test("otra IP no se ve afectada", () => {
  expect(loginRoute({ ip: "8.8.8.8", body }).status).toBe(401);
});
`;
  yield* tool(o, "Write", { file_path: "tests/ratelimit.test.ts", content: test }, () => (writeFileSync(join(wt, "tests/ratelimit.test.ts"), test), "Escrito tests/ratelimit.test.ts"), true);

  yield* tool(o, "Bash", { command: "bun test" }, async () => {
    const p = Bun.spawn([process.execPath, "test"], { cwd: wt, stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD: "1" } });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return (out + err).trim();
  });
  return true;
}

function researchDoc(o: AgentRunOpts, files: string[], hits: string[], hasLimiter: boolean): string {
  return `# Research: ${o.title}

## Resumen del problema
${o.description || o.title}

## Archivos y módulos relevantes
${(hits.length ? hits : files.slice(0, 6)).map((f) => `- \`${f}\``).join("\n")}
${hasLimiter ? "- `src/middleware/rateLimit.ts`: middleware genérico existente, hoy sin implementar ni usar." : ""}

Estructura del repo:
${files.map((f) => `- \`${f}\``).join("\n")}

## Patrones existentes a respetar
- Los middlewares son funciones \`(req, res, next)\` encadenadas con \`compose\`.
- Los errores se señalan con \`HttpError\` y \`compose\` los convierte en respuesta.

## Dependencias
- Ninguna externa: el repo usa solo TypeScript y \`bun test\`.

## Riesgos y preguntas abiertas
- ¿La IP viene detrás de un proxy? Revisar trust proxy.
- El almacenamiento en memoria se pierde al reiniciar.
`;
}

function planDoc(o: AgentRunOpts, files: string[]): string {
  const hasAuth = files.includes("src/routes/auth.ts");
  return `# Plan: ${o.title}

## Paso 1 — Crear middleware dedicado
- Archivos: \`src/middleware/loginLimiter.ts\` (nuevo)
- Cambio: contador por IP con ventana de 60 s y tope de 5 intentos.
- Pruebas: el sexto intento devuelve 429.
- Criterio de aceptación: la respuesta incluye \`Retry-After\`.

## Paso 2 — Registrar en la ruta
- Archivos: \`${hasAuth ? "src/routes/auth.ts" : "la ruta correspondiente"}\`
- Cambio: aplicar el middleware solo al login.
- Criterio de aceptación: otras rutas no se ven afectadas.

## Paso 3 — Pruebas
- Archivos: \`tests/ratelimit.test.ts\`
- Criterio de aceptación: 5 intentos pasan y el sexto devuelve 429; otra IP no se ve afectada.

## Qué no vamos a hacer
- Rate limiting distribuido (Redis).
`;
}

function reviseDoc(cur: string, comments: { quote: string; body: string; author: string }[]): string {
  let next = cur;
  for (const c of comments) {
    if (/existente|reutiliz/i.test(c.body) && next.includes("Crear middleware dedicado")) {
      next = next
        .replace("Crear middleware dedicado", "Reutilizar el middleware existente")
        .replace(/- Archivos: `src\/middleware\/loginLimiter\.ts` \(nuevo\)/, "- Archivos: `src/middleware/rateLimit.ts` (existente)")
        .replace("- Cambio: contador por IP con ventana de 60 s y tope de 5 intentos.", "- Cambio: implementar el cuerpo del middleware existente, parametrizado con `{ windowMs: 60000, max: 5 }`; sin archivos nuevos.");
      continue;
    }
    const lines = next.split("\n");
    const i = lines.findIndex((l) => l.includes(c.quote));
    if (i >= 0) lines[i] = `${lines[i]} _(ajuste: ${c.body})_`;
    next = lines.join("\n");
  }
  const notes = comments.map((c) => `- ${c.author}: «${c.quote.slice(0, 60)}» → ${c.body}`).join("\n");
  return `${next.trimEnd()}\n\n## Cambios de esta versión\n${notes}\n`;
}
