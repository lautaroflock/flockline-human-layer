export type { ServerMessage, Session, Task, TaskDetail, User } from "../src/shared/types";

/** Fila de evento con el payload ya parseado. */
export interface AgentRowLike {
  id: number;
  type: string;
  payload: string;
  p: any;
}
