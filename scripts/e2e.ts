// Recorre el guion de demo (§9) por HTTP + WebSocket con DOS usuarios, en modo mock, y afirma los criterios de aceptación.
// Uso: bun scripts/e2e.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDemoRepo } from "./demoRepo";
import type { Artifact, ServerMessage, Task, TaskDetail, User } from "../src/shared/types";

const root = join(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "flockline-e2e-"));
const port = 3400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", DB_PATH: join(tmp, "e2e.db"), WORKTREES_DIR: join(tmp, "wt"), AGENT_MODE: "mock", MOCK_DELAY_MS: "5" };

let server: ReturnType<typeof Bun.spawn> | null = null;
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
async function stopServer() {
  server?.kill();
  await server?.exited;
  server = null;
}

interface Client {
  user: User;
  token: string;
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
  return { user, token, msgs, ws, api };
}

async function until(pred: () => boolean, what: string, ms = 20000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout esperando: ${what}`);
    await sleep(20);
  }
}

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  return p.stdout.toString().trim();
};

async function phaseDone(c: Client, taskId: string, phase: string, n: number) {
  await until(() => c.msgs.filter((m) => m.type === "session.ended" && m.taskId === taskId && m.session.phase === phase).length >= n, `sesión ${phase} #${n}`);
  await until(() => c.msgs.some((m) => m.type === "task.updated" && m.task.status !== "running" && m.task.id === taskId) && true, "task.updated");
  await sleep(40);
}

async function main() {
  const repo = await ensureDemoRepo(join(tmp, "demo-api"));
  const mainHead = git(repo, "rev-parse", "main");
  await startServer();
  console.log(`servidor de prueba en ${base}`);

  const lau = await connect("Lautaro");
  const ana = await connect("Ana");

  // ───────── H2 tareas y worktrees
  section("H2 · tareas y worktrees");
  check("sin token → 401", (await fetch(`${base}/api/tasks`)).status === 401);
  const bad = await lau.api("/api/tasks", "POST", { title: "x", description: "", repoPath: join(tmp, "nada") });
  check("repo inexistente → 400", bad.status === 400, JSON.stringify(bad.data));
  const created = await lau.api<Task>("/api/tasks", "POST", { title: "Agregar rate limiting por IP al endpoint /login", description: "5 intentos por minuto por IP", repoPath: repo });
  const task = created.data;
  check("crear tarea → 200", created.status === 200, JSON.stringify(created.data));
  const wt = task.worktree_path!;
  check("worktree y rama flock/<slug>", existsSync(wt) && task.branch === `flock/${task.slug}` && git(repo, "worktree", "list").includes(task.slug));
  check("rama principal intacta", git(repo, "rev-parse", "main") === mainHead && git(repo, "branch", "--show-current") === "main" && git(repo, "status", "--short") === "");
  lau.ws.send(JSON.stringify({ type: "subscribe", taskId: task.id }));
  ana.ws.send(JSON.stringify({ type: "subscribe", taskId: task.id }));
  await sleep(100);

  // ───────── H3/H4 research → gate → plan
  section("H3/H4 · fases, streaming y gates");
  const early = await lau.api(`/api/tasks/${task.id}/phases/plan/run`, "POST");
  check("run plan sin research aprobado → 409 (validado en servidor)", early.status === 409, JSON.stringify(early.data));
  const r1 = await lau.api(`/api/tasks/${task.id}/phases/research/run`, "POST");
  check("run research → sesión", r1.status === 200 && r1.data.status === "running");
  const dup = await ana.api(`/api/tasks/${task.id}/phases/research/run`, "POST");
  check("segundo run simultáneo → 409", dup.status === 409);
  await phaseDone(lau, task.id, "research", 1);
  const evOf = (c: Client) => c.msgs.filter((m) => m.type === "session.event").length;
  check("ambos usuarios reciben los mismos eventos en vivo", evOf(lau) > 5 && evOf(lau) === evOf(ana), `${evOf(lau)} vs ${evOf(ana)}`);
  const researchPath = join(wt, ".flock", task.slug, "research.md");
  check("research.md escrito en el worktree", existsSync(researchPath) && readFileSync(researchPath, "utf8").includes("rateLimit"));
  let det = (await lau.api<TaskDetail>(`/api/tasks/${task.id}`)).data;
  check("research v1 y estado awaiting_review", det.artifacts.length === 1 && det.task.status === "awaiting_review");
  const evs = await lau.api<any[]>(`/api/sessions/${det.sessions[0]!.id}/events`);
  check("historial de eventos persistido (replay)", evs.data.length > 5 && evs.data.some((e) => e.type === "tool_use"));

  const gate = await lau.api(`/api/tasks/${task.id}/phases/plan/run`, "POST");
  check("plan antes de aprobar research → 409", gate.status === 409);
  const ap = await ana.api(`/api/tasks/${task.id}/phases/research/approve`, "POST");
  check("aprobar research (como Ana)", ap.status === 200 && ap.data.phase === "plan" && ap.data.status === "idle");
  det = (await lau.api<TaskDetail>(`/api/tasks/${task.id}`)).data;
  check("approved_by queda registrado", det.artifacts[0]!.approved === 1 && det.artifacts[0]!.approved_by === ana.user.id);
  const ap2 = await lau.api(`/api/tasks/${task.id}/phases/research/approve`, "POST");
  check("aprobar de nuevo → 409", ap2.status === 409);

  await lau.api(`/api/tasks/${task.id}/phases/plan/run`, "POST");
  await phaseDone(lau, task.id, "plan", 1);
  det = (await lau.api<TaskDetail>(`/api/tasks/${task.id}`)).data;
  const plan1 = det.artifacts.find((a) => a.phase === "plan")!;
  check("plan v1 generado", plan1.version === 1 && plan1.content.includes("Crear middleware dedicado"));

  // (los hitos siguientes agregan sus pasos acá)

  await stopServer();
  rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nTODO OK" : `\n${failures} verificación(es) fallaron`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\nERROR:", e);
  await stopServer();
  process.exit(1);
});
void writeFileSync;
void symlinkSync;
void ({} as Artifact);
