import type { CodeLoc } from "../../shared/types";

export const LIMITS = { symbols: 30, callees: 15, callers: 20, files: 2000, fileBytes: 512 * 1024, snippetLines: 40 };

/** Líneas cambiadas por archivo (lado nuevo del diff). */
export type Changed = Map<string, { status: "M" | "A"; lines: Set<number> }>;

/** Una función con nombre y el rango de líneas que ocupa; `line/col` apuntan a su nombre. */
export interface FnSpan extends CodeLoc {
  name: string;
  kind: string;
  start: number;
  end: number;
}

export const posix = (p: string) => p.replace(/\\/g, "/");

export function snippetAround(lines: string[], line: number, radius: number): { text: string; start: number } {
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  return { text: lines.slice(start - 1, end).join("\n"), start };
}
