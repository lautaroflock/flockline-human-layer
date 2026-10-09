import { join, resolve } from "node:path";
import { resolveInside } from "./files";
import type { PhaseName } from "../shared/types";

// Guarda de herramientas (§5): el mismo chequeo lo usa canUseTool del SDK real y el agente mock.
export const TOOLS: Record<PhaseName, string[]> = {
  research: ["Read", "Grep", "Glob", "Write"],
  plan: ["Read", "Grep", "Glob", "Write"],
  implement: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
};

const BASH_DENY: [RegExp, string][] = [
  [/\bgit\s+push\b/i, "git push está prohibido"],
  [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(\s|$)/i, "rm -rf / está prohibido"],
  [/\/mnt\//i, "acceder a /mnt/ está prohibido"],
];

export interface GuardCtx {
  phase: PhaseName;
  slug: string;
  worktree: string;
}
export type GuardResult = { ok: true } | { ok: false; reason: string };

export function checkTool(ctx: GuardCtx, tool: string, input: Record<string, unknown>): GuardResult {
  if (!TOOLS[ctx.phase].includes(tool)) return { ok: false, reason: `La herramienta ${tool} no está permitida en ${ctx.phase}` };

  if (tool === "Write" || tool === "Edit") {
    const target = String(input.file_path ?? input.path ?? "");
    const full = resolveInside(ctx.worktree, target, { allowAbsolute: true });
    if (!full) return { ok: false, reason: `Escritura fuera del worktree: ${target}` };
    if (ctx.phase !== "implement") {
      const allowed = resolve(join(ctx.worktree, ".flock", ctx.slug));
      if (full !== allowed && !full.startsWith(allowed + "\\") && !full.startsWith(allowed + "/")) {
        return { ok: false, reason: `En ${ctx.phase} solo se puede escribir en .flock/${ctx.slug}/` };
      }
    }
  }

  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    for (const [re, why] of BASH_DENY) if (re.test(cmd)) return { ok: false, reason: why };
  }
  return { ok: true };
}
