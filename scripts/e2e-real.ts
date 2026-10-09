// Test interno con el Claude Agent SDK REAL (AGENT_MODE=real): las fases las ejecuta el agente de verdad sobre demo-api.
// Gasta tokens: cada fase tiene tope de turnos y de US$ (PHASE_LIMITS en src/server/agent.ts). Al final imprime el costo total.
// Las verificaciones son estructurales (archivos, secciones, diff, tests que pasan), no textos exactos: el agente no es determinista.
//
// Uso: bun scripts/e2e-real.ts [rpi,qrspi,freeform]      (por defecto, los tres)
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDemoRepo } from "./demoRepo";
import type { AgentRowLike, ServerMessage, Session, Task, TaskDetail, User } from "./e2e-real-types";

const only = new Set((process.argv[2] ?? "rpi,qrspi,freeform").split(","));
const root = join(import.meta.dir, "..");
// Ruta larga (sin nombres 8.3 de Windows) para que el agente y la guarda vean la misma ruta del worktree
const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "flockline-real-")));
const port = 3800 + Math.floor(Math.random() * 150);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", DB_PATH: join(tmp, "real.db"), WORKTREES_DIR: join(tmp, "wt"), AGENT_MODE: "real" };
const PHASE_TIMEOUT = 15 * 60_000;

let failures = 0;
const notes: string[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

let server: ReturnType<typeof Bun.spawn> | null = null;
async function startServer() {
  server = Bun.spawn([process.execPath, "src/server/index.ts"], { cwd: root, env, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("el servidor no arrancó");
}

interface Client {
  user: User;
  msgs: ServerMessage[];
  ws: WebSocket;
  api: <T = any>(path: string, method?: string, body?: unknown) => Promise<{ status: number; data: T }>;
}
async function connect(name: string): Promise<Client> {
  const r = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  const { user, token } = (await r.json()) as { user: User; token: string };
  const msgs: ServerMessage[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  const api = async (path: string, method = "GET", body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
  };
  return { user, msgs, ws, api };
}

const SPEC = `# Spec: limitar intentos de login

## Objetivo
Evitar fuerza bruta sobre POST /login limitando los intentos por IP.

## Alcance
- Dentro: como máximo 5 intentos por minuto por IP; el sexto responde 429 con el header Retry-After en segundos.
- Fuera: rate limiting distribuido.

## Criterios de aceptación
- [ ] El sexto intento desde la misma IP devuelve 429 con Retry-After.
- [ ] Otras IP no se ven afectadas.
- [ ] Hay pruebas automatizadas con bun test.
`;

let lau: Client;
let ana: Client;
const detail = async (t: Task) => (await lau.api<TaskDetail>(`/api/tasks/${t.id}`)).data;

/** Corre una fase (o una revisión) y espera a que termine. Devuelve la sesión. */
async function runAndWait(t: Task, phase: string, verb: "run" | "revise" = "run", body?: unknown): Promise<Session> {
  const path = phase === "freeform" ? `/api/tasks/${t.id}/sessions` : `/api/tasks/${t.id}/phases/${phase}/${verb}`;
  const started = Date.now();
  const r = await lau.api<Session>(path, "POST", body);
  if (r.status !== 200) throw new Error(`${phase}/${verb} → ${r.status} ${JSON.stringify(r.data)}`);
  process.stdout.write(`    … ${phase}${verb === "revise" ? " (revisión)" : ""} con el agente real`);
  while (true) {
    const s = (await detail(t)).sessions.find((x) => x.id === r.data.id)!;
    if (s.status !== "running") {
      console.log(` → ${s.status} · ${s.num_turns ?? "?"} turnos · US$${(s.cost_usd ?? 0).toFixed(3)} · ${Math.round((Date.now() - started) / 1000)} s`);
      return s;
    }
    if (Date.now() - started > PHASE_TIMEOUT) throw new Error(`timeout esperando ${phase}`);
    await sleep(2000);
  }
}

async function events(sessionId: string): Promise<AgentRowLike[]> {
  return (await lau.api<any[]>(`/api/sessions/${sessionId}/events`)).data.map((e) => ({ ...e, p: JSON.parse(e.payload) }));
}

/** Herramientas rechazadas por la guarda en una sesión (información, no falla). */
async function denials(sessionId: string): Promise<string[]> {
  return (await events(sessionId)).filter((e) => e.type === "tool_result" && e.p.is_error && /fuera del worktree|no está permitida|solo se puede|Comando no permitido|operadores de shell/.test(String(e.p.content))).map((e) => String(e.p.content).slice(0, 100));
}

async function newTask(title: string, workflow: string, repo: string): Promise<Task> {
  const r = await lau.api<Task>("/api/tasks", "POST", { title, description: "5 intentos por minuto por IP; 429 con Retry-After", repoPath: repo, workflow });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
  return r.data;
}

async function main() {
  const repo = await ensureDemoRepo(join(tmp, "demo-api"));
  const mainHead = git(repo, "rev-parse", "main");
  await startServer();
  console.log(`servidor de prueba en ${base} · agente REAL · fases: ${[...only].join(", ")}`);
  lau = await connect("Lautaro");
  ana = await connect("Ana");

  // ───────── RPI completo con el agente real
  if (only.has("rpi")) {
    section("RPI real: research → plan → revisión con comentario → implement");
    const t = await newTask("Agregar rate limiting por IP al endpoint /login", "rpi", repo);
    await lau.api(`/api/tasks/${t.id}/phases/spec/artifact`, "PUT", { content: SPEC, baseVersion: 0 });
    await ana.api(`/api/tasks/${t.id}/phases/spec/approve`, "POST");

    const sr = await runAndWait(t, "research");
    let d = await detail(t);
    const research = d.artifacts.find((a) => a.phase === "research");
    check("research terminó y escribió research.md", sr.status === "done" && !!research && existsSync(join(t.worktree_path!, ".flock", t.slug, "research.md")), sr.status);
    check("research cita archivos reales del repo", !!research && /src\/(routes\/auth|middleware\/rateLimit|http)\.ts/.test(research.content));
    check("research no tocó código", git(t.worktree_path!, "status", "--porcelain", "--", "src", "tests") === "");
    const dr = await denials(sr.id);
    if (dr.length) notes.push(`research: ${dr.length} intento(s) rechazados por la guarda: ${dr.join(" | ")}`);
    await ana.api(`/api/tasks/${t.id}/phases/research/approve`, "POST");

    const sp = await runAndWait(t, "plan");
    d = await detail(t);
    const plan1 = d.artifacts.find((a) => a.phase === "plan");
    check("plan terminó y escribió plan.md con pasos", sp.status === "done" && !!plan1 && /(^|\n)\s*(#+.*paso|1\.|##)/i.test(plan1.content), sp.status);
    check("plan no tocó código", git(t.worktree_path!, "status", "--porcelain", "--", "src", "tests") === "");

    // Comentario sobre una línea real del plan y revisión con resume
    const quote = plan1!.content.split("\n").map((l) => l.trim()).find((l) => /^#{1,3}\s+\S/.test(l) && l.length > 6)!.replace(/^#+\s*/, "");
    const c = await ana.api(`/api/artifacts/${plan1!.id}/comments`, "POST", { quote, body: "Reutilizá el middleware existente src/middleware/rateLimit.ts; no crees archivos nuevos de middleware." });
    check("comentario sobre el plan", c.status === 200, JSON.stringify(c.data));
    const sv = await runAndWait(t, "plan", "revise");
    d = await detail(t);
    const plans = d.artifacts.filter((a) => a.phase === "plan");
    check("la revisión creó plan v2 distinto", sv.status === "done" && plans.length === 2 && plans[1]!.content !== plans[0]!.content, sv.status);
    check("la revisión retomó la sesión del SDK (resume)", !!sv.sdk_session_id && sv.sdk_session_id === sp.sdk_session_id, `${sp.sdk_session_id} vs ${sv.sdk_session_id}`);
    check("el comentario quedó enviado", d.comments.find((x) => x.id === c.data.id)?.status === "sent");
    await ana.api(`/api/tasks/${t.id}/phases/plan/approve`, "POST");

    const si = await runAndWait(t, "implement");
    d = await detail(t);
    const ev = await events(si.id);
    const bashTests = ev.filter((e) => e.type === "tool_use" && e.p.name === "Bash" && /\bbun test\b/.test(String(e.p.input?.command ?? "")));
    check("implement terminó y dejó summary.md", si.status === "done" && d.artifacts.some((a) => a.phase === "implement"), si.status);
    const diff = (await lau.api<{ diff: string }>(`/api/tasks/${t.id}/diff`)).data.diff;
    check("el diff tiene cambios de código en src/", /\+\+\+ b\/src\//.test(diff));
    check("el agente corrió bun test (Bun disponible en su PATH)", bashTests.length > 0);
    const own = Bun.spawnSync([process.execPath, "test"], { cwd: t.worktree_path!, env: { ...process.env } });
    const out = own.stdout.toString() + own.stderr.toString();
    check("verificación propia: bun test pasa en el worktree", own.exitCode === 0 && /\b0 fail\b/.test(out), out.slice(-300));
    check("main sigue intacta", git(repo, "rev-parse", "main") === mainHead && git(repo, "status", "--porcelain") === "");
    check("no hubo escrituras fuera del worktree", !existsSync(join(tmp, "src")));
    const di = await denials(si.id);
    if (di.length) notes.push(`implement: ${di.length} intento(s) rechazados por la guarda: ${di.join(" | ")}`);
    const ctx = await lau.api<any>(`/api/tasks/${t.id}/context`);
    check("contexto del cambio sobre el código real", ctx.status === 200 && ctx.data.symbols.length > 0, JSON.stringify(ctx.data).slice(0, 200));
    check("aprobar implement → done", (await ana.api<Task>(`/api/tasks/${t.id}/phases/implement/approve`, "POST")).data.phase === "done");
  }

  // ───────── QRSPI: Questions con salida estructurada real, y Design con diagrama
  if (only.has("qrspi")) {
    section("QRSPI real: questions (salida estructurada) → research → design");
    const t = await newTask("Rate limiting por IP en /login (QRSPI)", "qrspi", repo);
    await lau.api(`/api/tasks/${t.id}/phases/spec/artifact`, "PUT", { content: SPEC, baseVersion: 0 });
    await ana.api(`/api/tasks/${t.id}/phases/spec/approve`, "POST");
    const sq = await runAndWait(t, "questions");
    let d = await detail(t);
    check("el agente devolvió preguntas estructuradas", sq.status === "done" && d.questions.length >= 1 && d.questions.every((q) => q.text.length > 5), `${sq.status} · ${d.questions.length}`);
    check("cada pregunta trae por qué importa y sugerencia", d.questions.every((q) => q.why && q.suggestion));
    for (const q of d.questions) await (q.idx % 2 ? ana : lau).api(`/api/questions/${q.id}`, "PATCH", { useSuggestion: true });
    check("con todo respondido se aprueba", (await ana.api(`/api/tasks/${t.id}/phases/questions/approve`, "POST")).status === 200);
    const sr = await runAndWait(t, "research");
    check("research con las respuestas", sr.status === "done");
    await ana.api(`/api/tasks/${t.id}/phases/research/approve`, "POST");
    const sd = await runAndWait(t, "design");
    d = await detail(t);
    const design = d.artifacts.find((a) => a.phase === "design");
    check("design.md con al menos un diagrama Mermaid", sd.status === "done" && !!design && design.content.includes("```mermaid"), sd.status);
    await lau.api(`/api/tasks/${t.id}/cancel`, "POST"); // no seguimos hasta Implement para cuidar el costo
  }

  // ───────── Freeform: sesión libre real
  if (only.has("freeform")) {
    section("Freeform real: una sesión con pedido libre");
    const t = await newTask("Documentar el rate limiting", "freeform", repo);
    const s = await runAndWait(t, "freeform", "run", { prompt: "Agregá al final de README.md una sección '## Rate limiting' de dos líneas: /login permitirá como máximo 5 intentos por minuto por IP y responderá 429 con Retry-After. No toques otros archivos." });
    const readme = readFileSync(join(t.worktree_path!, "README.md"), "utf8");
    check("la sesión libre editó el README del worktree", s.status === "done" && /rate limiting/i.test(readme), s.status);
    check("no tocó otros archivos", git(t.worktree_path!, "status", "--porcelain").split("\n").filter(Boolean).every((l) => /README\.md|\.flock/.test(l)));
  }

  // ───────── costo
  let total = 0;
  for (const t of (await lau.api<Task[]>("/api/tasks")).data) for (const s of (await detail(t)).sessions) total += s.cost_usd ?? 0;
  section(`Costo total del agente real: US$${total.toFixed(3)}`);
  if (notes.length) console.log(`\nNotas:\n${notes.map((n) => `  - ${n}`).join("\n")}`);

  server?.kill();
  await server?.exited;
  console.log(failures === 0 ? "\nTODO OK (agente real)" : `\n${failures} verificación(es) fallaron`);
  console.log(`Datos de la corrida: ${tmp}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\nERROR:", e);
  server?.kill();
  process.exit(1);
});
