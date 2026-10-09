import { useEffect, useState } from "react";
import { api } from "../api";
import { reloadDetail, run, setState, useStore } from "../store";
import type { Artifact, PhaseName } from "../../shared/types";

export const userColor = (users: { id: string; color: string }[], id: string) => users.find((u) => u.id === id)?.color ?? "#8592a3";
export const userName = (users: { id: string; name: string }[], id: string) => users.find((u) => u.id === id)?.name ?? "?";

/** Cuadro "Comentar" flotante sobre la selección de texto. */
export function SelectionPopover({ phase, enabled }: { phase: PhaseName; enabled: boolean }) {
  const [pos, setPos] = useState<{ x: number; y: number; quote: string } | null>(null);

  useEffect(() => {
    const onUp = () => {
      const sel = getSelection();
      const text = sel?.toString().trim() ?? "";
      const el = sel?.anchorNode instanceof Node ? (sel.anchorNode.parentElement?.closest("[data-testid=markdown]") ?? null) : null;
      if (!enabled || text.length < 4 || !el || sel!.rangeCount === 0) return setPos(null);
      const r = sel!.getRangeAt(0).getBoundingClientRect();
      setPos({ x: r.left, y: Math.max(8, r.top - 36), quote: text.replace(/\s+/g, " ") });
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [enabled]);

  // Atajo C: comentar la selección actual
  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey && !(e.target as HTMLElement).closest("input,textarea")) {
        e.preventDefault();
        setState({ draft: { phase, quote: pos.quote } });
        setPos(null);
        getSelection()?.removeAllRanges();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pos, phase]);

  if (!pos) return null;
  return (
    <div
      className="pop"
      style={{ display: "block", left: pos.x, top: pos.y }}
      data-testid="comment-popover"
      onMouseDown={(e) => {
        e.preventDefault();
        setState({ draft: { phase, quote: pos.quote } });
        setPos(null);
        getSelection()?.removeAllRanges();
      }}
    >
      Comentar <kbd>C</kbd>
    </div>
  );
}

export function CommentLayer({ artifact, phase, commentable }: { artifact: Artifact | null; phase: PhaseName; commentable: boolean }) {
  const detail = useStore((s) => s.detail);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.user);
  const draft = useStore((s) => s.draft);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (!detail || !artifact || !me) return null;

  const mine = detail.comments.filter((c) => c.artifact_id === artifact.id);
  const open = mine.filter((c) => c.status === "open");
  const showDraft = draft && draft.phase === phase && commentable;

  async function publish() {
    if (!draft || !text.trim()) return;
    setBusy(true);
    await run(api(`/api/artifacts/${artifact!.id}/comments`, { body: { quote: draft.quote, body: text.trim() } }));
    setBusy(false);
    setText("");
    setState({ draft: null });
  }
  const patch = (id: string, status: "resolved" | "open") => run(api(`/api/comments/${id}`, { method: "PATCH", body: { status } }));

  return (
    <div className="comments" data-testid="comments">
      <b>Comentarios</b>{" "}
      {mine.length === 0 && !showDraft && <span style={{ color: "var(--mut)" }}>{commentable ? `— seleccioná texto para comentar como ${me.name}` : "— esta versión ya no admite comentarios nuevos"}</span>}
      {mine.map((c) => (
        <div key={c.id} className={`cm ${c.status}`}>
          {c.status !== "sent" && (
            <button className="rs" onClick={() => patch(c.id, c.status === "open" ? "resolved" : "open")}>
              {c.status === "open" ? "Resolver" : "Reabrir"}
            </button>
          )}
          <span className="who" style={{ color: userColor(users, c.author_id) }}>{userName(users, c.author_id)}</span>
          <q>{c.quote}</q>
          {c.body} <span className="s">{c.status}{c.orphan ? " · huérfano (el texto ya no está)" : ""}</span>
        </div>
      ))}
      {showDraft && (
        <div className="cm">
          <q>{draft.quote}</q>
          <div className="composer">
            <input
              autoFocus
              data-testid="comment-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && publish()}
              placeholder="Escribí tu comentario…"
            />
            <button className="pri" disabled={busy || !text.trim()} onClick={publish}>Publicar</button>
            <button onClick={() => setState({ draft: null })}>×</button>
          </div>
        </div>
      )}
      {commentable && (
        <button
          className="pri"
          data-testid="send-comments"
          disabled={open.length === 0}
          onClick={() => run(api(`/api/tasks/${detail.task.id}/phases/${phase}/revise`, { method: "POST" }).then(() => reloadDetail()))}
        >
          Enviar {open.length} comentario(s) al agente
        </button>
      )}
    </div>
  );
}
