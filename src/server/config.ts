import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;
const root = join(import.meta.dir, "..", "..");

export const config = {
  root,
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? "127.0.0.1",
  publicUrl: env.PUBLIC_URL ?? "",
  dbPath: env.DB_PATH ?? join(root, "data", "flockline.db"),
  worktreesDir: env.WORKTREES_DIR ?? join(homedir(), ".flockline", "worktrees"),
  agentMode: (env.AGENT_MODE === "mock" ? "mock" : "real") as "mock" | "real", // default real (H17); el e2e y la demo piden mock
  claudeModel: env.CLAUDE_MODEL || undefined,
  mockDelayMs: Number(env.MOCK_DELAY_MS ?? 450),
  sessionSecret: env.SESSION_SECRET ?? "flockline-dev-secret-cambiar",
  maxFileBytes: 512 * 1024,
};
