import { setState, setTab, useStore } from "../store";
import { DiffView } from "./DiffView";
import { CommentLayer, SelectionPopover, userColor, userName } from "./CommentLayer";
import { Markdown, type Mark } from "./Markdown";
import { PHASES, type Artifact, type PhaseName, type Tab } from "../../shared/types";

const TABS: { id: Tab; label: string }[] = [
  { id: "research", label: "Research" },
  { id: "plan", label: "Plan" },
  { id: "diff", label: "Diff" },
];

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
  const phase = (PHASES as string[]).includes(tab) ? (tab as PhaseName) : "research";
  return (
    <section className="right">
      <div className="tabs" data-testid="tabs">
        {TABS.map((t) => (
          <div key={t.id} className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
            {detail.presence.filter((p) => p.tab === t.id && p.user_id !== me?.id).map((p) => (
              <span key={p.user_id} style={{ color: users.find((u) => u.id === p.user_id)?.color }} title={users.find((u) => u.id === p.user_id)?.name}> ●</span>
            ))}
          </div>
        ))}
        {tab !== "diff" && <VersionPicker phase={phase} />}
      </div>
      {tab === "diff" ? <DiffView /> : <ArtifactView phase={phase} />}
    </section>
  );
}

function VersionPicker({ phase }: { phase: PhaseName }) {
  const { versions, shown } = useShown(phase);
  if (versions.length < 2 || !shown) return null;
  return (
    <select className="vers" value={shown.version} onChange={(e) => setState((s) => ({ version: { ...s.version, [phase]: Number(e.target.value) } }))}>
      {[...versions].reverse().map((v) => (
        <option key={v.id} value={v.version}>
          v{v.version}
          {v.approved ? " ✓" : ""}
        </option>
      ))}
    </select>
  );
}

function ArtifactView({ phase }: { phase: PhaseName }) {
  const detail = useStore((s) => s.detail);
  const users = useStore((s) => s.users);
  const { shown, latest } = useShown(phase);
  const task = detail!.task;
  // Solo se comenta la última versión, de la fase activa y en revisión
  const commentable = !!shown && shown.id === latest?.id && task.phase === phase && task.status === "awaiting_review";
  const marks: Mark[] = shown
    ? detail!.comments
        .filter((c) => c.artifact_id === shown.id && c.status === "open")
        .map((c) => ({ quote: c.quote, color: userColor(users, c.author_id), title: `${userName(users, c.author_id)}: ${c.body}` }))
    : [];
  return (
    <>
      <div className="doc" data-testid="doc">
        {shown ? <Markdown source={shown.content} marks={marks} /> : <p className="empty">{phase}.md aún no existe. Ejecutá la fase.</p>}
      </div>
      <SelectionPopover phase={phase} enabled={commentable} />
      <CommentLayer artifact={shown} phase={phase} commentable={commentable} />
    </>
  );
}
