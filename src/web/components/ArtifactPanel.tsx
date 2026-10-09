import { useEffect, useState } from "react";
import { api } from "../api";
import { setState, setTab, showError, useStore } from "../store";
import { DiffView } from "./DiffView";
import { FilesPanel } from "./FilesPanel";
import { CommentLayer, SelectionPopover, userColor, userName } from "./CommentLayer";
import { Markdown, type Mark } from "./Markdown";
import { MockupsView } from "./MockupsView";
import { isPhase, PHASE_DEFS, phasesOf, type PhaseName } from "../../shared/workflows";
import type { Artifact, Tab } from "../../shared/types";

/** Pestañas de la tarea: las fases con documento de su flujo, más Archivos y Diff. */
export function tabsFor(workflow: string): { id: Tab; label: string }[] {
  const phases = workflow === "freeform" ? [] : phasesOf(workflow).filter((p) => !PHASE_DEFS[p].code);
  return [...phases.map((p) => ({ id: p as Tab, label: PHASE_DEFS[p].label })), { id: "files", label: "Archivos" }, { id: "diff", label: "Diff" }];
}

const TEMPLATES: Partial<Record<PhaseName, (title: string, description: string) => string>> = {
  spec: (title, description) => `# Spec: ${title}

## Objetivo
${description.trim() || "Qué problema resuelve y para quién."}

## Alcance
- Dentro:
- Fuera:

## Criterios de aceptación
- [ ]

## Restricciones y notas
-
`,
  prd: (title, description) => `# PRD: ${title}

## Problema
${description.trim() || "Qué dolor resolvemos y cómo lo sabemos."}

## Usuarios y contexto
-

## Historias de usuario
- Como … quiero … para …

## Requisitos
- Funcionales:
- No funcionales:

## Métricas de éxito
-

## Fuera de alcance
-
`,
};

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
  const tabs = tabsFor(detail.task.workflow);
  const current = tabs.some((t) => t.id === tab) ? tab : tabs[0]!.id;
  const phase = isPhase(current) ? current : null;
  return (
    <section className="right">
      <div className="tabs" data-testid="tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`tab ${current === t.id ? "on" : ""}`} onClick={() => setTab(t.id)} data-tab={t.id}>
            {t.label}
            {t.id === "questions" && detail.questions.length > 0 && <small> {detail.questions.filter((q) => q.status !== "open").length}/{detail.questions.length}</small>}
            {detail.presence.filter((p) => p.tab === t.id && p.user_id !== me?.id).map((p) => (
              <span key={p.user_id} style={{ color: users.find((u) => u.id === p.user_id)?.color }} title={users.find((u) => u.id === p.user_id)?.name}> ●</span>
            ))}
          </div>
        ))}
        {phase && <VersionPicker phase={phase} />}
      </div>
      {current === "diff" ? <DiffView /> : current === "files" ? <FilesPanel /> : phase ? <ArtifactView key={phase} phase={phase} /> : null}
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
  const [view, setView] = useState<"doc" | "mockups">("doc");
  const task = detail.task;
  const def = PHASE_DEFS[phase];

  // Si la fase cambia (p. ej. alguien aprobó) mientras se edita, se cierra el editor
  const isCurrent = task.phase === phase;
  const atLatest = !shown || shown.id === latest?.id;
  const canEdit =
    isCurrent && atLatest && !def.code && def.kind !== "questions" &&
    (task.status === "awaiting_review" || (def.kind === "manual" && (task.status === "idle" || task.status === "failed")));
  useEffect(() => {
    if (!canEdit) setEditing(false);
  }, [canEdit]);

  // Solo se comenta la última versión, de la fase activa y en revisión (las preguntas se responden, no se comentan)
  const commentable = !!shown && atLatest && isCurrent && task.status === "awaiting_review" && def.kind !== "questions";
  const marks: Mark[] = shown
    ? detail.comments
        .filter((c) => c.artifact_id === shown.id && c.status === "open")
        .map((c) => ({ quote: c.quote, color: userColor(users, c.author_id), title: `${userName(users, c.author_id)}: ${c.body}` }))
    : [];
  const mockups = shown ? detail.artifactFiles.filter((f) => f.artifact_id === shown.id) : [];

  if (editing && canEdit) {
    const template = TEMPLATES[phase]?.(task.title, task.description) ?? "";
    return <Editor phase={phase} initial={shown?.content ?? template} baseVersion={latest?.version ?? 0} onClose={() => setEditing(false)} />;
  }

  return (
    <>
      {shown && (canEdit || mockups.length > 0) && (
        <div style={{ padding: "6px 22px 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {canEdit && <button onClick={() => setEditing(true)} data-testid="edit-artifact">✎ Editar</button>}
          {mockups.length > 0 && (
            <span className="seg">
              <button className={view === "doc" ? "on" : ""} onClick={() => setView("doc")}>Documento</button>
              <button className={view === "mockups" ? "on" : ""} onClick={() => setView("mockups")} data-testid="mockups-toggle">Mockups ({mockups.length})</button>
            </span>
          )}
          <span style={{ color: "var(--mut)", fontSize: 12 }}>
            v{shown.version}
            {shown.created_by ? ` · editada por ${userName(users, shown.created_by)}` : def.kind === "manual" ? " · importada" : " · generada por el agente"}
          </span>
        </div>
      )}
      {view === "mockups" && shown && mockups.length > 0 ? (
        <MockupsView artifactId={shown.id} files={mockups.map((m) => m.path)} />
      ) : (
        <div className="doc" data-testid="doc">
          {shown ? (
            <Markdown source={shown.content} marks={marks} />
          ) : def.kind === "manual" ? (
            <div className="empty">
              <p>La etapa {def.label} la escriben las personas, no el agente.</p>
              <p style={{ fontSize: 12 }}>{def.description} Después se aprueba y alimenta las fases siguientes.</p>
              <button className="pri" disabled={!canEdit} onClick={() => setEditing(true)} data-testid="write-spec">✎ Escribir {def.label.toLowerCase()}</button>
            </div>
          ) : (
            <p className="empty">{def.artifact} aún no existe. Ejecutá la fase.</p>
          )}
        </div>
      )}
      {view === "doc" && def.kind !== "questions" && (
        <>
          <SelectionPopover phase={phase} enabled={commentable} />
          <CommentLayer artifact={shown} phase={phase} commentable={commentable} />
        </>
      )}
    </>
  );
}

/** Editor con vista previa en vivo (H14): los diagramas Mermaid se ven mientras se escriben. */
function Editor({ phase, initial, baseVersion, onClose }: { phase: PhaseName; initial: string; baseVersion: number; onClose: () => void }) {
  const detail = useStore((s) => s.detail)!;
  const me = useStore((s) => s.user)!;
  const latest = useStore((s) => s.detail?.artifacts.filter((a) => a.phase === phase).reduce((m, a) => Math.max(m, a.version), 0) ?? 0);
  const [text, setText] = useState(initial);
  const [preview, setPreview] = useState(initial);
  const [busy, setBusy] = useState(false);
  const stale = latest !== baseVersion; // otra persona guardó mientras editabas
  const dirty = text !== initial;

  useEffect(() => {
    const t = setTimeout(() => setPreview(text), 350);
    return () => clearTimeout(t);
  }, [text]);

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
        <b>Editando {PHASE_DEFS[phase].label}</b>
        <span style={{ color: "var(--mut)", fontSize: 12 }}>base v{baseVersion || "—"} · se guarda como {me.name}</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => (!dirty || confirm("¿Descartar los cambios?")) && onClose()}>Cancelar</button>
        <button className="pri" disabled={busy || !text.trim() || (!dirty && baseVersion > 0)} onClick={save} data-testid="save-artifact">
          Guardar <kbd>Ctrl+↵</kbd>
        </button>
      </div>
      {stale && <div style={{ color: "var(--warn)", fontSize: 12 }}>Otra persona guardó la v{latest} mientras editabas: al guardar vas a recibir un conflicto. Copiá tu texto y volvé a abrir el editor.</div>}
      <div className="split">
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
          data-testid="editor-text"
        />
        <div className="preview" data-testid="editor-preview">
          <Markdown source={preview} />
        </div>
      </div>
    </div>
  );
}
