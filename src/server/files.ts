import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { config } from "./config";
import { HttpError } from "./http";
import type { FileContent } from "../shared/types";

const within = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Realpath del ancestro existente más cercano (para validar destinos que todavía no existen). */
function realOfExisting(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
  return realpathSync(cur);
}

/**
 * Resuelve `rel` dentro de `root` o devuelve null si sale de él (`..`, rutas absolutas, symlinks que apuntan afuera o `.git`).
 * Sirve tanto al visor de archivos (§11.6) como a la guarda de herramientas del agente.
 */
export function resolveInside(root: string, rel: string, opts: { allowAbsolute?: boolean } = {}): string | null {
  if (!rel || rel.includes("\0")) return null;
  if (isAbsolute(rel) && !opts.allowAbsolute) return null;
  const full = resolve(root, rel);
  const realRoot = realpathSync(root);
  if (!within(resolve(root), full) && !within(realRoot, full)) return null;
  const first = full.slice(resolve(root).length + 1).split(sep)[0];
  if (first === ".git") return null;
  if (!within(realRoot, realOfExisting(full))) return null; // symlink hacia afuera
  return full;
}

export function readSafe(root: string, rel: string): FileContent {
  const full = resolveInside(root, rel);
  if (!full) throw new HttpError(400, "Ruta fuera del worktree");
  if (!existsSync(full) || !statSync(full).isFile()) throw new HttpError(404, "Archivo no encontrado");
  const size = statSync(full).size;
  const buf = readFileSync(full);
  const binary = buf.subarray(0, 8000).includes(0);
  if (binary) return { path: rel, size, binary: true, truncated: false, content: null };
  const truncated = size > config.maxFileBytes;
  return { path: rel, size, binary: false, truncated, content: buf.subarray(0, config.maxFileBytes).toString("utf8") };
}

export const joinWt = (wt: string, ...p: string[]) => join(wt, ...p);
