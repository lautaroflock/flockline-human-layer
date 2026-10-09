// Catálogo de fases y flujos de trabajo (H12). Fuente única para servidor y cliente:
// el orquestador, la guarda, el stepper y las pestañas se arman a partir de acá.

export type PhaseName = "spec" | "prd" | "questions" | "research" | "design" | "structure" | "outline" | "plan" | "implement" | "freeform";
export type WorkflowId = "rpi" | "qrspi" | "outline" | "prd" | "oneshot" | "freeform";

/** manual: la escriben personas · agent: la produce el agente · questions: el agente pregunta y las personas responden · free: sesiones sueltas */
export type PhaseKind = "manual" | "agent" | "questions" | "free";

const READ = ["Read", "Grep", "Glob"];
const DOCS = [...READ, "Write"]; // solo escriben en .flock/<slug>/
const CODE = [...READ, "Write", "Edit", "Bash"];

export interface PhaseDef {
  id: PhaseName;
  label: string;
  kind: PhaseKind;
  /** Archivo del artefacto dentro de .flock/<slug>/ */
  artifact: string;
  tools: string[];
  /** true: escribe código en todo el worktree (Implement, Freeform) */
  code: boolean;
  /** Artefactos aprobados de fases anteriores que recibe en {{inputs}} (si están en el flujo). */
  inputs: PhaseName[];
  description: string;
}

export const PHASE_DEFS: Record<PhaseName, PhaseDef> = {
  spec: { id: "spec", label: "Spec", kind: "manual", artifact: "spec.md", tools: [], code: false, inputs: [], description: "Objetivo, alcance y criterios de aceptación, escritos por personas." },
  prd: { id: "prd", label: "PRD", kind: "manual", artifact: "prd.md", tools: [], code: false, inputs: [], description: "Requisitos de producto: problema, usuarios, historias y métricas." },
  questions: { id: "questions", label: "Questions", kind: "questions", artifact: "questions.md", tools: READ, code: false, inputs: ["spec", "prd"], description: "El agente pregunta lo que cambia el diseño; las personas responden." },
  research: { id: "research", label: "Research", kind: "agent", artifact: "research.md", tools: DOCS, code: false, inputs: ["spec", "prd", "questions"], description: "Mapa del código relevante, patrones y riesgos. Sin proponer solución." },
  design: { id: "design", label: "Design", kind: "agent", artifact: "design.md", tools: DOCS, code: false, inputs: ["spec", "prd", "questions", "research"], description: "Enfoque elegido, alternativas descartadas, diagramas y mockups." },
  structure: { id: "structure", label: "Structure", kind: "agent", artifact: "structure.md", tools: DOCS, code: false, inputs: ["spec", "questions", "research", "design"], description: "Archivos, firmas públicas y formas de los datos. Sin implementación." },
  outline: { id: "outline", label: "Outline", kind: "agent", artifact: "outline.md", tools: DOCS, code: false, inputs: ["spec", "research"], description: "Esquema corto de cambios que reemplaza al plan detallado." },
  plan: { id: "plan", label: "Plan", kind: "agent", artifact: "plan.md", tools: DOCS, code: false, inputs: ["spec", "prd", "questions", "research", "design", "structure"], description: "Pasos numerados con archivos, pruebas y criterios." },
  implement: { id: "implement", label: "Implement", kind: "agent", artifact: "summary.md", tools: CODE, code: true, inputs: ["spec", "prd", "questions", "design", "structure", "outline", "plan"], description: "Ejecuta lo aprobado en el worktree y resume lo hecho." },
  freeform: { id: "freeform", label: "Sesiones", kind: "free", artifact: "", tools: CODE, code: true, inputs: [], description: "Sesiones sueltas con prompt libre." },
};

export interface WorkflowDef {
  id: WorkflowId;
  label: string;
  description: string;
  phases: PhaseName[];
}

export const WORKFLOWS: Record<WorkflowId, WorkflowDef> = {
  rpi: { id: "rpi", label: "RPI", description: "Research, plan e implementación guiados. Para cambios medianos.", phases: ["spec", "research", "plan", "implement"] },
  qrspi: { id: "qrspi", label: "QRSPI", description: "Preguntas, research, diseño, estructura, plan e implementación. Para cambios grandes o ambiguos.", phases: ["spec", "questions", "research", "design", "structure", "plan", "implement"] },
  outline: { id: "outline", label: "Outline", description: "Un esquema corto reemplaza al plan detallado. Para cambios acotados.", phases: ["spec", "research", "outline", "implement"] },
  prd: { id: "prd", label: "PRD", description: "Requisitos de producto y diseño técnico antes del plan. Para funcionalidades nuevas.", phases: ["prd", "research", "design", "plan", "implement"] },
  oneshot: { id: "oneshot", label: "Oneshot", description: "De la spec directo a la implementación. Para bugs chicos y tareas obvias.", phases: ["spec", "implement"] },
  freeform: { id: "freeform", label: "Freeform", description: "Sesiones sueltas con prompt libre, sin fases ni aprobaciones.", phases: [] },
};

export const isWorkflow = (w: unknown): w is WorkflowId => typeof w === "string" && w in WORKFLOWS;
export const isPhase = (p: unknown): p is PhaseName => typeof p === "string" && p in PHASE_DEFS;

/** Fases del flujo de una tarea, en orden. Freeform no tiene fases. */
export const phasesOf = (workflow: string): PhaseName[] => (isWorkflow(workflow) ? WORKFLOWS[workflow].phases : WORKFLOWS.rpi.phases);

/** Primera fase del flujo (o `freeform`). */
export const firstPhase = (workflow: WorkflowId): PhaseName => WORKFLOWS[workflow].phases[0] ?? "freeform";

/** Mockups permitidos: en Design, o en Plan cuando el flujo no tiene Design (H14). */
export const allowsMockups = (workflow: string, phase: PhaseName) =>
  phase === "design" || (phase === "plan" && !phasesOf(workflow).includes("design"));
