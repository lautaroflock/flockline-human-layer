import data from "./jira-mock.json";
import type { Ticket } from "../../shared/types";

/**
 * Proveedor de tickets (H15). Solo existe el mock: tickets de ejemplo locales, sin conexión a Jira.
 * La interfaz queda lista para un proveedor real (REST v3 + token) más adelante.
 */
export interface TicketProvider {
  readonly source: string;
  list(query?: string): Ticket[];
  get(key: string): Ticket | null;
}

class JiraMockProvider implements TicketProvider {
  readonly source = "jira-mock";
  private readonly all = data as Ticket[];

  list(query = ""): Ticket[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.all;
    return this.all.filter((t) => t.key.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
  }

  get(key: string): Ticket | null {
    return this.all.find((t) => t.key.toLowerCase() === key.trim().toLowerCase()) ?? null;
  }
}

function createProvider(): TicketProvider {
  const mode = process.env.TICKETS_MODE ?? "mock";
  if (mode !== "mock") {
    // A propósito: que nadie crea que hay integración real con Jira
    throw new Error(`TICKETS_MODE=${mode} no está implementado: solo existe el modo "mock" (tickets de ejemplo). Quitá la variable o usá TICKETS_MODE=mock.`);
  }
  return new JiraMockProvider();
}

export const tickets = createProvider();

/** Primera versión de la spec (o PRD) armada desde el ticket; queda marcada como importada. */
export function specFromTicket(t: Ticket, label: string): string {
  return `# ${label}: ${t.summary}

> Importada de ${t.key} (ticket de ejemplo, ${t.type}, prioridad ${t.priority}). Revisala y editala antes de aprobar.

## Objetivo
${t.description}

## Criterios de aceptación
${t.acceptance.map((a) => `- [ ] ${a}`).join("\n")}

## Contexto del ticket
- Tipo: ${t.type}
- Prioridad: ${t.priority}
- Etiquetas: ${t.labels.join(", ") || "—"}
- Reportó: ${t.reporter} (${t.created})
`;
}
