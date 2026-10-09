import ts from "ts-api";
import { existsSync, readFileSync } from "node:fs";
import type { CodeLoc, CodeRef } from "../../shared/types";
import { LIMITS, posix, snippetAround, type Changed, type FnSpan } from "./common";

// Motor exacto para TS/JS (H16): el LanguageService de TypeScript, el mismo motor que usan tsserver y el LSP de TS.
export const TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

export class TsEngine {
  private readonly service: ts.LanguageService;
  private readonly program: ts.Program;

  /** `root` y `files` en rutas absolutas con "/" (las que usa TypeScript). */
  constructor(private readonly root: string, private readonly files: string[], private readonly changed: Changed) {
    const options: ts.CompilerOptions = {
      allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, types: [],
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX, allowImportingTsExtensions: true,
    };
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => files,
      getScriptVersion: () => "1",
      getScriptSnapshot: (f) => (existsSync(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8")) : undefined),
      getCurrentDirectory: () => root,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    this.program = this.service.getProgram()!;
  }

  private abs = (rel: string) => `${this.root}/${rel}`;
  private rel = (abs: string) => posix(abs).slice(this.root.length + 1);
  private inRepo = (abs: string) => {
    const p = posix(abs);
    return p.startsWith(this.root + "/") && !p.includes("/node_modules/") && !p.includes("/.flock/");
  };
  private sf = (rel: string) => this.program.getSourceFile(this.abs(rel));
  private lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  private locOf(sf: ts.SourceFile, node: ts.Node): CodeLoc {
    const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { file: this.rel(sf.fileName), line: lc.line + 1, col: lc.character + 1 };
  }
  private isChanged = (rel: string, from: number, to: number) => {
    const set = this.changed.get(rel)?.lines;
    if (!set) return false;
    for (let l = from; l <= to; l++) if (set.has(l)) return true;
    return false;
  };

  /** Funciones con nombre del archivo (declaraciones, métodos y arrows/function expressions asignadas). */
  functions(rel: string): FnSpan[] {
    const sf = this.sf(rel);
    if (!sf) return [];
    const out: FnSpan[] = [];
    const visit = (node: ts.Node, owner: string | null) => {
      let name: ts.Node | null = null;
      let kind = "";
      let body: ts.Node = node;
      let nextOwner = owner;
      if (ts.isFunctionDeclaration(node) && node.name) (name = node.name), (kind = "función");
      else if (ts.isClassDeclaration(node) && node.name) {
        (name = node.name), (kind = "clase"), (nextOwner = node.name.text);
      } else if ((ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && node.name) (name = node.name), (kind = "método");
      else if (ts.isConstructorDeclaration(node)) {
        kind = "constructor";
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        (name = node.name), (kind = "función"), (body = node.parent?.parent && ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node);
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isVariableStatement(node.parent?.parent) && ts.isSourceFile(node.parent.parent.parent)) {
        // Constante de primer nivel (p. ej. `export const loginRoute = compose([...])`): también es un símbolo con llamadores
        (name = node.name), (kind = "constante"), (body = node.parent.parent);
      } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isCallExpression(node.parent) && node.parent.arguments.includes(node as ts.Expression)) {
        // Callback anónimo pasado a una llamada (p. ej. `test("…", () => …)`): se nombra por la llamada
        const call = node.parent;
        const first = call.arguments[0];
        const arg = first && first !== node ? first.getText(sf).replace(/\s+/g, " ") : "";
        const label = `${call.expression.getText(sf)}(${arg.length > 48 ? `${arg.slice(0, 48)}…` : arg})`;
        out.push({ name: label, kind: "callback", start: this.lineOf(sf, call.getStart(sf)), end: this.lineOf(sf, call.getEnd()), ...this.locOf(sf, call) });
      }
      if (kind && (name || kind === "constructor")) {
        const label = kind === "constructor" ? `${owner ?? "?"}.constructor` : owner && kind === "método" ? `${owner}.${name!.getText(sf)}` : name!.getText(sf);
        const anchor = name ?? node;
        out.push({ name: label, kind, start: this.lineOf(sf, body.getStart(sf)), end: this.lineOf(sf, body.getEnd()), ...this.locOf(sf, anchor) });
      }
      ts.forEachChild(node, (c) => visit(c, nextOwner));
    };
    visit(sf, null);
    return out;
  }

  /** El nodo de declaración más chico que contiene `pos` (para mostrar el cuerpo de una definición). */
  private declarationAt(sf: ts.SourceFile, pos: number): ts.Node | null {
    let best: ts.Node | null = null;
    const isDecl = (n: ts.Node) =>
      ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isMethodDeclaration(n) || ts.isVariableStatement(n) ||
      ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n);
    const visit = (n: ts.Node) => {
      if (pos < n.getStart(sf) || pos >= n.getEnd()) return;
      if (isDecl(n)) best = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return best;
  }

  /** Definición (en el repo) del identificador en `pos`, como CodeRef con su cuerpo. */
  private definitionRef(fileAbs: string, pos: number, fallbackName: string): CodeRef | null {
    const defs = this.service.getDefinitionAtPosition(fileAbs, pos) ?? [];
    const d = defs.find((x) => this.inRepo(x.fileName));
    if (!d) return null;
    const sf = this.program.getSourceFile(d.fileName);
    if (!sf) return null;
    const decl = this.declarationAt(sf, d.textSpan.start);
    const node = decl ?? null;
    const from = node ? this.lineOf(sf, node.getStart(sf)) : this.lineOf(sf, d.textSpan.start);
    const to = node ? this.lineOf(sf, node.getEnd()) : from;
    const lines = sf.text.split(/\r?\n/);
    const last = Math.min(to, from + LIMITS.snippetLines - 1);
    const lc = sf.getLineAndCharacterOfPosition(d.textSpan.start);
    const loc = { file: this.rel(d.fileName), line: lc.line + 1, col: lc.character + 1 };
    return {
      ...loc,
      name: d.name || fallbackName,
      kind: kindLabel(d.kind),
      snippet: lines.slice(from - 1, last).join("\n") + (last < to ? "\n…" : ""),
      snippetStart: from,
      highlight: [loc.line],
      changed: this.isChanged(loc.file, from, to),
      expand: loc,
    };
  }

  /** Hacia abajo: llamadas y `new` cuyo inicio cae en `lines` (o en todo el rango si `lines` es null). */
  callees(rel: string, from: number, to: number, lines: Set<number> | null): CodeRef[] {
    const sf = this.sf(rel);
    if (!sf) return [];
    const seen = new Set<string>();
    const out: CodeRef[] = [];
    const visit = (n: ts.Node) => {
      if (out.length >= LIMITS.callees) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const line = this.lineOf(sf, n.getStart(sf));
        const inScope = line >= from && line <= to && (!lines || lines.has(line));
        if (inScope) {
          const target = n.expression;
          const nameNode = ts.isPropertyAccessExpression(target) ? target.name : ts.isIdentifier(target) ? target : null;
          if (nameNode) {
            const ref = this.definitionRef(sf.fileName, nameNode.getStart(sf), nameNode.getText(sf));
            const key = ref && `${ref.file}:${ref.line}`;
            // Parámetros y variables locales de la propia función no son "lo que llama": son ruido para la revisión
            const local = ref && ref.file === rel && to !== Number.MAX_SAFE_INTEGER && ref.line >= from && ref.line <= to;
            if (ref && key && !seen.has(key) && !local && ref.kind !== "parameter") {
              seen.add(key);
              out.push(ref);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }

  /** Hacia arriba: referencias al símbolo cuyo nombre está en `loc` (sin la declaración ni los import). */
  callers(loc: CodeLoc): CodeRef[] {
    const sf = this.sf(loc.file);
    if (!sf) return [];
    const pos = sf.getPositionOfLineAndCharacter(loc.line - 1, loc.col - 1);
    const groups = this.service.findReferences(sf.fileName, pos) ?? [];
    const out: CodeRef[] = [];
    for (const g of groups) {
      for (const r of g.references) {
        if (out.length >= LIMITS.callers) return out;
        if (r.isDefinition || !this.inRepo(r.fileName)) continue;
        const rsf = this.program.getSourceFile(r.fileName);
        if (!rsf) continue;
        const lc = rsf.getLineAndCharacterOfPosition(r.textSpan.start);
        const line = lc.line + 1;
        const lines = rsf.text.split(/\r?\n/);
        const text = lines[line - 1] ?? "";
        if (/^\s*(import\b|export\s*\{)/.test(text)) continue;
        const rel = this.rel(r.fileName);
        const enclosing = innermost(this.functions(rel), line);
        const snip = snippetAround(lines, line, 2);
        out.push({
          file: rel, line, col: lc.character + 1,
          name: enclosing?.name ?? "(nivel de módulo)",
          kind: enclosing?.kind ?? "módulo",
          snippet: snip.text, snippetStart: snip.start, highlight: [line],
          changed: this.isChanged(rel, line, line),
          expand: enclosing && enclosing.kind !== "callback" ? { file: rel, line: enclosing.line, col: enclosing.col } : null,
        });
      }
    }
    return out;
  }

  /** Contexto completo de un símbolo (para "Expandir"): su definición, todo lo que llama y quién lo llama. */
  symbolAt(loc: CodeLoc): { symbol: CodeRef; callees: CodeRef[]; callers: CodeRef[] } | null {
    const sf = this.sf(loc.file);
    if (!sf) return null;
    const pos = sf.getPositionOfLineAndCharacter(loc.line - 1, Math.max(0, loc.col - 1));
    const symbol = this.definitionRef(sf.fileName, pos, "?");
    if (!symbol) return null;
    const fn = this.functions(symbol.file).find((f) => f.line === symbol.line && f.col === symbol.col) ?? innermost(this.functions(symbol.file), symbol.line);
    const callees = fn ? this.callees(symbol.file, fn.start, fn.end, null).filter((c) => !(c.file === symbol.file && c.line === symbol.line)) : [];
    return { symbol, callees, callers: this.callers({ file: symbol.file, line: symbol.line, col: symbol.col }) };
  }
}

/** Función con nombre más interna que contiene la línea; un callback anónimo solo si no hay ninguna con nombre. */
export const innermost = (fns: FnSpan[], line: number) => {
  const containing = fns.filter((f) => f.kind !== "clase" && f.start <= line && line <= f.end).sort((a, b) => a.end - a.start - (b.end - b.start));
  return containing.find((f) => f.kind !== "callback") ?? containing[0] ?? null;
};

function kindLabel(k: ts.ScriptElementKind): string {
  const map: Record<string, string> = {
    function: "función", method: "método", class: "clase", constructor: "constructor", const: "constante", let: "variable",
    var: "variable", interface: "interfaz", type: "tipo", property: "propiedad", "local function": "función",
  };
  return map[k] ?? k;
}
