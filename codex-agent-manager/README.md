# SquadAI Manager

The SquadAI manager provides the multi-agent registry, control plane, remote
runner, browser UI, event inbox, work queue, approvals, persistent threads, and
Git worktree isolation.

## Start

```bash
npm ci
npm start -- --mode embedded --host 127.0.0.1 --port 4317
```

Open `http://127.0.0.1:4317`.

## Modes

- `embedded`: control plane and local runner behavior in one process
- `control`: control plane accepting remote runner connections
- `runner`: outbound-connecting worker that executes Codex sessions

## Example Event

```http
POST /api/sensor-events
content-type: application/json

{
  "source": "issue-tracker",
  "type": "issue.created",
  "title": "Investigate a production issue",
  "body": "Determine the cause and prepare a proposed fix.",
  "dedupeKey": "issue:INC-123",
  "targetAgentId": "incident-engineer",
  "executionPolicy": "new"
}
```

Source integrations remain outside the manager. They only need to translate an
external signal into this generic event API.

## Development

```bash
npm test
```
