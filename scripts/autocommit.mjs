// Hook PostToolUse (Write|Edit): commitea en el repo de flockline cada archivo que Claude implementa.
// Nunca bloquea: ante cualquier error sale con código 0.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const file = input?.tool_input?.file_path;
  if (!file) process.exit(0);
  const abs = resolve(file);
  if (abs !== repo && !abs.startsWith(repo + sep)) process.exit(0); // fuera del repo
  const rel = relative(repo, abs).split(sep).join("/");
  if (rel.startsWith(".git/")) process.exit(0);

  git("add", "-A");
  if (git("status", "--porcelain") === "") process.exit(0); // nada que commitear

  const marker = resolve(repo, "specs", ".current");
  const hito = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
  const subject = `${hito ? `${hito}: ` : ""}${input.tool_name === "Write" ? "write" : "edit"} ${rel}`;
  git("commit", "-q", "-m", subject, "-m", "Commit automático del hook de Claude Code.\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>");
} catch {
  /* el hook no debe romper el flujo */
}
process.exit(0);
