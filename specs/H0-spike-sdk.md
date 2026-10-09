# H0 — Spike del Agent SDK

**Objetivo:** confirmar que `@anthropic-ai/claude-agent-sdk` corre bajo Bun y fijar los nombres reales de opciones y mensajes antes de H3 (regla §10: no asumir).

**Entregables**
- `package.json` con dependencias del spec (react, react-markdown, remark-gfm, diff2html, claude-agent-sdk, typescript, tipos).
- `scripts/spike.ts`: llama `query()` con `cwd` en un repo, `maxTurns` bajo y `permissionMode: "acceptEdits"`, e imprime el `type`/`subtype` de cada mensaje.
- `specs/notas-sdk.md`: opciones y tipos de mensaje confirmados leyendo `node_modules/@anthropic-ai/claude-agent-sdk` (no de memoria).

**Verificación:** `bun run scripts/spike.ts` imprime `system/init` con `session_id` y termina con un mensaje `result`. Si falla bajo Bun: fallback del §2 (módulo de agentes con Node o `pathToClaudeCodeExecutable`).
