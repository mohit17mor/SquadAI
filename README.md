# SquadAI

> SquadAI is the Kubernetes-like control plane for Codex agents turning every event into the right Codex task, on the machine where the work already lives!

SquadAI gives you one place to manage and send work to Codex agents, even when
those agents run on different machines. Your projects, tools, skills, and
credentials stay on the machine where they are already set up. From the SquadAI
dashboard, you can talk to an agent directly or send it work when something
happens in another tool, such as a webhook, monitor, or Telegram message.

![SquadAI live agent topology](docs/assets/squadai-topology.png)

## Get SquadAI Running

The fastest setup runs the control plane and agents on one machine. You need
Git, Node.js 22.13 or newer, and a ChatGPT account that can sign in to
Codex.

<details open>
<summary><strong>Windows</strong></summary>

Open PowerShell and run:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
codex login
git clone https://github.com/mohit17mor/SquadAI.git
Set-Location SquadAI\codex-control
npm ci
npm run build
Set-Location ..\codex-agent-manager
npm ci
npm run build
npm start -- --mode embedded --host 127.0.0.1 --port 4317
```

</details>

<details>
<summary><strong>macOS</strong></summary>

Open Terminal and run:

```bash
brew install --cask codex
codex login
git clone https://github.com/mohit17mor/SquadAI.git
cd SquadAI/codex-control
npm ci
npm run build
cd ../codex-agent-manager
npm ci
npm run build
npm start -- --mode embedded --host 127.0.0.1 --port 4317
```

</details>

<details>
<summary><strong>Linux</strong></summary>

Open Terminal and run:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login
git clone https://github.com/mohit17mor/SquadAI.git
cd SquadAI/codex-control
npm ci
npm run build
cd ../codex-agent-manager
npm ci
npm run build
npm start -- --mode embedded --host 127.0.0.1 --port 4317
```

</details>

Open [http://127.0.0.1:4317](http://127.0.0.1:4317), create an agent, choose
its working directory, and send it a task. SquadAI stores your agents and their
conversations locally, so they remain available after a restart.

## Quick How To Use SquadAI

1. Click **Create Agent** (or **Add agent** in the topology view).
2. Choose the machine where the project lives, select its working directory,
   add instructions, and create the agent.
3. Select the agent and send it a message in its conversation, for example:
   `Review this repository and tell me the three riskiest areas.`
4. To test event-driven work, replace `my-coder` with your agent ID (the short,
   lowercase name created for the agent; for example, `Repository Coder` becomes
   `repository-coder`) and send this from a terminal on the control-plane machine:

   ```bash
   curl http://127.0.0.1:4317/api/sensor-events \
     -H 'content-type: application/json' \
     -d '{
       "source": "quick-start",
       "type": "task.requested",
       "body": "Inspect the current project and report the most important next step.",
       "targetAgentId": "my-coder",
       "executionPolicy": "reuse"
     }'
   ```

   The task will appear in the work queue and run on that agent's machine.

> Want your Telegram group connected too? Start with
> `npm start -- --mode embedded --telegram-token YOUR_CONTROL_BOT_TOKEN`, then
> follow [Telegram Group Control](#telegram-group-control).

## Built with Codex and GPT-5.6

SquadAI is built on `codex app-server`, which is the backbone that lets the
control plane create, resume, observe, and manage Codex sessions across
machines.

The entire project was written with Codex using GPT-5.6 Sol and GPT-5.6 Terra;
no other model was used. Sol was used for the major architecture discussions
and the core distributed control-plane pieces. Terra helped implement less
complex features and sharpen ideas before they became requirements.

Codex also helped shape the UI: it generated visual directions, one was chosen
as the reference, and the interface was refined with annotation-based pointed
feedback. Across the project, the GPT-5.6 models were especially useful for
understanding high-level requirements, turning them into concrete work, and
proactively identifying edge cases that had not been specified yet.

## Why SquadAI?

Coding agents are already effective when a person opens one conversation and
gives it one task. The roughness appears when you need several agents, recurring
work, parallel tasks, or long-running workflows:

- conversations become difficult to find and supervise;
- work must be copied manually from one tool or agent to another;
- nothing is listening for new work while you are away;
- multiple tasks aimed at one repository need isolated workspaces;
- approvals, failures, model changes, and unfinished work need one visible home;
- agents may need to run on different laptops, workstations, or VMs.

SquadAI provides the missing operational layer. Codex remains responsible for
reasoning, coding, tools, MCP servers, skills, plugins, and sandboxing. SquadAI
is responsible for organizing agents and work around it.

## What You Get

- **One command center:** See agents, live status, conversations, commentary,
  tool activity, approvals, events, and queued work in one browser UI.
- **Persistent agents:** Resume Codex threads instead of starting every task
  from an empty conversation.
- **Event-driven work:** Send work from issue trackers, webhooks, monitors,
  schedulers, or any system that can call an HTTP endpoint.
- **Reusable or isolated execution:** Reuse one long-running agent for a stream
  of events, or automatically create a separate agent instance for every task.
- **Human control:** Choose Ask for approval, Approve for me, or Full access,
  and answer approval requests from the conversation.
- **Repository isolation:** Git repositories use managed worktrees so parallel
  agent tasks do not edit the same checkout.
- **Remote runners:** Keep the control plane on one machine while agents run
  where the repositories, credentials, skills, plugins, and MCP servers exist.
- **Easy machine enrollment:** Add a Windows, macOS, or Linux runner from the
  UI with one expiring command over a private Tailscale connection.
- **Live runner inventory:** See every control-plane and remote machine,
  connection status, assigned agents, active work, and last heartbeat.
- **Telegram team chat:** Give selected agents their own Telegram bots, tag
  them in one group, and receive their work, approvals, and final summaries in
  the same conversation.
- **Shared skill library:** Import a user skill from one runner and install it
  on another without creating a temporary agent or spending model tokens.
- **Upgrade awareness:** Detect incompatible pinned model settings and request
  a migration decision instead of repeatedly failing without explanation.

## How It Works

```text
People / webhooks / monitors / Telegram
            |
            v
  +-----------------------+
  | SquadAI control plane |
  | UI, API, SQLite, work |
  | queue, approvals      |
  +-----------+-----------+
              |
       commands and events
              |
       +------+------+
       |             |
       v             v
  Local runner   Remote runner(s)
       |             |
       v             v
  codex app-server on each runner machine
       |
       v
  Repositories, Git worktrees, tools, skills, plugins, and MCP servers
```

The control plane stores coordination state and presents the UI. A runner
executes Codex sessions on its own machine and connects outward to the control
plane. This means source code and machine-local tools do not have to be copied
to the control-plane host.

## Core Concepts

### Agent

An agent is a reusable configuration: name, instructions, working directory,
model settings, permissions, selected skills, and runner. Its Codex thread is
created lazily and persisted for later conversations.

### Agent instance

For task-oriented work, SquadAI can create an isolated instance from a base
agent automatically. Each instance receives its own conversation and, for Git
repositories, its own worktree and branch. The defaults allow three active
instances and five unresolved instances per base agent. Select a base agent in
the topology and open **Advanced options** to configure both limits for that
agent. The unresolved limit must always be equal to or greater than the active
limit; existing work is never stopped when a limit is lowered.

### Event and work item

An event is an external signal. It may directly target an agent or wait for
assignment/routing. Once accepted, it becomes a durable work item that SquadAI
dispatches when the target is available.

### Control plane and runner

The control plane owns visibility and coordination. The runner owns execution.
They can run in one process on one computer or on separate machines.

## Add Another Machine (Recommended)

This is the simplest way to run agents on another Windows, macOS, or Linux
machine. The control plane remains on your main machine; source code, Codex,
credentials, MCP servers, and local tools remain on the runner machine.

1. Install Tailscale, Node.js, Codex, and SquadAI on both machines, then sign
   in to the same Tailscale network.
2. Start the control plane on your main machine:

   ```bash
   npm start -- --mode control --host 127.0.0.1 --port 4317
   ```

3. In SquadAI, open **Topology** and choose **Add runner**.
4. Select **Generate enrollment command**. SquadAI finds Tailscale even if its
   command is not on `PATH`, creates a private address, and gives you one
   command to copy.
5. Run that command on the new machine. It enrolls the runner, saves its
   runner-specific credential in `~/.squadai/runner.json`, and connects it.

The first time Tailscale Serve is used, it may require a browser approval. Use
the link shown by SquadAI, approve it once, then generate the enrollment command
again. Enrollment commands expire after ten minutes and can only be used once.

On the runner machine, later reconnect it with:

```bash
squadai runner start
```

To check its last recorded state:

```bash
squadai runner status
```

There is no native installer or background service required for v1. The runner
is simply a process you start on the machine where work should run.

## Permissions

SquadAI exposes three simple presets:

| Mode | Behavior |
| --- | --- |
| **Ask for approval** | Codex pauses for actions that require your decision. Best default for new agents. |
| **Approve for me** | SquadAI reviews supported approval requests automatically while preserving the configured sandbox. |
| **Full access** | Codex can operate without approval in a danger-full-access sandbox. Use only on a trusted machine and repository. |

Permissions can be changed from the agent settings or chat composer. Model and
reasoning changes apply to subsequent turns without discarding the conversation
thread.

## Git Worktrees

When an agent points at a Git repository, SquadAI prepares a managed worktree
under the user's Codex data directory. Instantiated tasks receive separate
branches and worktrees based on the original repository branch. This allows
parallel tasks to modify the same repository without sharing one working tree.

Use **Open in VS Code** from the agent conversation to inspect that agent's
checkout and diff directly. Worktrees are not deleted automatically when they
contain uncommitted changes.

## Event-Driven Work

Any monitor, scheduler, webhook adapter, or application can submit an event:

```bash
curl http://127.0.0.1:4317/api/sensor-events \
  -H 'content-type: application/json' \
  -d '{
    "source": "issue-tracker",
    "type": "issue.created",
    "title": "Investigate a production issue",
    "body": "Find the cause, prepare a fix, and report the evidence.",
    "dedupeKey": "issue:INC-123",
    "targetAgentId": "repository-coder",
    "executionPolicy": "new"
  }'
```

Important fields:

| Field | Meaning |
| --- | --- |
| `source` | System that produced the event. |
| `type` | Source-defined event type. |
| `body` | Work description passed into SquadAI. |
| `dedupeKey` | Optional source identity used to avoid accepting the same event twice. |
| `targetAgentId` | Destination agent ID. Required in the normal setup; omit it only when using a router or assigning the event manually in SquadAI. |
| `executionPolicy` | `reuse` sends work to the base agent; `new` creates an isolated task instance. |

The control plane stays source-agnostic. Integrations should translate external
payloads into this small event contract rather than embedding source-specific
logic in SquadAI.

## Advanced: Manual Runner Connection

The **Add runner** flow above is recommended. Use these commands only when you
already have a private network, VPN, reverse proxy, or tunnel and want to
provide the control-plane address yourself.

### 1. Build SquadAI on both machines

Clone or copy the repository to both machines, install the Codex CLI on every
runner machine, and run the installation commands from the quick start. To use
the convenient `squadai runner …` commands on the runner machine, install the
manager package globally from its built checkout:

```bash
cd codex-agent-manager
npm install -g .
```

### 2. Start the control plane

Bind the control plane only to an address that runner machines can reach over a
trusted network:

```bash
node codex-agent-manager/dist/src/cli.js \
  --mode control \
  --host 0.0.0.0 \
  --port 4317 \
  --runner-token replace-with-a-strong-random-token
```

### 3. Start a runner

On the machine where agents should execute:

```bash
node codex-agent-manager/dist/src/cli.js \
  --mode runner \
  --control-url http://CONTROL_HOST:4317 \
  --runner-id development-machine \
  --runner-name "Development machine" \
  --runner-token replace-with-the-same-token
```

Runner IDs must be unique. Agent names do not identify machines; every agent is
associated with a runner ID.

To enable **Open in VS Code** for a remote runner, provide an SSH host that
exists in the control-plane user's local SSH configuration:

```bash
node codex-agent-manager/dist/src/cli.js \
  --mode runner \
  --control-url http://CONTROL_HOST:4317 \
  --runner-id development-machine \
  --runner-token replace-with-the-same-token \
  --ssh-host development-machine
```

The runner makes outbound HTTP requests to the control plane. If it cannot
directly reach the control plane, use Tailscale, another private overlay
network, a VPN, or an authenticated SSH tunnel—do not expose the port publicly.

The legacy shared runner token remains supported for compatibility. New runner
enrollment creates a distinct runner credential instead.

## Telegram Group Control

Telegram makes SquadAI feel like a team chat: you, your friends, and selected
agents can share one group while each agent still runs on its assigned runner.
There is no agent-to-agent automation in v1; only a human message can start or
resume work.

### 1. Create the control bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and create a bot for
   SquadAI's control plane.
2. Start SquadAI with its token. Passing it as an environment variable is best
   for a long-running service; this command is convenient for local testing:

   ```bash
   npm start -- --mode embedded --telegram-token YOUR_CONTROL_BOT_TOKEN
   ```

3. Add that bot to your Telegram group and make it an administrator. Admin bots
   can receive ordinary group messages. If Telegram still says the bot cannot
   access group messages, use BotFather's `/setprivacy` to disable privacy for
   that bot, then remove and re-add it to the group.

### 2. Connect an agent bot

Create one bot in BotFather for every agent you want to use in Telegram. You do
not need a bot for every SquadAI agent. Add those bots to the same group, then
open the agent's inspector in SquadAI's topology and connect its bot token in
the Telegram section.

Each connected bot represents exactly one agent, which makes replies, running
updates, approvals, and final answers easy to identify in the group.

### 3. Assign work naturally

Tag the desired agent bot in your newest group message:

```text
@coder_bot please implement the login validation
@news_bot give us the five most important AI stories today
```

SquadAI queues work only for bots tagged in that newest message. It also gives
the selected agent the preceding group context (currently the most recent 20
messages) so a reviewer can see what a coder already reported without manual
copying. Bot-authored messages are ignored as new work requests.

Replying to an agent's message continues that agent's work. If the reply tags a
different agent bot, the newly tagged agent takes precedence instead. Multiple
people can use the same group; in v1, the person who started a task is the only
person who can approve or deny its tool request from Telegram.

## Shared Skill Library

Skills normally live in a machine's `~/.codex/skills` directory. SquadAI can
now copy a **user-level** skill to another connected runner without asking a
Codex agent to do the work.

1. Open **Skills** in the SquadAI command rail.
2. Under **Available to import**, choose **Import to library** beside a skill
   found on any online runner.
3. Under **SquadAI library**, choose **Install on …** for any online runner
   that does not already have that skill.

SquadAI packages the complete skill folder, validates paths and file sizes,
stores it with a content fingerprint next to the control-plane database, and
has the target runner write it to its own `~/.codex/skills/<skill-name>` folder.
It never starts a temporary agent and never transfers repo, system, admin, or
plugin-scoped skills. Restart Codex sessions after installing a skill if an
existing session does not refresh its skill catalog immediately.

## Run Modes

For almost every setup, start SquadAI with `--mode embedded`. It starts the
dashboard, runs local agents, **and can connect to remote runners**. This is
also the right mode when you use Telegram.

| Mode | What it means |
| --- | --- |
| `embedded` | The normal control-plane mode. It manages agents on this machine and on any remote runners you connect from the UI. |
| `control` | Currently starts the same control-plane services as `embedded`. Use it only when you want the name to describe a dashboard-first deployment. |
| `runner` | A worker running on another machine. It executes agents against that machine's local projects, tools, skills, and credentials. The UI's **Add runner** flow gives you the command for this. |

## Project Structure

```text
squadai/
├── codex-control/         Stable TypeScript wrapper around codex app-server
├── codex-agent-manager/   Control plane, runner, UI, queues, state, worktrees
└── .github/workflows/     Linux, macOS, and Windows verification
```

## Security Notes

- Keep the control plane on localhost or a trusted private network.
- Prefer the UI's Tailscale enrollment flow for remote runners. Do not expose
  the control-plane port to the public internet.
- Always configure a strong runner token when remote runners are enabled.
- Treat Full access as privileged machine access.
- A runner can access only the files, credentials, tools, skills, plugins, and
  MCP servers available to the user account running that process.
- A connected Telegram group can start work on the bots in that group. Add only
  people you are comfortable letting use those agents.
- The shared skill library stores imported user-skill files beside the
  control-plane SQLite database. Import only skills you trust.
- Review agent worktrees and diffs before merging changes into important
  branches.
- Do not place secrets in agent instructions or event payloads unless your
  deployment is designed to protect them.

## Troubleshooting

### `codex` is not found

Restart the terminal after installing Codex and confirm that `codex --version`
works. You can also pass an explicit executable:

```bash
npm start -- --mode embedded --codex-binary /path/to/codex
```

On Windows, SquadAI can resolve native executables and npm-installed
`codex.cmd`/`codex.bat` launchers from `PATH`.

### Codex is installed but agents cannot start

Run:

```bash
codex
codex app-server --help
```

Complete authentication if prompted. Also confirm that the agent's working
directory exists on its selected runner.

### A runner appears offline

Check that:

- its control URL is reachable from the runner machine;
- the control plane and runner use the same token;
- its runner ID is unique;
- no firewall or proxy is interrupting long-polling HTTP requests.

For the recommended enrollment flow, also confirm both machines are signed in
to the same Tailscale network. If SquadAI shows a Tailscale approval link, open
it once, approve the private Serve configuration, and generate a new enrollment
command.

### Telegram messages do not queue work

Confirm that the control bot is running with `SQUADAI_TELEGRAM_TOKEN` (or
`--telegram-token`), is an administrator in the group, and has permission to
read group messages. Confirm the agent bot is connected to the intended agent
in SquadAI and that your newest human message tags that exact bot.

### A shared skill is missing

The Skills panel lists only online runners and Codex **user** skills. Confirm
the source skill is under `~/.codex/skills`, the source runner is online, and
the target runner has not already installed a skill with the same name.

### A pinned model stopped working

Open the compatibility notification in SquadAI. The control plane can compare
the agent's pinned settings with the current Codex model catalog and request
approval before migrating it.

### Worktree cleanup fails

SquadAI intentionally refuses to remove a dirty worktree. Commit, stash, or
discard its changes explicitly, then retry cleanup.

## Development

Run both test suites:

```bash
cd codex-control
npm test

cd ../codex-agent-manager
npm test
```

The SquadAI manager currently has 110 automated tests, with additional control
library coverage. GitHub Actions can run both suites on Linux, macOS, and
Windows.

## Current Scope

SquadAI currently focuses on managing Codex agents. The architecture separates
the control plane from the runtime so additional agent providers can be added
later, but they are not implemented today. Visual agent-to-agent workflow
chaining is also a future direction; current automation uses explicit event
targets, optional routing, durable work items, Telegram human-to-agent
handoffs, and isolated agent instances.

## Codex Documentation

- [Codex quickstart](https://developers.openai.com/codex/quickstart?setup=cli)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex on Windows](https://developers.openai.com/codex/windows)

## License

Licensed under the [MIT License](LICENSE).
