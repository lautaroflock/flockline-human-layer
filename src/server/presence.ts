import { bus } from "./bus";
import type { PresenceEntry, Tab } from "../shared/types";

// Presencia en memoria (§11.2): no se persiste. Una conexión por entrada; un usuario puede tener varias.
interface Conn {
  userId: string;
  taskId: string | null;
  tab: Tab;
}
const conns = new Map<object, Conn>();

export const presence = {
  connect(ws: object, userId: string) {
    conns.set(ws, { userId, taskId: null, tab: "research" });
  },
  disconnect(ws: object) {
    const c = conns.get(ws);
    conns.delete(ws);
    if (c?.taskId) presence.broadcast(c.taskId);
  },
  set(ws: object, taskId: string, tab: Tab) {
    const c = conns.get(ws);
    if (!c) return;
    const prev = c.taskId;
    c.taskId = taskId;
    c.tab = tab;
    if (prev && prev !== taskId) presence.broadcast(prev);
    presence.broadcast(taskId);
  },
  leave(ws: object, taskId: string) {
    const c = conns.get(ws);
    if (c && c.taskId === taskId) {
      c.taskId = null;
      presence.broadcast(taskId);
    }
  },
  forTask(taskId: string): PresenceEntry[] {
    const byUser = new Map<string, PresenceEntry>();
    for (const c of conns.values()) if (c.taskId === taskId) byUser.set(c.userId, { user_id: c.userId, tab: c.tab });
    return [...byUser.values()];
  },
  onlineUserIds: () => new Set([...conns.values()].map((c) => c.userId)),
  broadcast(taskId: string) {
    bus.publishTask(taskId, { type: "presence.changed", taskId, presence: presence.forTask(taskId) });
  },
};
