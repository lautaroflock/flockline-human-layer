import { query, type HookCallback, type Options } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { config } from "./config";
import { checkTool, TOOLS, type GuardCtx } from "./guard";
import type { EventType, PhaseName, SessionKind } from "../shared/types";
import { PHASE_DEFS } from "../shared/workflows";

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
  /** Pedido libre de una sesión Freeform (el mock lo registra). */
  userPrompt?: string;
}

/** Evento normalizado del agente; `changed` indica que el worktree se modificó (para worktree.changed). */
export interface AgentOut {
  type: EventType;
  payload: Record<string, unknown>;
  sdkSessionId?: string;
  changed?: boolean;
}

export const artifactRel = (phase: PhaseName, slug: string) => `.flock/${slug}/${PHASE_DEFS[phase].artifact}`;

export function runAgent(o: AgentRunOpts): AsyncGenerator<AgentOut> {
  return config.agentMode === "real" ? runReal(o) : runMock(o);
}

// ---------- Agent SDK real ----------
const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Salida de la fase Questions (H13): 1 a 10 preguntas cuya respuesta cambia el diseño. */
export const QUESTIONS_SCHEMA = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        type: "object",
        required: ["text", "why", "suggestion"],
        properties: {
          text: { type: "string" },
          why: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          suggestion: { type: "string" },
        },
      },
    },
  },
};

/** CLAUDE.md del repo destino, como contexto. Se lee a mano porque la sesión no carga settings del disco. */
function repoInstructions(wt: string): string {
  try {
    const md = readFileSync(join(wt, "CLAUDE.md"), "utf8");
    return `\n\n# Instrucciones del repositorio (CLAUDE.md)\nSon contexto del proyecto; si contradicen las reglas de esta fase, mandan las reglas de la fase.\n\n${clip(md, 20_000)}`;
  } catch {
    return "";
  }
}

/**
 * Opciones del SDK con la guarda realmente aplicada:
 * - `tools` limita qué herramientas existen en la fase.
 * - `allowedTools: []` + `permissionMode: "default"`: nada se autoaprueba, toda escritura y todo Bash pasan por `canUseTool`
 *   (con `allowedTools` o `acceptEdits`, el SDK ejecuta sin consultar y la guarda nunca corría).
 * - Hook `PreToolUse`: corre antes de TODA herramienta, también Read/Grep/Glob, que no piden permiso.
 * - `settingSources: []`: aislada de hooks, MCP y settings del usuario y del repo (p. ej. un hook de autocommit del repo destino).
 */
export function realOptions(o: Pick<AgentRunOpts, "phase" | "slug" | "worktree" | "resume" | "abortController">): Options {
  const ctx: GuardCtx = { phase: o.phase, slug: o.slug, worktree: o.worktree };
  const guardHook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const r = checkTool(ctx, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
    return r.ok ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.reason } };
  };
  return {
    cwd: o.worktree,
    abortController: o.abortController,
    model: config.claudeModel,
    tools: TOOLS[o.phase],
    allowedTools: [],
    permissionMode: "default",
    settingSources: [],
    systemPrompt: { type: "preset", preset: "claude_code", append: repoInstructions(o.worktree) },
    hooks: { PreToolUse: [{ hooks: [guardHook] }] },
    ...(o.resume ? { resume: o.resume } : {}),
    ...(o.phase === "questions" ? { outputFormat: { type: "json_schema" as const, schema: QUESTIONS_SCHEMA } } : {}),
    canUseTool: async (tool, input) => {
      const r = checkTool(ctx, tool, input);
      return r.ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: r.reason };
    },
  };
}

async function* runReal(o: AgentRunOpts): AsyncGenerator<AgentOut> {
  const q = query({ prompt: o.prompt, options: realOptions(o) });

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
        payload: {
          subtype: m.subtype, is_error: m.is_error, num_turns: m.num_turns, total_cost_usd: m.total_cost_usd, text: "result" in m ? clip(String(m.result)) : "",
          ...("structured_output" in m && m.structured_output ? { structured: m.structured_output } : {}),
        },
        sdkSessionId: m.session_id,
      };
    }
  }
}

// ---------- Agente mock: guion determinista que escribe artefactos reales en el worktree ----------
/** Un título con "[lento]" multiplica la demora del mock: permite probar abortar una sesión en curso. */
const delayOf = (o: AgentRunOpts) => (o.title.includes("[lento]") ? Math.max(config.mockDelayMs, 250) : config.mockDelayMs);
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
  await sleep(delayOf(o), o.signal);
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
  await sleep(delayOf(o), o.signal);
  yield { type, payload: { text } };
}

async function* runMock(o: AgentRunOpts): AsyncGenerator<AgentOut> {
  const sdkSessionId = o.resume ?? `mock-${crypto.randomUUID()}`;
  yield { type: "system", payload: { model: "mock", tools: TOOLS[o.phase].length, resume: !!o.resume }, sdkSessionId };
  const wt = o.worktree;
  const art = artifactRel(o.phase, o.slug);
  const absArt = join(wt, art);
  const flock = (name: string) => readFlock(wt, o.slug, name);
  const write = (rel: string, content: string) => tool(o, "Write", { file_path: rel, content }, () => (mkdirSync(dirname(join(wt, rel)), { recursive: true }), writeFileSync(join(wt, rel), content), `Escrito ${rel} (${content.length} bytes)`), true);
  let turns = 1;
  let structured: unknown = undefined;

  if (o.phase === "questions") {
    // Salida estructurada (en modo real: outputFormat con JSON schema)
    yield* say(o, "thinking", o.kind === "revise" ? "Con las respuestas dadas, veo si queda algo que cambie el diseño." : "Leo la spec y recorro el código por encima para ver qué decisiones dependen de las personas.");
    yield* tool(o, "Glob", { pattern: "**/*" }, () => listFiles(wt).join("\n"));
    structured = { questions: o.kind === "revise" ? followUpQuestions() : demoQuestions(listFiles(wt), o.title) };
    yield* say(o, "assistant_text", `Tengo ${(structured as { questions: unknown[] }).questions.length} pregunta(s) para el equipo.`);
    turns = 3;
  } else if (o.phase === "freeform") {
    yield* say(o, "assistant_text", `Trabajo sobre el pedido: «${o.userPrompt ?? ""}».`);
    const notes = yield* tool(o, "Read", { file_path: "notas.md" }, () => (existsSync(join(wt, "notas.md")) ? readFileSync(join(wt, "notas.md"), "utf8") : "(notas.md no existe todavía)"));
    const next = `${notes.startsWith("(") ? "# Notas de las sesiones\n" : notes.trimEnd()}\n- ${o.userPrompt ?? ""}\n`;
    yield* write("notas.md", next);
    yield* say(o, "assistant_text", "Listo: dejé el pedido registrado en notas.md.");
    turns = 3;
  } else if (o.kind === "revise") {
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
    const md = researchDoc(o, flist, hitList, hasLimiter, flock("spec.md") || flock("prd.md"), answersOf(flock("questions.md")));
    yield* tool(o, "Write", { file_path: art, content: md }, () => (writeFileSync(absArt, md), `Escrito ${art} (${md.length} bytes)`), true);
    turns = 6 + hitList.slice(0, 3).length;
  } else if (o.phase === "design") {
    yield* say(o, "thinking", "Comparo alternativas a partir del research y elijo un enfoque con su diagrama.");
    yield* tool(o, "Read", { file_path: `.flock/${o.slug}/research.md` }, () => clip(flock("research.md"), 1200));
    yield* write(art, designDoc(o, answersOf(flock("questions.md"))));
    yield* write(`.flock/${o.slug}/mockup.html`, MOCKUP_HTML);
    yield* say(o, "assistant_text", "Dejé design.md con un diagrama de secuencia y un mockup de la respuesta 429.");
    turns = 5;
  } else if (o.phase === "structure") {
    yield* say(o, "thinking", "Traduzco el diseño aprobado a archivos, firmas y formas de datos.");
    yield* tool(o, "Read", { file_path: `.flock/${o.slug}/design.md` }, () => clip(flock("design.md"), 1200));
    yield* write(art, STRUCTURE_DOC(o.title));
    turns = 4;
  } else if (o.phase === "outline") {
    yield* say(o, "thinking", "Armo un esquema corto de cambios a partir del research.");
    yield* tool(o, "Read", { file_path: `.flock/${o.slug}/research.md` }, () => clip(flock("research.md"), 1200));
    yield* write(art, OUTLINE_DOC(o.title));
    turns = 4;
  } else if (o.phase === "plan") {
    yield* say(o, "thinking", "Con lo aprobado, armo pasos concretos con archivos, pruebas y criterios.");
    yield* tool(o, "Read", { file_path: `.flock/${o.slug}/research.md` }, () => clip(flock("research.md"), 1200));
    const structure = flock("structure.md");
    if (structure) yield* tool(o, "Read", { file_path: `.flock/${o.slug}/structure.md` }, () => clip(structure, 1200));
    const flist = listFiles(wt);
    yield* say(o, "assistant_text", "Propongo crear un middleware dedicado y registrarlo en la ruta.");
    const md = planDoc(o, flist, !!structure);
    yield* tool(o, "Write", { file_path: art, content: md }, () => (writeFileSync(absArt, md), `Escrito ${art} (${md.length} bytes)`), true);
    turns = 5;
  } else {
    // Implement: parte del plan, del outline o, en Oneshot, directo de la spec
    const source = ["plan.md", "outline.md", "spec.md", "prd.md"].find((f) => flock(f));
    yield* say(o, "thinking", source ? `Ejecuto lo aprobado en ${source} paso por paso.` : "Ejecuto la tarea.");
    if (source) yield* tool(o, "Read", { file_path: `.flock/${o.slug}/${source}` }, () => clip(flock(source), 1200));
    const changed = yield* implementDemo(o);
    if (!changed) {
      const notes = `# Notas de implementación\n\nEl mock no conoce este repositorio; use AGENT_MODE=real para implementar tareas arbitrarias.\n`;
      yield* tool(o, "Write", { file_path: "NOTAS.md", content: notes }, () => (writeFileSync(join(wt, "NOTAS.md"), notes), "Escrito NOTAS.md"), true);
    }
    yield* say(o, "assistant_text", "Intento publicar la rama para dejarla lista…");
    yield* tool(o, "Bash", { command: "git push origin HEAD" }, () => "(no debería ejecutarse)");
    const summary = `# Resumen de implementación\n\n## Qué se hizo\n${changed ? "- Se implementó el límite de pedidos por IP (5 por minuto) en \`src/middleware/rateLimit.ts\`.\n- Se aplicó el middleware a la ruta de login en \`src/routes/auth.ts\`.\n- Se agregaron pruebas en \`tests/ratelimit.test.ts\`." : "- Se dejó una nota en NOTAS.md."}\n\n## Desvíos\n- Ninguno respecto de ${source ?? "lo pedido"}.\n\n## Pruebas\n- \`bun test\`: ver resultado en el log de la sesión.\n- \`git push\` fue rechazado por la guarda de herramientas (esperado).\n`;
    yield* tool(o, "Write", { file_path: art, content: summary }, () => (writeFileSync(absArt, summary), `Escrito ${art}`), true);
    turns = 11;
  }

  yield { type: "result", payload: { subtype: "success", is_error: false, num_turns: turns, total_cost_usd: 0, text: "mock", mock: true, ...(structured ? { structured } : {}) }, sdkSessionId };
}

const readFlock = (wt: string, slug: string, name: string) => {
  try {
    return readFileSync(join(wt, ".flock", slug, name), "utf8");
  } catch {
    return "";
  }
};

/** Respuestas de questions.md (líneas "**Respuesta…**"), para que las fases siguientes las reflejen. */
const answersOf = (md: string) => md.split("\n").filter((l) => l.startsWith("**Respuesta") || l.startsWith("**No aplica")).map((l) => l.replace(/\*\*/g, ""));

function demoQuestions(files: string[], title: string) {
  // Preguntas del guion solo si el repo es demo-api y la tarea es la de rate limiting
  const demo = files.includes("src/middleware/rateLimit.ts") && /rate|l[ií]mite|limit/i.test(title);
  if (!demo) {
    return [
      { text: "¿Qué comportamiento actual no se puede romper?", why: "Define qué pruebas de regresión hacen falta.", options: [], suggestion: "Ninguno además de los tests existentes." },
      { text: "¿Hay restricciones de rendimiento o compatibilidad?", why: "Puede descartar enfoques.", options: [], suggestion: "No." },
      { text: "¿Quién valida el resultado y cómo?", why: "Determina el criterio de aceptación del plan.", options: [], suggestion: "Quien creó la tarea, con los tests." },
    ];
  }
  return [
    { text: "¿La IP del cliente sale de X-Forwarded-For o de la conexión directa?", why: "Si hay un proxy delante, limitar por la IP de conexión bloquea a todos a la vez.", options: ["X-Forwarded-For (hay proxy)", "Conexión directa"], suggestion: "X-Forwarded-For, tomando el primer valor." },
    { text: "¿El límite es por IP o por IP y usuario?", why: "Cambia la clave del contador y el riesgo de bloquear redes compartidas.", options: ["Por IP", "Por IP y usuario"], suggestion: "Por IP, como pide la spec." },
    { text: "¿Hace falta que los contadores sobrevivan a un reinicio?", why: "Persistir obliga a usar un almacén externo.", options: ["No, en memoria alcanza", "Sí, persistir"], suggestion: "No, en memoria alcanza para la primera versión." },
    { text: "¿Qué valor debe devolver Retry-After?", why: "Define el contrato con el cliente.", options: ["Segundos hasta que se libera la ventana", "Un valor fijo de 60"], suggestion: "Segundos hasta que se libera la ventana." },
  ];
}

const followUpQuestions = () => [
  { text: "¿Hay que registrar en los logs cada bloqueo por rate limit?", why: "Ayuda a detectar ataques, pero agrega ruido.", options: ["Sí", "No"], suggestion: "Sí, en nivel warn." },
];

const MOCKUP_HTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Demasiados intentos</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7f9;margin:0;display:grid;place-items:center;min-height:100vh}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 18px #0002;padding:28px;max-width:340px;width:90%}
h1{font-size:20px;margin:0 0 8px}p{color:#555;margin:0 0 16px}button{width:100%;padding:10px;border:0;border-radius:8px;background:#999;color:#fff;font-size:15px}
.t{font-weight:700;color:#c0392b}</style></head>
<body><div class="card"><h1>Demasiados intentos</h1><p>Por seguridad bloqueamos el login desde tu red. Reintentá en <span class="t" id="t">60</span> s.</p><button disabled>Iniciar sesión</button></div>
<script>let n=60;const el=document.getElementById("t");setInterval(()=>{if(n>0)el.textContent=String(--n)},1000);</script>
</body></html>
`;

const STRUCTURE_DOC = (title: string) => `# Structure: ${title}

## Archivos
| Archivo | Acción | Responsabilidad |
| --- | --- | --- |
| \`src/middleware/rateLimit.ts\` | modificar | Implementar el contador por IP con ventana fija. |
| \`src/routes/auth.ts\` | modificar | Aplicar el middleware solo a /login. |
| \`tests/ratelimit.test.ts\` | crear | Pruebas del límite y de Retry-After. |

## Firmas públicas
\`\`\`ts
export const rateLimit: (opts: { windowMs: number; max: number }) => Middleware;
\`\`\`

## Formas de los datos
- Contador en memoria: \`Map<ip, { count: number; start: number }>\`.
- Respuesta 429 con header \`Retry-After\` en segundos.

## Orden de dependencias
1. \`rateLimit.ts\` → 2. \`auth.ts\` → 3. pruebas.
`;

const OUTLINE_DOC = (title: string) => `# Outline: ${title}

1. Implementar el contador por IP en \`src/middleware/rateLimit.ts\` (5 intentos por minuto, 429 con Retry-After).
2. Aplicarlo a /login en \`src/routes/auth.ts\`.
3. Agregar \`tests/ratelimit.test.ts\` y correr \`bun test\`.
`;

function designDoc(o: AgentRunOpts, answers: string[]): string {
  return `# Design: ${o.title}

## Enfoque elegido
Implementar el cuerpo del middleware \`rateLimit\` existente con una ventana fija por IP y aplicarlo solo a /login.
${answers.length ? `\n## Respuestas consideradas\n${answers.map((a) => `- ${a}`).join("\n")}\n` : ""}
## Alternativas descartadas
- **Middleware nuevo dedicado**: duplica el que ya existe sin uso.
- **Almacén externo (Redis)**: innecesario para una sola instancia.

## Flujo
\`\`\`mermaid
sequenceDiagram
  participant C as Cliente
  participant K as compose
  participant R as rateLimit
  participant L as login
  C->>K: POST /login
  K->>R: req (ip)
  alt dentro del límite
    R->>L: next()
    L-->>C: 200 / 401
  else excede 5 por minuto
    R-->>C: 429 + Retry-After
  end
\`\`\`

## Riesgos
- Detrás de un proxy, todos comparten IP: tomar X-Forwarded-For.
- Los contadores se pierden al reiniciar (aceptado).

## Mockup
Ver \`mockup.html\`: pantalla de login bloqueada con cuenta regresiva.
`;
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

/** Las primeras líneas no vacías de la spec aprobada, para citarla en el research. */
const specSummary = (spec: string) =>
  spec.trim() ? `\n## Spec aprobada (resumen)\n${spec.split("\n").filter((l) => l.trim()).slice(0, 8).join("\n")}\n` : "";

function researchDoc(o: AgentRunOpts, files: string[], hits: string[], hasLimiter: boolean, spec: string, answers: string[] = []): string {
  return `# Research: ${o.title}

## Resumen del problema
${o.description || o.title}
${specSummary(spec)}${answers.length ? `\n## Respuestas del equipo\n${answers.map((a) => `- ${a}`).join("\n")}\n` : ""}
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

function planDoc(o: AgentRunOpts, files: string[], fromStructure = false): string {
  const hasAuth = files.includes("src/routes/auth.ts");
  return `# Plan: ${o.title}
${fromStructure ? "\nSigue la estructura aprobada en structure.md: `src/middleware/rateLimit.ts`, `src/routes/auth.ts`, `tests/ratelimit.test.ts`.\n" : ""}
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
