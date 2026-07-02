# codex-agent-manager

Reusable multi-agent session manager built on top of `codex-control`.

`codex-control` owns the low-level App Server protocol and one Codex session.
`codex-agent-manager` owns named persistent agents: creating/resuming sessions,
routing plain-text messages, tracking status, emitting events, and saving thread
ids for restart recovery.

This package deliberately does **not** define tickets, work items, Jira fields,
Linear issues, or project-specific task schemas. Callers send plain English to
agents. Adapters such as `ops-poc` can keep their own dedupe/source rules and
only use this package for agent lifecycle.

## Basic Usage

```ts
import {
  CodexAgentManager,
  JsonFileAgentStateStore,
} from "codex-agent-manager";

const manager = new CodexAgentManager({
  stateStore: new JsonFileAgentStateStore("./agents.state.json"),
  agents: [
    {
      id: "maintenance",
      name: "Maintenance Debugger",
      cwd: "/home/developer/scratch/ops-poc",
      instructions: [
        "You specialize in read-only instance-maintenance debugging.",
        "Be concise, cite evidence, and ask for approval before external writes.",
      ].join("\n"),
    },
    {
      id: "storage",
      name: "storage Debugger",
      cwd: "/home/developer/scratch/ops-poc",
      instructions: "You specialize in storage incident triage.",
    },
  ],
});

await manager.start();

const result = await manager.sendToAgent(
  "maintenance",
  "Please inspect this incident and return a verdict with evidence.",
  { network: "allow", timeoutMs: 600_000 },
);

console.log(result.finalText);
await manager.close();
```

## Command Center UI

Run the local Command Center when you want to create agents from a browser, send
messages, and watch live activity without writing application code.

```bash
cd /home/developer/scratch/codex-agent-manager
npm start -- --port 4317 --state ./codex-agents.state.json
```

On macOS the manager automatically uses Codex Desktop's bundled app-server.
Override it with `CODEX_BINARY=/path/to/codex` or
`--codex-binary /path/to/codex`. Other platforms fall back to `codex` on
`PATH`.

Then open:

```text
http://127.0.0.1:4317
```

The UI supports:

- create named agents dynamically
- list agent status
- send plain-text messages to a selected agent
- see live lifecycle/activity events through Server-Sent Events
- persist created agents and thread ids in the state file
- ingest sensor events into a durable event inbox
- route events through a router agent into a durable work queue
- dispatch queued work to free worker agents
- surface human-attention notifications and optionally brief a Jarvis agent

The same server exposes a small JSON API for sensors and future adapters:

```http
GET /api/agents
POST /api/agents
POST /api/agents/:agentId/messages
GET /api/sensor-events
POST /api/sensor-events
GET /api/work-items
GET /api/notifications
POST /api/automation/tick
GET /api/events
GET /api/events/stream
```

## Autonomous Sensors

External systems should send plain event payloads to the command center instead
of starting Codex sessions themselves:

```http
POST /api/sensor-events
content-type: application/json

{
  "source": "jira",
  "type": "ticket.created",
  "title": "storage backup stuck",
  "body": "platform-123 reports an storage backup stuck in region-a.",
  "dedupeKey": "jira:platform-123",
  "url": "https://jira.example/browse/platform-123"
}
```

Create one agent with `metadata.role` set to `"router"`. The command center
will ask that router agent to choose a worker and produce a plain-English prompt.
The resulting work item is queued and dispatched when the target agent is free.
If no router is configured, incoming events remain pending in the inbox.

Create one optional agent with `metadata.role` set to `"jarvis"` to act as the
human-facing command center agent. When automation runs and Jarvis is idle, the
manager sends it a compact batch of unresolved notifications, such as approvals
or failed work, so it can tell the user what needs attention. Jarvis is excluded
from the worker roster and notifications remain clickable in the UI so the user
can jump back to the source agent for approvals or follow-up.

## Responsibilities

- Maintain a registry of named agents.
- Allow dynamic agent creation from code or the Command Center API.
- Lazily start or resume one `codex-control` session per agent.
- Send plain-text turns to a specific agent.
- Reject concurrent turns to the same agent while allowing other agents to run.
- Ingest source events without making source-specific assumptions.
- Route events through a router agent into plain-English work items.
- Dispatch queued work to available target agents.
- Deliver unresolved human-attention notifications to an idle Jarvis agent.
- Persist agent thread ids and status through an `AgentStateStore`.
- Emit ordered agent events for future UI/status surfaces.
- Keep source-specific logic outside the package.

## Non-Goals

- No Jira, issue tracker, Linear, GitHub, or Slack assumptions.
- No required work-item schema.
- No automatic duplicate detection for caller prompts.
- No shared App Server pool yet; v1 uses isolated clients per agent.

## Development

```bash
cd /home/developer/scratch/codex-agent-manager
npm test
```

The build script uses local TypeScript when installed and falls back to the
compiler already present in `/home/developer/scratch/codex-control`.
