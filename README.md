# SquadAI

SquadAI is a control plane for creating, running, and supervising teams of
Codex agents. Agents can run on the same machine as the control plane or on
remote runners, while the browser UI provides one place to see conversations,
tool activity, approvals, work queues, and live topology.

## Packages

- `codex-control`: stable TypeScript API over `codex app-server`
- `codex-agent-manager`: SquadAI control plane, runner, browser UI, persistence,
  event ingestion, and Git worktree isolation

## Requirements

- Node.js 22.13 or newer
- npm
- Git
- Codex installed, authenticated, and available on `PATH`

SquadAI supports macOS, Linux, and Windows. On Windows, install native Codex and
Git for Windows before starting a runner.

## Install

Build the Codex control package first:

```bash
cd codex-control
npm ci
npm run build
```

Then install and test SquadAI:

```bash
cd ../codex-agent-manager
npm ci
npm test
```

## Run Everything On One Machine

```bash
cd codex-agent-manager
npm start -- --mode embedded --host 127.0.0.1 --port 4317
```

Open `http://127.0.0.1:4317`.

## Run A Separate Control Plane And Runner

Start the control plane:

```bash
node codex-agent-manager/dist/src/cli.js \
  --mode control \
  --host 127.0.0.1 \
  --port 4317 \
  --runner-token change-me
```

Start a runner on any machine that can reach the control plane:

```bash
node codex-agent-manager/dist/src/cli.js \
  --mode runner \
  --control-url http://CONTROL_HOST:4317 \
  --runner-id development-machine \
  --runner-name "Development machine" \
  --runner-token change-me
```

The runner uses the Codex installation, filesystem, Git repositories, skills,
plugins, MCP servers, and credentials available on its own machine.

## Security

Use a strong runner token and a private network or authenticated tunnel between
the control plane and runners. Do not expose the control-plane port directly to
the public internet.

## Development

Cross-platform tests run on Linux, macOS, and Windows through GitHub Actions.
