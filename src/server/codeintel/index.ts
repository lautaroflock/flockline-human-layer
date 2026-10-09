import { statSync } from "node:fs";
import * as git from "../git";
import { resolveInside } from "../files";
import { HttpError } from "../http";
import type { ChangeContext, ChangedSymbol, CodeLoc, SymbolContext, Task } from "../../shared/types";
import { LIMITS, posix, type Changed } from "./common";
import { TextEngine, TEXT_EXT } from "./text";
import { innermost, TsEngine, TS_EXT } from "./ts";

// Contexto del cambio (H16): por cada función tocada en el diff, qué llama (hacia abajo) y quién la llama (hacia arriba).

interface Engines {
  root: string;
  changed: Changed;
  ts: () => TsEngine;
  text: () => TextEngine;
}

async function engines(task: Task): Promise<Engines> {
  const wt = task.worktree_path!;
  const root = posix(wt).replace(/\/+$/, "");
  const changed = await git.changedLines(wt, task.base_commit!);
  const files = (await git.git(wt, ["ls-files", "-co", "--exclude-standard"])).out
    .split("\n")
    .filter((f) => f && !f.startsWith(".flock/") && !f.includes("node_modules/"))
    .filter((f) => {
      try {
        return statSync(`${root}/${f}`).size <= LIMITS.fileBytes;
      } catch {
        return false;
      }
    })
    .slice(0, LIMITS.files);
  let tsE: TsEngine | null = null;
  let textE: TextEngine | null = null;
  return {
    root,
    changed,
    ts: () => (tsE ??= new TsEngine(root, files.filter((f) => TS_EXT.test(f)).map((f) => `${root}/${f}`), changed)),
    text: () => (textE ??= new TextEngine(root, files.filter((f) => TEXT_EXT.test(f)), changed)),
  };
}

const pick = (e: Engines, file: string) => (TS_EXT.test(file) ? { engine: e.ts(), precision: "lsp" as const } : TEXT_EXT.test(file) ? { engine: e.text(), precision: "text" as const } : null);

export async function changeContext(task: Task): Promise<ChangeContext> {
  const e = await engines(task);
  const symbols: ChangedSymbol[] = [];
  let truncated = false;
  const used = new Set<string>();

  for (const [file, { status, lines }] of e.changed) {
    const p = pick(e, file);
    if (!p) continue;
    used.add(p.precision === "lsp" ? "typescript" : "texto");
    const fns = p.engine.functions(file);
    // Agrupar las líneas cambiadas por la función con nombre más interna que las contiene
    const groups = new Map<string, { fn: (typeof fns)[number] | null; lines: number[] }>();
    for (const l of [...lines].sort((a, b) => a - b)) {
      const fn = innermost(fns, l);
      const key = fn ? `${fn.line}:${fn.col}` : "module";
      if (!groups.has(key)) groups.set(key, { fn, lines: [] });
      groups.get(key)!.lines.push(l);
    }
    for (const { fn, lines: ls } of groups.values()) {
      if (symbols.length >= LIMITS.symbols) {
        truncated = true;
        break;
      }
      const set = new Set(ls);
      const from = fn?.start ?? 1;
      const to = fn?.end ?? Number.MAX_SAFE_INTEGER;
      const callees = p.engine.callees(file, from, to, set);
      // Cambios sueltos a nivel de módulo sin llamadas (imports, tipos) no aportan contexto
      if (!fn && callees.length === 0) continue;
      symbols.push({
        file, status, precision: p.precision, changedLines: ls,
        name: fn?.name ?? "(nivel de módulo)", kind: fn?.kind ?? "módulo",
        line: fn?.line ?? ls[0]!, col: fn?.col ?? 1,
        callees,
        // Un callback anónimo no tiene llamadores propios (buscarlos daría las llamadas a test/describe/etc.)
        callers: fn && fn.kind !== "callback" ? p.engine.callers({ file, line: fn.line, col: fn.col }) : [],
      });
    }
  }
  return { engine: [...used].join(" + ") || "—", symbols, truncated };
}

export async function symbolContext(task: Task, loc: CodeLoc): Promise<SymbolContext> {
  if (!resolveInside(task.worktree_path!, loc.file)) throw new HttpError(400, "Ruta fuera del worktree");
  if (!Number.isInteger(loc.line) || loc.line < 1 || !Number.isInteger(loc.col) || loc.col < 1) throw new HttpError(400, "Posición inválida");
  const e = await engines(task);
  const p = pick(e, loc.file);
  if (!p) throw new HttpError(400, "Lenguaje no soportado para navegar");
  const r = p.engine.symbolAt(loc);
  if (!r) throw new HttpError(404, "No se encontró un símbolo en esa posición");
  return { ...r, precision: p.precision };
}
