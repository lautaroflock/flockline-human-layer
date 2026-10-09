import { useEffect, useMemo, useState } from "react";
import { files } from "../api";
import { run, useStore } from "../store";
import type { CommitInfo, FileContent, TreeEntry } from "../../shared/types";

interface Node {
  name: string;
  path: string;
  status: "M" | "A" | null;
  children?: Map<string, Node>;
}

function buildTree(entries: TreeEntry[]): Node {
  const root: Node = { name: "", path: "", status: null, children: new Map() };
  for (const e of entries) {
    let cur = root;
    const parts = e.path.split("/");
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      if (!cur.children!.has(part)) cur.children!.set(part, { name: part, path, status: null, children: last ? undefined : new Map() });
      const n = cur.children!.get(part)!;
      if (last) n.status = e.status;
      cur = n;
    });
  }
  return root;
}

export function FilesPanel() {
  const detail = useStore((s) => s.detail)!;
  const tick = useStore((s) => s.worktreeTick);
  const t = detail.task;
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);

  useEffect(() => {
    run(Promise.all([files.tree(t.id), files.commits(t.id)]).then(([tr, cm]) => (setTree(tr), setCommits(cm))));
  }, [t.id, t.phase, t.status, tick]);

  useEffect(() => {
    if (!open) return setFile(null);
    run(files.file(t.id, open).then(setFile));
  }, [open, t.id, tick]);

  const root = useMemo(() => buildTree(tree), [tree]);

  const render = (n: Node, depth: number): React.ReactNode[] =>
    [...n.children!.values()]
      .sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name))
      .flatMap((c) => {
        if (c.children) {
          const isOpen = !closed.has(c.path);
          return [
            <div key={c.path} className="tn" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setClosed((s) => (isOpen ? new Set(s).add(c.path) : new Set([...s].filter((x) => x !== c.path))))}>
              {isOpen ? "▾" : "▸"} 📁 {c.name}
            </div>,
            ...(isOpen ? render(c, depth + 1) : []),
          ];
        }
        return [
          <div key={c.path} className={`tn ${open === c.path ? "on" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen(c.path)} data-path={c.path}>
            📄 {c.name}
            {c.status && <span className={`st ${c.status}`}>{c.status}</span>}
          </div>,
        ];
      });

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }} data-testid="files-panel">
      <div className="wt">
        📂 <b>{t.worktree_path}</b>
        <br />
        rama <b>{t.branch}</b> · base <b>{t.base_branch}</b> · repo <b>{t.repo_path}</b>
        <div className="commit">
          {commits.length === 0 ? "(sin commits de fase todavía)" : commits.map((c) => <div key={c.hash}>● {c.hash} {c.subject} — {c.author}</div>)}
        </div>
      </div>
      <div className="treebox">
        <div className="tl">{render(root, 0)}</div>
        <div className="fv">
          {!file ? (
            <span style={{ color: "var(--mut)" }}>Elegí un archivo del worktree.</span>
          ) : file.binary ? (
            <span style={{ color: "var(--mut)" }}>Archivo binario ({file.size} bytes)</span>
          ) : (
            <>
              {file.content}
              {file.truncated && <div style={{ color: "var(--warn)" }}>… recortado a 512 KB</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
