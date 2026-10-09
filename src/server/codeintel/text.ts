import { readFileSync } from "node:fs";
import type { CodeLoc, CodeRef } from "../../shared/types";
import { LIMITS, snippetAround, type Changed, type FnSpan } from "./common";

// Motor aproximado por búsqueda de texto (H16), para lenguajes sin motor exacto. La UI lo marca "aproximado".
export const TEXT_EXT = /\.(py|go|java|cs|rb|php|rs|kt|kts|swift|c|cc|cpp|h|hpp|scala|dart|lua)$/i;

const DEF = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, // Python
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, // Go
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, // Rust
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, // JS-like
  /^\s*(?:public|private|protected|internal)\s[^=;(]*?\b([A-Za-z_]\w*)\s*\(/, // Java / C# / Kotlin con modificador
  /^\s*(?:fun|def)\s+([A-Za-z_]\w*)/, // Kotlin / Ruby / Scala
];
const KEYWORDS = new Set(["if", "for", "while", "switch", "return", "catch", "print", "len", "range", "super", "new", "func", "function", "def", "fn", "elif", "match", "with", "assert", "typeof", "sizeof", "await"]);

export class TextEngine {
  private cache = new Map<string, string[]>();
  constructor(private readonly root: string, private readonly files: string[], private readonly changed: Changed) {}

  private lines(rel: string): string[] {
    let l = this.cache.get(rel);
    if (!l) {
      try {
        l = readFileSync(`${this.root}/${rel}`, "utf8").split(/\r?\n/);
      } catch {
        l = [];
      }
      this.cache.set(rel, l);
    }
    return l;
  }

  functions(rel: string): FnSpan[] {
    const lines = this.lines(rel);
    const out: FnSpan[] = [];
    lines.forEach((text, i) => {
      for (const re of DEF) {
        const m = re.exec(text);
        if (!m?.[1]) continue;
        out.push({ name: m[1], kind: "función", file: rel, line: i + 1, col: text.indexOf(m[1]) + 1, start: i + 1, end: this.endOf(lines, i) });
        break;
      }
    });
    return out;
  }

  /** Fin de un bloque: por llaves si las hay; si no, por indentación (Python). */
  private endOf(lines: string[], i: number): number {
    const head = lines[i]!;
    if (/[{]\s*$/.test(head) || lines[i + 1]?.trim() === "{") {
      let depth = 0;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]!) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
        if (depth <= 0 && j > i) return j + 1;
      }
      return lines.length;
    }
    const indent = head.length - head.trimStart().length;
    let last = i + 1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!;
      if (!t.trim()) continue;
      if (t.length - t.trimStart().length <= indent) break;
      last = j + 1;
    }
    return last;
  }

  private isChanged = (rel: string, from: number, to: number) => {
    const set = this.changed.get(rel)?.lines;
    if (!set) return false;
    for (let l = from; l <= to; l++) if (set.has(l)) return true;
    return false;
  };

  private definition(name: string, prefer: string): CodeRef | null {
    const order = [prefer, ...this.files.filter((f) => f !== prefer)];
    for (const f of order) {
      const fn = this.functions(f).find((x) => x.name === name);
      if (!fn) continue;
      const lines = this.lines(f);
      const last = Math.min(fn.end, fn.start + LIMITS.snippetLines - 1);
      return {
        file: f, line: fn.line, col: fn.col, name, kind: fn.kind,
        snippet: lines.slice(fn.start - 1, last).join("\n") + (last < fn.end ? "\n…" : ""),
        snippetStart: fn.start, highlight: [fn.line], changed: this.isChanged(f, fn.start, fn.end),
        expand: { file: f, line: fn.line, col: fn.col },
      };
    }
    return null;
  }

  callees(rel: string, from: number, to: number, only: Set<number> | null): CodeRef[] {
    const lines = this.lines(rel);
    const out: CodeRef[] = [];
    const seen = new Set<string>();
    for (let l = from; l <= Math.min(to, lines.length); l++) {
      if (only && !only.has(l)) continue;
      for (const m of lines[l - 1]!.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
        const name = m[1]!;
        if (KEYWORDS.has(name) || seen.has(name) || out.length >= LIMITS.callees) continue;
        seen.add(name);
        const def = this.definition(name, rel);
        if (def && !(def.file === rel && def.line === l)) out.push(def);
      }
    }
    return out;
  }

  callers(loc: CodeLoc): CodeRef[] {
    const name = (this.lines(loc.file)[loc.line - 1] ?? "").slice(loc.col - 1).match(/^[A-Za-z_]\w*/)?.[0];
    if (!name) return [];
    const re = new RegExp(`\\b${name}\\s*\\(`);
    const out: CodeRef[] = [];
    for (const f of this.files) {
      const lines = this.lines(f);
      const fns = this.functions(f);
      lines.forEach((text, i) => {
        if (out.length >= LIMITS.callers || !re.test(text)) return;
        if (f === loc.file && i + 1 === loc.line) return; // la propia definición
        if (DEF.some((d) => d.exec(text)?.[1] === name)) return;
        const enclosing = fns.filter((x) => x.start <= i + 1 && i + 1 <= x.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
        const snip = snippetAround(lines, i + 1, 2);
        out.push({
          file: f, line: i + 1, col: text.search(re) + 1, name: enclosing?.name ?? "(nivel de módulo)", kind: enclosing ? "función" : "módulo",
          snippet: snip.text, snippetStart: snip.start, highlight: [i + 1], changed: this.isChanged(f, i + 1, i + 1),
          expand: enclosing ? { file: f, line: enclosing.line, col: enclosing.col } : null,
        });
      });
    }
    return out;
  }

  symbolAt(loc: CodeLoc): { symbol: CodeRef; callees: CodeRef[]; callers: CodeRef[] } | null {
    const fn = this.functions(loc.file).find((f) => f.line === loc.line) ?? this.functions(loc.file).filter((f) => f.start <= loc.line && loc.line <= f.end)[0];
    if (!fn) return null;
    const symbol = this.definition(fn.name, loc.file);
    if (!symbol) return null;
    return { symbol, callees: this.callees(loc.file, fn.start + 1, fn.end, null), callers: this.callers({ file: fn.file, line: fn.line, col: fn.col }) };
  }
}
