import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { resolveInside } from "./files";
import type { PhaseName } from "../shared/types";
import { PHASE_DEFS } from "../shared/workflows";

// Guarda de herramientas (§5). La usan el agente mock, el canUseTool del SDK real y su hook PreToolUse:
// el hook corre antes de TODA herramienta (también las de solo lectura, que canUseTool nunca ve).
/** Herramientas por fase, del catálogo de flujos (H12). */
export const TOOLS = Object.fromEntries(Object.values(PHASE_DEFS).map((d) => [d.id, d.tools])) as Record<PhaseName, string[]>;

/** Extensiones que se pueden escribir en .flock/<slug>/: documentos, diagramas y mockups (H14). */
const FLOCK_EXT = [".md", ".html", ".svg", ".mmd"];

/**
 * Bash por lista blanca: el comando debe ser exactamente uno de estos (más argumentos simples).
 * Una lista negra por regex se evade fácil (`git -c x push`, `sh -c "git pu""sh"`). Configurable con BASH_ALLOW.
 */
export const BASH_ALLOW = (
  process.env.BASH_ALLOW ??
  "bun test,bun run test,npm test,npm run test,node --test,pnpm test,yarn test,npx vitest run,npx jest,pytest,go test,cargo test,git status,git diff,git log,git show,ls"
)
  .split(",")
  .map((c) => c.trim().replace(/\s+/g, " "))
  .filter(Boolean);

// Encadenar, redirigir, sustituir o expandir abre la puerta a cualquier otro comando
const SHELL_META = /[;&|`$<>(){}\n\r\\*?!~]/;

export interface GuardCtx {
  phase: PhaseName;
  slug: string;
  worktree: string;
}
export type GuardResult = { ok: true } | { ok: false; reason: string };

const deny = (reason: string): GuardResult => ({ ok: false, reason });

/** Una ruta opcional que da el modelo (Read/Grep/Glob/Write/Edit) tiene que caer dentro del worktree. */
function insideWorktree(ctx: GuardCtx, p: unknown): boolean {
  if (p === undefined || p === null || p === "") return true; // sin ruta = el cwd, que es el worktree
  return resolveInside(ctx.worktree, String(p), { allowAbsolute: true }) !== null;
}

function checkBash(command: string): GuardResult {
  const cmd = command.trim().replace(/\s+/g, " ");
  if (!cmd) return deny("Comando vacío");
  if (SHELL_META.test(cmd)) return deny("No se permiten operadores de shell (;, &&, |, >, $, `, comodines…): ejecutá un comando por vez");
  const base = BASH_ALLOW.find((a) => cmd === a || cmd.startsWith(`${a} `));
  if (!base) return deny(`Comando no permitido: "${cmd}". Permitidos: ${BASH_ALLOW.join(", ")}`);
  for (const arg of cmd.slice(base.length).split(" ").filter(Boolean)) {
    if (arg.includes("..") || isAbsolute(arg) || /^[a-z]:/i.test(arg)) return deny(`Argumento fuera del worktree: ${arg}`);
    if (/^--?(output|o)(=|$)/i.test(arg) || /^--(exec|upload-pack|receive-pack|config|git-dir|work-tree)/i.test(arg)) return deny(`Argumento no permitido: ${arg}`);
  }
  return { ok: true };
}

/** Herramientas internas del SDK sin efectos (p. ej. la que entrega la salida estructurada de `outputFormat`). */
const SDK_INTERNAL = new Set(["StructuredOutput"]);

export function checkTool(ctx: GuardCtx, tool: string, input: Record<string, unknown>): GuardResult {
  if (SDK_INTERNAL.has(tool)) return { ok: true };
  if (!TOOLS[ctx.phase].includes(tool)) return deny(`La herramienta ${tool} no está permitida en ${ctx.phase}`);

  switch (tool) {
    case "Read":
      if (!insideWorktree(ctx, input.file_path)) return deny(`Lectura fuera del worktree: ${input.file_path}`);
      break;
    case "Grep":
      if (!insideWorktree(ctx, input.path)) return deny(`Búsqueda fuera del worktree: ${input.path}`);
      break;
    case "Glob": {
      if (!insideWorktree(ctx, input.path)) return deny(`Búsqueda fuera del worktree: ${input.path}`);
      const pattern = String(input.pattern ?? "");
      if (isAbsolute(pattern) || /^[a-z]:/i.test(pattern) || pattern.split(/[\\/]/).includes("..")) return deny(`Patrón fuera del worktree: ${pattern}`);
      break;
    }
    case "Write":
    case "Edit": {
      const target = String(input.file_path ?? input.path ?? "");
      const full = resolveInside(ctx.worktree, target, { allowAbsolute: true });
      if (!full) return deny(`Escritura fuera del worktree: ${target}`);
      const flockDir = resolve(join(ctx.worktree, ".flock"));
      const inFlock = full.startsWith(flockDir + sep);
      if (!PHASE_DEFS[ctx.phase].code) {
        const allowed = resolve(join(ctx.worktree, ".flock", ctx.slug));
        if (full !== allowed && !full.startsWith(allowed + sep)) return deny(`En ${ctx.phase} solo se puede escribir en .flock/${ctx.slug}/`);
      }
      if (inFlock && !FLOCK_EXT.includes(extname(full).toLowerCase())) return deny(`En .flock/ solo se escriben ${FLOCK_EXT.join(", ")}`);
      break;
    }
    case "Bash":
      return checkBash(String(input.command ?? ""));
  }
  return { ok: true };
}
