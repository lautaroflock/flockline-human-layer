// H0: confirma que el Agent SDK corre bajo Bun y muestra la forma real de los mensajes.
// Uso: bun scripts/spike.ts [repoPath]   (gasta unos centavos: maxTurns bajo)
import { query } from "@anthropic-ai/claude-agent-sdk";

const cwd = process.argv[2] ?? process.cwd();
const q = query({
  prompt: "Listá los archivos de la raíz del repo y respondé en una sola línea cuántos hay. No modifiques nada.",
  options: { cwd, maxTurns: 3, permissionMode: "acceptEdits", allowedTools: ["Read", "Glob", "Grep"] },
});

for await (const m of q) {
  const sub = "subtype" in m ? `/${m.subtype}` : "";
  if (m.type === "system" && m.subtype === "init") console.log(`system/init session_id=${m.session_id} tools=${m.tools.length} key=${m.apiKeySource}`);
  else if (m.type === "assistant") console.log(`assistant blocks=[${m.message.content.map((b) => b.type).join(",")}]`);
  else if (m.type === "result") console.log(`result${sub} turns=${m.num_turns} cost=$${m.total_cost_usd}`);
  else console.log(`${m.type}${sub}`);
}
