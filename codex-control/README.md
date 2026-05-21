# codex-control

Reusable TypeScript control layer for `codex app-server`.

The goal is to put the raw App Server protocol behind one stable API so voice apps, manager UIs, Python services, and project-specific tools do not each need to implement JSON-RPC, turn tracking, approvals, and MCP elicitations.

## Responsibilities

`codex-control` owns the outer lifecycle:

- start and initialize `codex app-server`
- start or resume Codex threads
- send user turns
- collect final assistant text
- route App Server notifications
- answer approval and MCP elicitation requests according to explicit policy
- expose manual compaction
- produce audit records for approval decisions
- enforce one active turn per session
- fail turns on timeout or App Server closure

It does **not** reimplement Codex itself. Codex/App Server still owns reasoning, coding behavior, tool selection, plugins, skills, context construction, automatic compaction, and multi-step agent work.

## Basic Usage

```ts
import { CodexControlClient } from "codex-control";

const client = new CodexControlClient();

const session = await client.startSession({
  cwd: "/home/developer/scratch/my-project",
  model: "gpt-5.5",
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
});

const result = await session.ask("Check my meetings today.");
console.log(result.finalText);

await client.close();
```

## External Writes

External writes should be explicit. By default, MCP elicitations are declined.

```ts
await session.ask("Send Project User a Slack DM saying hello.", {
  externalWrites: "allow",
  confirmation: {
    confirmed: true,
    reason: "user confirmed by voice",
  },
});
```

This allows form-mode MCP elicitations for the current turn only. Command execution and file-change approvals remain denied unless their policies are also explicitly allowed with confirmation.

## Python Apps

Python apps should not import this package directly. The intended production shape is:

```text
Python voice app or manager UI
  -> local HTTP/WebSocket API
  -> TypeScript codex-control daemon
  -> codex app-server
```

This keeps all App Server protocol handling in one place.

## Tested Behavior

The current test suite uses a fake App Server transport and verifies:

- turn start and final response extraction
- permission requests grant network but not filesystem by default
- MCP elicitations are declined unless external writes are confirmed
- confirmed external writes accept form-mode MCP elicitations
- concurrent turns on one session are rejected
- turn timeout includes last activity context

Run:

```bash
npm test
```

## Current Boundaries

This is the first production-shaped core. Before using it as a long-lived daemon, the next hardening steps are:

- add WebSocket/HTTP daemon API for Python and UI clients
- add persistent session registry mapping app session ids to Codex thread ids
- add structured audit sink implementations
- add integration tests against real `codex app-server`
- add cancellation via `turn/interrupt`
- add more protocol event normalization
- add explicit policy profiles for voice, UI, and automation contexts
