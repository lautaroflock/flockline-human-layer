import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommitInfo, TreeEntry } from "../shared/types";

// Wrapper de la CLI de git sobre Bun.spawn.
export interface GitResult {
  code: number;
  out: string;
  err: string;
}

export async function git(cwd: string, args: string[], opts: { allowFail?: boolean; env?: Record<string, string> } = {}): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`git ${args.join(" ")}: ${err.trim() || out.trim()}`);
  return { code, out, err };
}

export const slugify = (title: string) =>
  title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "tarea";

export async function repoInfo(repoPath: string): Promise<{ branch: string; commit: string }> {
  if (!existsSync(repoPath)) throw new Error("La ruta no existe");
  const inside = await git(repoPath, ["rev-parse", "--is-inside-work-tree"], { allowFail: true });
  if (inside.code !== 0 || inside.out.trim() !== "true") throw new Error("La ruta no es un repositorio git");
  const head = await git(repoPath, ["rev-parse", "HEAD"], { allowFail: true });
  if (head.code !== 0) throw new Error("El repositorio no tiene commits");
  const branch = (await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
  return { branch, commit: head.out.trim() };
}

export async function addWorktree(repoPath: string, worktreePath: string, branch: string, baseCommit: string) {
  await git(repoPath, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
}

export async function removeWorktree(repoPath: string, worktreePath: string, branch: string) {
  await git(repoPath, ["worktree", "remove", "--force", worktreePath], { allowFail: true });
  await git(repoPath, ["branch", "-D", branch], { allowFail: true });
}

/** Staging total (inofensivo en un worktree aislado) para ver también archivos nuevos. */
const stageAll = (wt: string) => git(wt, ["add", "-A"]);

export async function diff(wt: string, baseCommit: string): Promise<string> {
  await stageAll(wt);
  const r = await git(wt, ["diff", "--cached", "-M", baseCommit, "--", ".", ":(exclude).flock"]);
  return r.out;
}

export async function changedFiles(wt: string, baseCommit: string): Promise<Map<string, "M" | "A">> {
  await stageAll(wt);
  const r = await git(wt, ["diff", "--cached", "--name-status", "-M", baseCommit]);
  const map = new Map<string, "M" | "A">();
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    const [st, ...rest] = line.split("\t");
    const file = rest[rest.length - 1]!;
    map.set(file, st!.startsWith("A") || st!.startsWith("R") ? "A" : "M");
  }
  return map;
}

export async function tree(wt: string, baseCommit: string): Promise<TreeEntry[]> {
  const files = (await git(wt, ["ls-files", "-co", "--exclude-standard"])).out.split("\n").filter(Boolean);
  const changed = await changedFiles(wt, baseCommit);
  return [...new Set(files)].sort().map((path) => ({ path, status: changed.get(path) ?? null }));
}

export async function commitAll(wt: string, message: string, author: { name: string }) {
  await stageAll(wt);
  const email = `${author.name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@flockline.local`;
  await git(wt, ["-c", `user.name=${author.name}`, "-c", `user.email=${email}`, "commit", "--allow-empty", "-q", "-m", message, `--author=${author.name} <${email}>`]);
}

/** Lleva el worktree exactamente a `ref` (descarta commits posteriores, cambios y archivos sin seguimiento). */
export async function resetHard(wt: string, ref: string) {
  await git(wt, ["reset", "--hard", "-q", ref]);
  await git(wt, ["clean", "-fdq"]);
}

/** Último commit de fase cuyo asunto empieza con `<fase>:` (los crea approvePhase). */
export async function phaseCommit(wt: string, baseCommit: string, phase: string): Promise<string | null> {
  const r = await git(wt, ["log", `${baseCommit}..HEAD`, "--format=%H%x1f%s"], { allowFail: true });
  for (const line of r.out.split("\n")) {
    const [hash, subject] = line.split("\x1f");
    if (hash && subject?.startsWith(`${phase}:`)) return hash;
  }
  return null;
}

export async function commits(wt: string, baseCommit: string): Promise<CommitInfo[]> {
  const r = await git(wt, ["log", `${baseCommit}..HEAD`, "--format=%h%x1f%s%x1f%an%x1f%aI"], { allowFail: true });
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, author, date] = l.split("\x1f");
      return { hash: hash!, subject: subject!, author: author!, date: date! };
    });
}

export const worktreePathFor = (dir: string, slug: string) => join(dir, slug);
