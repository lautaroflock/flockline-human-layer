# Notas del Agent SDK (confirmadas en `node_modules/@anthropic-ai/claude-agent-sdk` v0.3.295 y con `scripts/spike.ts`)

- `query({ prompt, options }): Query` es un `AsyncIterable<SDKMessage>`.
- Opciones usadas: `cwd`, `maxTurns`, `permissionMode` (`default|acceptEdits|bypassPermissions|plan|dontAsk|auto`), `allowedTools`, `disallowedTools`, `canUseTool`, `resume` (session id), `abortController`, `systemPrompt`, `pathToClaudeCodeExecutable`, `settingSources`.
- `canUseTool(toolName, input, { signal })` devuelve `{ behavior: "allow", updatedInput? }` o `{ behavior: "deny", message, interrupt? }`.
- Mensajes: `system/init` (`session_id`, `tools`, `apiKeySource`), `assistant` (`message.content[]` con bloques `thinking | text | tool_use`), `user` (resultados de tools), `result` (`subtype`, `is_error`, `num_turns`, `result`, `total_cost_usd`, `session_id`). Hay además eventos de ruido (`rate_limit_event`, `system/task_summary`, `system/post_turn_summary`) que el orquestador ignora.
- Bajo Bun en Windows el SDK funciona sin fallback. Con la sesión de Claude Code ya autenticada, `apiKeySource` es `none` (OAuth).
- Costo del spike (2 turnos, sin escribir): ~US$0,35, dominado por el contexto de sistema.
