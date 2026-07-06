# codex-control

Reusable TypeScript control layer for `codex app-server`.

It handles App Server startup, JSON-RPC, thread start and resume, turns,
approvals, MCP elicitations, model and skill discovery, activity events,
compaction, interruption, and timeouts. Codex still owns reasoning, coding,
tools, skills, plugins, and context construction.

## Example

```ts
import { CodexControlClient } from "codex-control";

const client = new CodexControlClient();
const session = await client.startSession({
  cwd: process.cwd(),
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
});

const result = await session.ask("Inspect this repository and summarize it.");
console.log(result.finalText);
await client.close();
```

Set `CODEX_BINARY` when Codex is not available as `codex` on `PATH`.

## Development

```bash
npm test
```
