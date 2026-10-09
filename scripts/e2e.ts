// Recorre el guion de demo (§9) por HTTP + WebSocket con DOS usuarios, en modo mock, y afirma los criterios de aceptación.
// Uso: bun scripts/e2e.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDemoRepo } from "./demoRepo";
import type { ServerMessage, Task, TaskDetail, User } from "../src/shared/types";

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

const SPEC = `# Spec: limitar intentos de login

## Objetivo
Evitar fuerza bruta sobre el login limitando los intentos por IP.

## Alcance
- Dentro: 5 intentos por minuto por IP, respuesta 429 con Retry-After.
- Fuera: rate limiting distribuido.

## Criterios de aceptación
- [ ] El sexto intento devuelve 429.
`;

/** Etapa Spec manual: una persona la escribe y otra la aprueba. */
async function specAndApprove(writer: Client, approver: Client, taskId: string) {
  const w = await writer.api(`/api/tasks/${taskId}/phases/spec/artifact`, "PUT", { content: SPEC, baseVersion: 0 });
  const a = await approver.api(`/api/tasks/${taskId}/phases/spec/approve`, "POST");
  return { w, a };
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
  check("la tarea nueva arranca en la etapa Spec", task.phase === "spec" && task.status === "idle");
  check("worktree y rama flock/<slug>", existsSync(wt) && task.branch === `flock/${task.slug}` && git(repo, "worktree", "list").includes(task.slug));
  check("rama principal intacta", git(repo, "rev-parse", "main") === mainHead && git(repo, "branch", "--show-current") === "main" && git(repo, "status", "--short") === "");
  lau.ws.send(JSON.stringify({ type: "subscribe", taskId: task.id }));
  ana.ws.send(JSON.stringify({ type: "subscribe", taskId: task.id }));
  await sleep(100);

  // ───────── H3/H4 research → gate → plan
  section("H3/H4 · fases, streaming y gates");
  const early = await lau.api(`/api/tasks/${task.id}/phases/plan/run`, "POST");
  check("run plan sin research aprobado → 409 (validado en servidor)", early.status === 409, JSON.stringify(early.data));
  const noSpec = await lau.api(`/api/tasks/${task.id}/phases/research/run`, "POST");
  check("research sin spec aprobada → 409", noSpec.status === 409, JSON.stringify(noSpec.data));
  const sp = await specAndApprove(lau, ana, task.id);
  check("spec escrita a mano (Lautaro) y aprobada (Ana)", sp.w.status === 200 && sp.a.status === 200 && sp.a.data.phase === "research", `${sp.w.status} ${sp.a.status}`);
  const r1 = await lau.api(`/api/tasks/${task.id}/phases/research/run`, "POST");
  check("run research → sesión", r1.status === 200 && r1.data.status === "running");
  const dup = await ana.api(`/api/tasks/${task.id}/phases/research/run`, "POST");
  check("segundo run simultáneo → 409", dup.status === 409);
  await phaseDone(lau, task.id, "research", 1);
  const evOf = (c: Client) => c.msgs.filter((m) => m.type === "session.event").length;
  check("ambos usuarios reciben los mismos eventos en vivo", evOf(lau) > 5 && evOf(lau) === evOf(ana), `${evOf(lau)} vs ${evOf(ana)}`);
  const researchPath = join(wt, ".flock", task.slug, "research.md");
  check("research.md escrito en el worktree y cita la spec aprobada", existsSync(researchPath) && readFileSync(researchPath, "utf8").includes("rateLimit") && readFileSync(researchPath, "utf8").includes("Spec aprobada"));
  let det = (await lau.api<TaskDetail>(`/api/tasks/${task.id}`)).data;
  check("research v1 y estado awaiting_review", det.artifacts.filter((a) => a.phase === "research").length === 1 && det.task.status === "awaiting_review");
  const evs = await lau.api<any[]>(`/api/sessions/${det.sessions[0]!.id}/events`);
  check("historial de eventos persistido (replay)", evs.data.length > 5 && evs.data.some((e) => e.type === "tool_use"));

  const gate = await lau.api(`/api/tasks/${task.id}/phases/plan/run`, "POST");
  check("plan antes de aprobar research → 409", gate.status === 409);
  const ap = await ana.api(`/api/tasks/${task.id}/phases/research/approve`, "POST");
  check("aprobar research (como Ana)", ap.status === 200 && ap.data.phase === "plan" && ap.data.status === "idle");
  det = (await lau.api<TaskDetail>(`/api/tasks/${task.id}`)).data;
  const resArt = det.artifacts.find((a) => a.phase === "research")!;
  check("approved_by queda registrado", resArt.approved === 1 && resArt.approved_by === ana.user.id);
  const ap2 = await lau.api(`/api/tasks/${task.id}/phases/research/approve`, "POST");
  check("aprobar de nuevo → 409", ap2.status === 409);

  await lau.api(`/api/tasks/${task.id}/phases/plan/run`, "POST");
  await phaseDone(lau, task.id, "plan", 1);
  det = (await lau.api<TaskDetail>(`/api/tasks/${task.id}`)).data;
  const plan1 = det.artifacts.find((a) => a.phase === "plan")!;
  check("plan v1 generado", plan1.version === 1 && plan1.content.includes("Crear middleware dedicado"));

  // ───────── H5 comentarios y revisión
  section("H5 · comentarios y revisión (con resume)");
  const researchArt = det.artifacts.find((a) => a.phase === "research")!;
  const old = await lau.api(`/api/artifacts/${researchArt.id}/comments`, "POST", { quote: "rateLimit", body: "tarde" });
  check("comentar una versión vieja/aprobada → 409", old.status === 409);
  const noQuote = await lau.api(`/api/artifacts/${plan1.id}/comments`, "POST", { quote: "texto que no existe en el plan", body: "x" });
  check("cita que no está en el artefacto → 400", noQuote.status === 400);
  const noneYet = await lau.api(`/api/tasks/${task.id}/phases/plan/revise`, "POST");
  check("revise sin comentarios → 400", noneYet.status === 400);
  const c1 = await ana.api(`/api/artifacts/${plan1.id}/comments`, "POST", { quote: "Crear middleware dedicado", body: "Usar el middleware existente en vez de crear uno nuevo" });
  const c2 = await lau.api(`/api/artifacts/${plan1.id}/comments`, "POST", { quote: "Rate limiting distribuido (Redis)", body: "Confirmado, fuera de alcance" });
  const c3 = await lau.api(`/api/artifacts/${plan1.id}/comments`, "POST", { quote: "Criterio de aceptación", body: "Falta medir latencia" });
  check("comentarios creados con su autor", c1.status === 200 && c1.data.author_id === ana.user.id && c2.data.author_id === lau.user.id);
  await until(() => lau.msgs.filter((m) => m.type === "comment.created").length >= 3 && ana.msgs.filter((m) => m.type === "comment.created").length >= 3, "comment.created en ambos clientes");
  check("comment.created llega en vivo a ambos usuarios", true);
  const patchOther = await ana.api(`/api/comments/${c3.data.id}`, "PATCH", { body: "editado por otra persona" });
  check("editar texto ajeno → 403", patchOther.status === 403);
  const res = await ana.api(`/api/comments/${c3.data.id}`, "PATCH", { status: "resolved" });
  check("resolver comentario de otra persona (queda resolved_by)", res.status === 200 && res.data.status === "resolved" && res.data.resolved_by === ana.user.id);

  const sess1 = det.sessions.find((x) => x.phase === "plan")!;
  const rv = await lau.api(`/api/tasks/${task.id}/phases/plan/revise`, "POST");
  check("revise → sesión kind=revise", rv.status === 200 && rv.data.kind === "revise");
  await phaseDone(lau, task.id, "plan", 2);
  det = (await lau.api<TaskDetail>(`/api/tasks/${task.id}`)).data;
  const plan2 = det.artifacts.filter((a) => a.phase === "plan").find((a) => a.version === 2)!;
  check("plan v2 incorpora el comentario", !!plan2 && plan2.content.includes("Reutilizar el middleware existente") && plan2.content.includes("Cambios de esta versión"));
  const sess2 = det.sessions.filter((x) => x.phase === "plan")[1]!;
  check("la revisión retoma la sesión anterior del SDK (resume)", !!sess1.sdk_session_id && sess2.sdk_session_id === sess1.sdk_session_id);
  const cs = det.comments.filter((c) => c.artifact_id === plan1.id);
  check("comentarios enviados pasan a sent; el resuelto sigue resolved", cs.filter((c) => c.status === "sent").length === 2 && cs.filter((c) => c.status === "resolved").length === 1);
  const late = await lau.api(`/api/artifacts/${plan1.id}/comments`, "POST", { quote: "Paso 1", body: "tarde" });
  check("v1 ya no admite comentarios → 409", late.status === 409);
  const apPlan = await lau.api(`/api/tasks/${task.id}/phases/plan/approve`, "POST");
  check("aprobar plan v2", apPlan.status === 200 && apPlan.data.phase === "implement");

  // ───────── H6 implement + diff
  section("H6 · implement, guarda de herramientas y diff");
  await lau.api(`/api/tasks/${task.id}/phases/implement/run`, "POST");
  await phaseDone(lau, task.id, "implement", 1);
  det = (await lau.api<TaskDetail>(`/api/tasks/${task.id}`)).data;
  const implSession = det.sessions.find((x) => x.phase === "implement")!;
  const implEvents = (await lau.api<any[]>(`/api/sessions/${implSession.id}/events`)).data.map((e) => ({ ...e, p: JSON.parse(e.payload) }));
  const denied = implEvents.find((e) => e.type === "tool_result" && e.p.is_error && /git push/.test(e.p.content));
  check("`git push` es rechazado por la guarda y queda registrado", !!denied, JSON.stringify(implEvents.filter((e) => e.type === "tool_result").map((e) => e.p.content.slice(0, 60))));
  check("las pruebas del worktree corrieron y pasaron", implEvents.some((e) => e.type === "tool_result" && /4 pass/.test(e.p.content) && /0 fail/.test(e.p.content) && !e.p.is_error));
  check("rateLimit.ts implementado en el worktree", /Retry-After/.test(readFileSync(join(wt, "src/middleware/rateLimit.ts"), "utf8")));
  check("main sigue intacta tras implementar", git(repo, "rev-parse", "main") === mainHead && !readFileSync(join(repo, "src/middleware/rateLimit.ts"), "utf8").includes("Retry-After"));
  const diffRes = (await lau.api<{ diff: string }>(`/api/tasks/${task.id}/diff`)).data.diff;
  check("el diff muestra los archivos de código", diffRes.includes("src/middleware/rateLimit.ts") && diffRes.includes("src/routes/auth.ts") && diffRes.includes("tests/ratelimit.test.ts"));
  check("el diff excluye .flock/", !diffRes.includes(".flock"));
  const fin = await ana.api(`/api/tasks/${task.id}/phases/implement/approve`, "POST");
  check("aprobar implement → tarea done", fin.status === 200 && fin.data.phase === "done");
  const log = git(wt, "log", "--format=%an|%s");
  check("commits de fase firmados por quien aprobó", log.includes("Ana|implement:") && log.includes("Ana|research:") && log.includes("Lautaro|plan:"), log);

  // ───────── H7 abortar, paralelismo y persistencia
  section("H7 · abortar, tareas en paralelo y reinicio del servidor");
  const slow = (await lau.api<Task>("/api/tasks", "POST", { title: "Tarea lenta [lento]", description: "", repoPath: repo })).data;
  lau.ws.send(JSON.stringify({ type: "subscribe", taskId: slow.id }));
  await specAndApprove(lau, ana, slow.id);
  const sl = await lau.api(`/api/tasks/${slow.id}/phases/research/run`, "POST");
  await sleep(300);
  const ab = await ana.api(`/api/sessions/${sl.data.id}/abort`, "POST");
  check("abortar una sesión en curso", ab.status === 200);
  await until(() => lau.msgs.some((m) => m.type === "session.ended" && m.session.id === sl.data.id && m.session.status === "aborted"), "sesión abortada");
  await sleep(100);
  const slowDet = (await lau.api<TaskDetail>(`/api/tasks/${slow.id}`)).data;
  check("tras abortar la fase vuelve a idle y se puede reintentar", slowDet.task.status === "idle" && slowDet.artifacts.filter((a) => a.phase === "research").length === 0);
  const abAgain = await lau.api(`/api/sessions/${sl.data.id}/abort`, "POST");
  check("abortar una sesión terminada → 409", abAgain.status === 409);

  const pa = (await lau.api<Task>("/api/tasks", "POST", { title: "Paralela A", description: "", repoPath: repo })).data;
  const pb = (await ana.api<Task>("/api/tasks", "POST", { title: "Paralela B", description: "", repoPath: repo })).data;
  for (const t of [pa, pb]) {
    lau.ws.send(JSON.stringify({ type: "subscribe", taskId: t.id }));
    await specAndApprove(lau, ana, t.id);
  }
  await sleep(100);
  const from = lau.msgs.length;
  const [ra, rb] = await Promise.all([lau.api(`/api/tasks/${pa.id}/phases/research/run`, "POST"), ana.api(`/api/tasks/${pb.id}/phases/research/run`, "POST")]);
  await until(() => lau.msgs.slice(from).filter((m) => m.type === "session.ended").length >= 2, "dos sesiones en paralelo");
  const evs2 = lau.msgs.slice(from).filter((m) => m.type === "session.event") as Extract<ServerMessage, { type: "session.event" }>[];
  const owner = new Map<string, string>([[ra.data.id, pa.id], [rb.data.id, pb.id]]);
  check("dos tareas corren en paralelo sin mezclar eventos", evs2.length > 10 && evs2.every((m) => owner.get(m.sessionId) === m.taskId), `${evs2.length} eventos`);
  check("cada tarea escribió su propio research.md", existsSync(join(pa.worktree_path!, ".flock", pa.slug, "research.md")) && existsSync(join(pb.worktree_path!, ".flock", pb.slug, "research.md")));

  const before = (await lau.api<TaskDetail>(`/api/tasks/${task.id}`)).data;
  const beforeEvents = (await lau.api<any[]>(`/api/sessions/${before.sessions[0]!.id}/events`)).data.length;
  await stopServer();
  await startServer();
  const after = (await lau.api<TaskDetail>(`/api/tasks/${task.id}`)).data;
  const afterEvents = (await lau.api<any[]>(`/api/sessions/${before.sessions[0]!.id}/events`)).data.length;
  check("reiniciar conserva tareas, artefactos, comentarios, sesiones y eventos", after.task.phase === "done" && after.artifacts.length === before.artifacts.length && after.comments.length === before.comments.length && after.sessions.length === before.sessions.length && afterEvents === beforeEvents && afterEvents > 5);
  check("la lista de tareas sobrevive al reinicio", (await lau.api<Task[]>("/api/tasks")).data.length === 4);

  // ───────── H8 multiusuario
  section("H8 · multiusuario: identidad, presencia, autoría y concurrencia");
  const lau2 = await connect("Lautaro");
  const ana2 = await connect("Ana");
  check("misma identidad al volver a entrar con el mismo nombre", lau2.user.id === lau.user.id && ana2.user.id === ana.user.id);
  check("WebSocket sin token → 401", (await fetch(`${base}/ws`)).status === 401);
  check("token adulterado → 401", (await fetch(`${base}/api/tasks`, { headers: { authorization: `Bearer ${lau.token}x` } })).status === 401);
  for (const c of [lau2, ana2]) c.ws.send(JSON.stringify({ type: "subscribe", taskId: pa.id }));
  await sleep(100);
  lau2.ws.send(JSON.stringify({ type: "presence", taskId: pa.id, tab: "diff" }));
  await until(() => ana2.msgs.some((m) => m.type === "presence.changed" && m.presence.some((p) => p.user_id === lau.user.id && p.tab === "diff")), "presence.changed con la pestaña de Lautaro");
  check("presence.changed muestra quién está en qué pestaña", true);
  const users = (await ana2.api<any[]>("/api/users")).data;
  check("/api/users informa quién está conectado", users.find((u) => u.id === lau.user.id)?.online === true);

  const spoof = await ana2.api<any>(`/api/artifacts/${(await ana2.api<TaskDetail>(`/api/tasks/${pa.id}`)).data.artifacts.find((a) => a.phase === "research")!.id}/comments`, "POST", { quote: "rateLimit", body: "firmado por Ana", author_id: lau.user.id });
  check("el autor sale del token: no se puede falsificar", spoof.status === 200 && spoof.data.author_id === ana2.user.id);

  const [x1, x2] = await Promise.all([lau2.api(`/api/tasks/${pa.id}/phases/research/approve`, "POST"), ana2.api(`/api/tasks/${pa.id}/phases/research/approve`, "POST")]);
  check("dos aprobaciones simultáneas → una sola transición (200 + 409)", [x1.status, x2.status].sort().join() === "200,409", `${x1.status},${x2.status}`);
  const paDet = (await lau2.api<TaskDetail>(`/api/tasks/${pa.id}`)).data;
  check("la tarea avanzó una única fase", paDet.task.phase === "plan" && paDet.artifacts.filter((a) => a.approved).length === 2); // spec + research
  const act = (await lau2.api<any[]>(`/api/tasks/${pa.id}/activity`)).data;
  check("feed de actividad con autor por acción", act.some((a) => a.kind === "phase.run") && act.some((a) => a.kind === "phase.approved") && act.some((a) => a.kind === "comment.created" && a.user_id === ana.user.id));
  check("activity.added llega en vivo", ana2.msgs.some((m) => m.type === "activity.added"));

  // ───────── H9 worktree navegable
  section("H9 · árbol de archivos, visor y seguridad de rutas");
  const tree = (await lau2.api<{ path: string; status: "M" | "A" | null }[]>(`/api/tasks/${task.id}/tree`)).data;
  const st = (p: string) => tree.find((t) => t.path === p)?.status;
  check("el árbol lista los archivos del worktree", tree.some((t) => t.path === "src/http.ts") && tree.some((t) => t.path === "package.json"));
  check("marca M en modificados y A en agregados", st("src/middleware/rateLimit.ts") === "M" && st("tests/ratelimit.test.ts") === "A" && st("src/http.ts") === null);
  check("muestra .flock/<slug>/ con los artefactos de cada fase", tree.some((t) => t.path === `.flock/${task.slug}/research.md`) && tree.some((t) => t.path === `.flock/${task.slug}/plan.md`) && tree.some((t) => t.path === `.flock/${task.slug}/summary.md`));
  check("no lista .git ni node_modules", !tree.some((t) => t.path.startsWith(".git/") || t.path === ".git" || t.path.includes("node_modules")));
  const f = (path: string) => lau2.api<any>(`/api/tasks/${task.id}/file?path=${encodeURIComponent(path)}`);
  const ok = await f("src/middleware/rateLimit.ts");
  check("el visor devuelve el contenido", ok.status === 200 && ok.data.content.includes("Retry-After") && !ok.data.binary);
  check("`../` → 400", (await f("../../../../Windows/win.ini")).status === 400);
  check("barras invertidas → 400", (await f(`..${String.fromCharCode(92)}..${String.fromCharCode(92)}x`)).status === 400);
  check("ruta absoluta → 400", (await f("C:/Windows/win.ini")).status === 400 && (await f("/etc/passwd")).status === 400);
  check(".git/config y .git → 400", (await f(".git/config")).status === 400 && (await f(".git")).status === 400);
  const outside = join(tmp, "afuera");
  Bun.spawnSync(["node", "-e", `require('fs').mkdirSync(${JSON.stringify(outside)});require('fs').writeFileSync(${JSON.stringify(join(outside, "secreto.txt"))},"secreto")`]);
  try {
    symlinkSync(outside, join(wt, "escape"), "junction");
    check("symlink/junction que apunta afuera → 400", (await f("escape/secreto.txt")).status === 400);
  } catch (e) {
    console.log(`  - (omitido) no se pudo crear el enlace simbólico: ${e}`);
  }
  check("archivo inexistente → 404", (await f("nada.txt")).status === 404);
  writeFileSync(join(wt, "grande.txt"), "x".repeat(600 * 1024));
  writeFileSync(join(wt, "bin.dat"), Buffer.from([1, 2, 0, 3, 4]));
  const big = await f("grande.txt");
  check("archivo grande se recorta a 512 KB", big.data.truncated === true && big.data.content.length === 512 * 1024);
  const bin = await f("bin.dat");
  check("binario devuelve solo metadatos", bin.data.binary === true && bin.data.content === null);
  const cm = (await lau2.api<{ subject: string; author: string }[]>(`/api/tasks/${task.id}/commits`)).data;
  check("commits de fase con autor", cm.length === 4 && cm.some((c) => c.subject.startsWith("spec:")) && cm.some((c) => c.subject.startsWith("research:") && c.author === "Ana") && cm.some((c) => c.subject.startsWith("implement:")), JSON.stringify(cm));
  check("worktree.changed se emitió durante la ejecución", lau.msgs.some((m) => m.type === "worktree.changed"));


  // ───────── H10 etapa Spec manual y edición de artefactos
  section("H10 · spec manual y edición de artefactos");
  const ed = (await lau2.api<Task>("/api/tasks", "POST", { title: "Edición [lento]", description: "tarea para probar la edición manual", repoPath: repo })).data;
  lau2.ws.send(JSON.stringify({ type: "subscribe", taskId: ed.id }));
  const run = (c: Client, phase: string, verb: string) => c.api(`/api/tasks/${ed.id}/phases/${phase}/${verb}`, "POST");
  const put = (c: Client, phase: string, content: string, baseVersion: number) => c.api<any>(`/api/tasks/${ed.id}/phases/${phase}/artifact`, "PUT", { content, baseVersion });
  const detail = async () => (await lau2.api<TaskDetail>(`/api/tasks/${ed.id}`)).data;

  check("research antes de la spec → 409", (await run(lau2, "research", "run")).status === 409);
  check("run sobre spec → 400 (no hay agente)", (await run(lau2, "spec", "run")).status === 400);
  check("revise sobre spec → 400", (await run(lau2, "spec", "revise")).status === 400);
  check("aprobar spec sin texto → 409", (await run(ana2, "spec", "approve")).status === 409);
  check("texto vacío → 400", (await put(lau2, "spec", "   ", 0)).status === 400);

  const v1 = await put(lau2, "spec", SPEC, 0);
  check("guardar la spec crea v1 con su autor", v1.status === 200 && v1.data.version === 1 && v1.data.created_by === lau2.user.id);
  check("la spec se escribe en el worktree", readFileSync(join(ed.worktree_path!, ".flock", ed.slug, "spec.md"), "utf8") === SPEC);
  check("tras guardar, la spec queda en awaiting_review", (await detail()).task.status === "awaiting_review");
  const clash = await put(ana2, "spec", SPEC + "\n- otra", 0);
  check("baseVersion viejo → 409 (alguien editó antes)", clash.status === 409, JSON.stringify(clash.data));
  check("sin cambios → 400", (await put(lau2, "spec", SPEC, 1)).status === 400);

  const specArt = (await detail()).artifacts.find((a) => a.phase === "spec")!;
  const keep = await ana2.api<any>(`/api/artifacts/${specArt.id}/comments`, "POST", { quote: "Evitar fuerza bruta", body: "¿y la API pública?" });
  const lose = await ana2.api<any>(`/api/artifacts/${specArt.id}/comments`, "POST", { quote: "rate limiting distribuido", body: "ok" });
  check("se puede comentar la spec", keep.status === 200 && lose.status === 200);
  const edited = SPEC.replace("rate limiting distribuido", "límites por usuario") + "\n- [ ] Documentar el cambio.\n";
  const v2 = await put(ana2, "spec", edited, 1);
  check("otra persona edita → v2 con su autor", v2.status === 200 && v2.data.version === 2 && v2.data.created_by === ana2.user.id);
  const dd = await detail();
  const mc = dd.comments.find((c) => c.id === keep.data.id)!;
  const lc = dd.comments.find((c) => c.id === lose.data.id)!;
  check("el comentario cuya cita sigue en el texto migra a la versión nueva", mc.artifact_id === v2.data.id);
  check("el comentario cuya cita se borró queda en la versión vieja", lc.artifact_id === specArt.id);
  check("la edición queda en el feed de actividad", (await lau2.api<any[]>(`/api/tasks/${ed.id}/activity`)).data.some((a) => a.kind === "artifact.edited"));
  check("artifact.created llega en vivo con la versión editada", ana2.msgs.some((m) => m.type === "artifact.created" && m.artifact.phase === "spec" && m.artifact.version === 2) || lau2.msgs.some((m) => m.type === "artifact.created" && m.artifact.phase === "spec" && m.artifact.version === 2));

  check("aprobar la spec avanza a research", (await run(lau2, "spec", "approve")).status === 200 && (await detail()).task.phase === "research");
  check("la spec aprobada ya no se edita", (await put(lau2, "spec", edited + "x", 2)).status === 409);
  await run(lau2, "research", "run");
  const mid = await put(lau2, "research", "# cambio durante la ejecución", 0);
  check("editar mientras corre una sesión → 409", mid.status === 409, JSON.stringify(mid.data));
  await phaseDone(lau2, ed.id, "research", 1);
  const resText = (await detail()).artifacts.find((a) => a.phase === "research")!.content;
  check("research recibe la spec editada (v2) y no la original", resText.includes("límites por usuario") && !resText.includes("rate limiting distribuido"));
  const r2 = await put(ana2, "research", resText + "\n## Nota de Ana\nRevisar el proxy inverso.\n", 1);
  check("editar el research a mano crea v2 con el autor", r2.status === 200 && r2.data.version === 2 && r2.data.created_by === ana2.user.id);
  check("el texto editado se escribe en el worktree", readFileSync(join(ed.worktree_path!, ".flock", ed.slug, "research.md"), "utf8").includes("Nota de Ana"));
  check("editar una fase que no es la activa → 409", (await put(lau2, "plan", "# x", 0)).status === 409);
  check("editar implement → 400", (await put(lau2, "implement", "# x", 0)).status === 400);
  const apRes = await run(lau2, "research", "approve");
  check("aprobar research editado → commit con el texto nuevo", apRes.status === 200 && git(ed.worktree_path!, "show", "HEAD:.flock/" + ed.slug + "/research.md").includes("Nota de Ana"));
  await run(lau2, "plan", "run");
  await phaseDone(lau2, ed.id, "plan", 1);
  const planV1 = (await detail()).artifacts.find((a) => a.phase === "plan")!;
  const p2 = await put(lau2, "plan", planV1.content + "\n## Rollback\nRevertir el commit.\n", 1);
  check("editar el plan a mano y revisar versiones", p2.status === 200 && (await lau2.api<any[]>(`/api/tasks/${ed.id}/artifacts/plan/versions`)).data.length === 2);

  // ───────── H11 cancelar, reabrir y retroceder
  section("H11 · cancelar, reabrir y retroceder");
  // cancelar con una sesión en curso
  const cx = (await lau2.api<Task>("/api/tasks", "POST", { title: "Cancelable [lento]", description: "", repoPath: repo })).data;
  lau2.ws.send(JSON.stringify({ type: "subscribe", taskId: cx.id }));
  await specAndApprove(lau2, ana2, cx.id);
  const cxRun = await lau2.api(`/api/tasks/${cx.id}/phases/research/run`, "POST");
  await sleep(250);
  check("retroceder con una sesión en curso → 409", (await lau2.api(`/api/tasks/${cx.id}/rewind`, "POST", { to: "spec" })).status === 409);
  const cancel = await ana2.api<Task>(`/api/tasks/${cx.id}/cancel`, "POST");
  check("cancelar corta la sesión en curso", cancel.status === 200 && cancel.data.status === "cancelled");
  await until(() => lau2.msgs.some((m) => m.type === "session.ended" && m.session.id === cxRun.data.id && m.session.status === "aborted"), "sesión abortada por cancelación");
  await sleep(100);
  const cxd = (await lau2.api<TaskDetail>(`/api/tasks/${cx.id}`)).data;
  check("la tarea queda cancelada aunque la sesión termine después", cxd.task.status === "cancelled");
  check("una tarea cancelada no se ejecuta ni se aprueba", (await lau2.api(`/api/tasks/${cx.id}/phases/research/run`, "POST")).status === 409 && (await lau2.api(`/api/tasks/${cx.id}/phases/research/approve`, "POST")).status === 409);
  check("cancelar dos veces → 409", (await lau2.api(`/api/tasks/${cx.id}/cancel`, "POST")).status === 409);
  const reo = await lau2.api<Task>(`/api/tasks/${cx.id}/reopen`, "POST");
  check("reabrir la devuelve a su fase, lista para ejecutarse", reo.status === 200 && reo.data.status === "idle" && reo.data.phase === "research");

  // retroceder: recorrido completo y vuelta atrás
  const rt = (await lau2.api<Task>("/api/tasks", "POST", { title: "Retroceder", description: "", repoPath: repo })).data;
  const rwt = rt.worktree_path!;
  lau2.ws.send(JSON.stringify({ type: "subscribe", taskId: rt.id }));
  await specAndApprove(lau2, ana2, rt.id);
  for (const p of ["research", "plan"]) {
    await lau2.api(`/api/tasks/${rt.id}/phases/${p}/run`, "POST");
    await phaseDone(lau2, rt.id, p, 1);
    await ana2.api(`/api/tasks/${rt.id}/phases/${p}/approve`, "POST");
  }
  await lau2.api(`/api/tasks/${rt.id}/phases/implement/run`, "POST");
  await phaseDone(lau2, rt.id, "implement", 1);
  const changedRl = () => readFileSync(join(rwt, "src/middleware/rateLimit.ts"), "utf8").includes("Retry-After");
  check("implement dejó cambios en el worktree", changedRl() && existsSync(join(rwt, "tests/ratelimit.test.ts")));
  const redo = await lau2.api<Task>(`/api/tasks/${rt.id}/rewind`, "POST", { to: "implement" });
  check("rehacer implement: descarta el código sin aprobar y vuelve a idle", redo.status === 200 && redo.data.status === "idle" && !changedRl() && !existsSync(join(rwt, "tests/ratelimit.test.ts")));
  await lau2.api(`/api/tasks/${rt.id}/phases/implement/run`, "POST");
  await phaseDone(lau2, rt.id, "implement", 2);
  await ana2.api(`/api/tasks/${rt.id}/phases/implement/approve`, "POST");
  check("se reimplementó y la tarea terminó", (await lau2.api<TaskDetail>(`/api/tasks/${rt.id}`)).data.task.phase === "done" && changedRl());

  const back = await ana2.api<Task>(`/api/tasks/${rt.id}/rewind`, "POST", { to: "plan" });
  check("volver de done a plan", back.status === 200 && back.data.phase === "plan" && back.data.status === "awaiting_review");
  check("el worktree vuelve al estado del plan aprobado", !changedRl() && !existsSync(join(rwt, "tests/ratelimit.test.ts")) && !existsSync(join(rwt, ".flock", rt.slug, "summary.md")) && existsSync(join(rwt, ".flock", rt.slug, "plan.md")));
  const log2 = git(rwt, "log", "--format=%s");
  check("los commits posteriores al plan se descartan de la rama", log2.includes("plan:") && !log2.includes("implement:"), log2);
  const rtd = (await lau2.api<TaskDetail>(`/api/tasks/${rt.id}`)).data;
  check("plan e implement quedan sin aprobar; spec y research siguen aprobadas", rtd.artifacts.filter((a) => a.phase === "plan" || a.phase === "implement").every((a) => !a.approved) && rtd.artifacts.filter((a) => a.phase === "spec" || a.phase === "research").some((a) => a.approved));
  check("las versiones anteriores quedan en el historial", rtd.artifacts.filter((a) => a.phase === "implement").length === 2);
  check("no se puede retroceder hacia adelante", (await lau2.api(`/api/tasks/${rt.id}/rewind`, "POST", { to: "implement" })).status === 409);
  const edPlan = await lau2.api<any>(`/api/tasks/${rt.id}/phases/plan/artifact`, "PUT", { content: rtd.artifacts.filter((a) => a.phase === "plan").at(-1)!.content + "\n## Nota\nCambio tras retroceder.\n", baseVersion: rtd.artifacts.filter((a) => a.phase === "plan").length });
  check("tras retroceder se puede editar el plan y volver a aprobarlo", edPlan.status === 200 && (await lau2.api(`/api/tasks/${rt.id}/phases/plan/approve`, "POST")).status === 200);
  const toSpec = await lau2.api<Task>(`/api/tasks/${rt.id}/rewind`, "POST", { to: "spec" });
  check("volver hasta la spec", toSpec.status === 200 && toSpec.data.phase === "spec" && toSpec.data.status === "awaiting_review" && !existsSync(join(rwt, ".flock", rt.slug, "research.md")));
  check("retroceder queda en el feed de actividad", (await lau2.api<any[]>(`/api/tasks/${rt.id}/activity`)).data.some((a) => a.kind === "phase.rewound"));

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
