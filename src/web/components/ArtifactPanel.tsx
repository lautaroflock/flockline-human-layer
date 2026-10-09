import { useEffect, useState } from "react";
import { api } from "../api";
import { setState, setTab, showError, useStore } from "../store";
import { DiffView } from "./DiffView";
import { FilesPanel } from "./FilesPanel";
import { CommentLayer, SelectionPopover, userColor, userName } from "./CommentLayer";
import { Markdown, type Mark } from "./Markdown";
import { PHASES, type Artifact, type PhaseName, type Tab } from "../../shared/types";

const TABS: { id: Tab; label: string }[] = [
  { id: "spec", label: "Spec" },
  { id: "research", label: "Research" },
  { id: "plan", label: "Plan" },
  { id: "files", label: "Archivos" },
  { id: "diff", label: "Diff" },
];

const specTemplate = (title: string, description: string) => `# Spec: ${title}

## Objetivo
${description.trim() || "Qué problema resuelve y para quién."}

## Alcance
- Dentro:
- Fuera:

## Criterios de aceptación
- [ ]

## Restricciones y notas
-
`;

/** Versión visible de un artefacto: la elegida por la persona o, por defecto, la última. */
export function useShown(phase: PhaseName): { versions: Artifact[]; shown: Artifact | null; latest: Artifact | null } {
  const detail = useStore((s) => s.detail);
  const chosen = useStore((s) => s.version[phase]);
  const versions = (detail?.artifacts ?? []).filter((a) => a.phase === phase).sort((a, b) => a.version - b.version);
  const latest = versions[versions.length - 1] ?? null;
  const shown = versions.find((a) => a.version === chosen) ?? latest;
  return { versions, shown, latest };
}

export function ArtifactPanel() {
  const tab = useStore((s) => s.tab);
  const detail = useStore((s) => s.detail);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.user);
  if (!detail) return <section className="right" />;
  const phase = (PHASES as string[]).includes(tab) ? (tab as PhaseName) : "spec";
  return (
    <section className="right">
      <div className="tabs" data-testid="tabs">
        {TABS.map((t) => (
          <div key={t.id} className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)} data-tab={t.id}>
            {t.label}
            {detail.presence.filter((p) => p.tab === t.id && p.user_id !== me?.id).map((p) => (
              <span key={p.user_id} style={{ color: users.find((u) => u.id === p.user_id)?.color }} title={users.find((u) => u.id === p.user_id)?.name}> ●</span>
            ))}
          </div>
        ))}
        {tab !== "diff" && tab !== "files" && <VersionPicker phase={phase} />}
      </div>
      {tab === "diff" ? <DiffView /> : tab === "files" ? <FilesPanel /> : <ArtifactView key={phase} phase={phase} />}
    </section>
  );
}

function VersionPicker({ phase }: { phase: PhaseName }) {
  const users = useStore((s) => s.users);
  const { versions, shown } = useShown(phase);
  if (versions.length < 2 || !shown) return null;
  return (
    <select className="vers" value={shown.version} onChange={(e) => setState((s) => ({ version: { ...s.version, [phase]: Number(e.target.value) } }))}>
      {[...versions].reverse().map((v) => (
        <option key={v.id} value={v.version}>
          v{v.version}
          {v.approved ? " ✓" : ""}
          {v.created_by ? ` · ${userName(users, v.created_by)}` : ""}
        </option>
      ))}
    </select>
  );
}

function ArtifactView({ phase }: { phase: PhaseName }) {
  const detail = useStore((s) => s.detail)!;
  const users = useStore((s) => s.users);
  const { shown, latest } = useShown(phase);
  const [editing, setEditing] = useState(false);
  const task = detail.task;

  // Si la fase cambia (p. ej. alguien aprobó) mientras se edita, se cierra el editor
  const isCurrent = task.phase === phase;
  const atLatest = !shown || shown.id === latest?.id;
  const canEdit =
    isCurrent && atLatest && phase !== "implement" && (task.status === "awaiting_review" || (phase === "spec" && (task.status === "idle" || task.status === "failed")));
  useEffect(() => {
    if (!canEdit) setEditing(false);
  }, [canEdit]);

  // Solo se comenta la última versión, de la fase activa y en revisión
  const commentable = !!shown && atLatest && isCurrent && task.status === "awaiting_review";
  const marks: Mark[] = shown
    ? detail.comments
        .filter((c) => c.artifact_id === shown.id && c.status === "open")
        .map((c) => ({ quote: c.quote, color: userColor(users, c.author_id), title: `${userName(users, c.author_id)}: ${c.body}` }))
    : [];

  if (editing && canEdit) {
    return <Editor phase={phase} initial={shown?.content ?? specTemplate(task.title, task.description)} baseVersion={latest?.version ?? 0} onClose={() => setEditing(false)} />;
  }

  return (
    <>
      {canEdit && shown && (
        <div style={{ padding: "6px 22px 0", display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setEditing(true)} data-testid="edit-artifact">✎ Editar</button>
          <span style={{ color: "var(--mut)", fontSize: 12 }}>
            v{shown.version}
            {shown.created_by ? ` · editada por ${userName(users, shown.created_by)}` : phase === "spec" ? "" : " · generada por el agente"}
          </span>
        </div>
      )}
      <div className="doc" data-testid="doc">
        {shown ? (
          <Markdown source={shown.content} marks={marks} />
        ) : phase === "spec" ? (
          <div className="empty">
            <p>La etapa Spec la escriben las personas, no el agente.</p>
            <p style={{ fontSize: 12 }}>Definí objetivo, alcance y criterios de aceptación; después se aprueba y alimenta Research, Plan e Implement.</p>
            <button className="pri" disabled={!canEdit} onClick={() => setEditing(true)} data-testid="write-spec">✎ Escribir spec</button>
          </div>
        ) : (
          <p className="empty">{phase}.md aún no existe. Ejecutá la fase.</p>
        )}
      </div>
      <SelectionPopover phase={phase} enabled={commentable} />
      <CommentLayer artifact={shown} phase={phase} commentable={commentable} />
    </>
  );
}

function Editor({ phase, initial, baseVersion, onClose }: { phase: PhaseName; initial: string; baseVersion: number; onClose: () => void }) {
  const detail = useStore((s) => s.detail)!;
  const me = useStore((s) => s.user)!;
  const latest = useStore((s) => s.detail?.artifacts.filter((a) => a.phase === phase).reduce((m, a) => Math.max(m, a.version), 0) ?? 0);
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const stale = latest !== baseVersion; // otra persona guardó mientras editabas
  const dirty = text !== initial;

  async function save() {
    setBusy(true);
    try {
      await api(`/api/tasks/${detail.task.id}/phases/${phase}/artifact`, { method: "PUT", body: { content: text, baseVersion } });
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc" style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="editor">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <b>Editando {phase}</b>
        <span style={{ color: "var(--mut)", fontSize: 12 }}>base v{baseVersion || "—"} · se guarda como {me.name}</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => (!dirty || confirm("¿Descartar los cambios?")) && onClose()}>Cancelar</button>
        <button className="pri" disabled={busy || !text.trim() || (!dirty && baseVersion > 0)} onClick={save} data-testid="save-artifact">
          Guardar <kbd>Ctrl+↵</kbd>
        </button>
      </div>
      {stale && <div style={{ color: "var(--warn)", fontSize: 12 }}>Otra persona guardó la v{latest} mientras editabas: al guardar vas a recibir un conflicto. Copiá tu texto y volvé a abrir el editor.</div>}
      <textarea
        autoFocus
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === "Enter") {
            e.preventDefault();
            if (!busy && text.trim()) void save();
          }
        }}
        style={{ flex: 1, minHeight: 320, fontFamily: "ui-monospace,Consolas,monospace", fontSize: 13, lineHeight: 1.5, resize: "none" }}
        data-testid="editor-text"
      />
    </div>
  );
}
