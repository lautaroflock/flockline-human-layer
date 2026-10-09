import { useStore } from "../store";

// Referencia estable para el selector (ver Presence.tsx).
const NONE: never[] = [];

const VERB: Record<string, (p: any) => string> = {
  "task.created": () => "creó la tarea y el worktree",
  "phase.run": (p) => `ejecutó ${p?.phase}`,
  "phase.revise": (p) => `pidió revisar ${p?.phase}`,
  "phase.approved": (p) => `aprobó ${p?.phase}`,
  "phase.aborted": (p) => `abortó ${p?.phase}`,
  "comment.created": (p) => `comentó en ${p?.phase}`,
  "comment.resolved": (p) => `resolvió un comentario en ${p?.phase}`,
  "artifact.edited": (p) => `editó ${p?.phase} (v${p?.version})`,
  "task.cancelled": (p) => `canceló la tarea (en ${p?.phase})`,
  "task.reopened": () => "reabrió la tarea",
  "phase.rewound": (p) => p?.from === p?.to ? `rehízo ${p?.to}` : `volvió de ${p?.from} a ${p?.to}`,
  "comments.sent": (p) => `envió ${p?.count} comentario(s) al agente (${p?.phase})`,
};

export function ActivityFeed() {
  const activity = useStore((s) => s.detail?.activity ?? NONE);
  const users = useStore((s) => s.users);
  return (
    <div className="act" data-testid="activity">
      <b>Actividad</b>
      {activity.slice(0, 6).map((a) => {
        const u = users.find((x) => x.id === a.user_id);
        const p = a.payload ? JSON.parse(a.payload) : null;
        return (
          <div key={a.id}>
            {new Date(a.created_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })} ·{" "}
            <span style={{ color: u?.color }}>{u?.name ?? "?"}</span> {(VERB[a.kind] ?? (() => a.kind))(p)}
          </div>
        );
      })}
    </div>
  );
}
