import type { Server } from "bun";
import type { ServerMessage } from "../shared/types";

// Pub/sub en memoria sobre los topics nativos de Bun: `task:<id>` por tarea y `tasks` global.
let server: Server<unknown> | null = null;

export const bus = {
  attach(s: Server<unknown>) {
    server = s;
  },
  publishTask(taskId: string, msg: ServerMessage) {
    server?.publish(`task:${taskId}`, JSON.stringify(msg));
  },
  publishGlobal(msg: ServerMessage) {
    server?.publish("tasks", JSON.stringify(msg));
  },
};
