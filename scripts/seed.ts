// Prepara la demo: crea el repo de ejemplo y la tarea "rate limiting en /login" contra un servidor en marcha.
// Uso: bun run seed   (con `bun run dev` corriendo en otra terminal)
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDemoRepo } from "./demoRepo";

const base = process.env.FLOCKLINE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const name = process.env.SEED_USER ?? "Lautaro";
const repo = await ensureDemoRepo(process.env.DEMO_REPO ?? join(homedir(), ".flockline", "demo-api"));
console.log(`Repo de ejemplo: ${repo}`);

const post = async (path: string, body: unknown, token?: string) => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`${path}: ${data.error ?? res.status}`);
  return data;
};

const { token } = await post("/api/session", { name });
const task = await post(
  "/api/tasks",
  { title: "Agregar rate limiting por IP al endpoint /login", description: "Limitar a 5 intentos por minuto por IP; responder 429 con Retry-After.", repoPath: repo },
  token,
);
console.log(`Tarea creada: ${task.title}\nRama: ${task.branch}\nWorktree: ${task.worktree_path}\nAbrí ${base}/?task=${task.id}`);
