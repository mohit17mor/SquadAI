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

## Add a remote runner

This flow is the same on Windows, macOS, and Linux and does not require a
native installer or background service.

1. Connect the control-plane machine and the new runner machine to the same
   Tailscale network.
2. Start SquadAI on the control plane using its Tailscale address, for example:

   ```bash
   npm start -- --mode control --host 100.64.0.10 --port 4317
   ```

3. Open that address in the browser and choose **Add runner** in the topology
   toolbar.
4. On the new machine, install Node.js, Codex, and the SquadAI CLI. From a
   source checkout, `npm install -g .` installs the CLI.
5. Run the one-time command shown by the UI. It enrolls the machine, saves its
   runner-specific credential in `~/.squadai/runner.json`, and connects
   immediately.

Later, reconnect the enrolled machine with:

```bash
squadai runner start
```

Check its last reported status with:

```bash
squadai runner status
```

Enrollment commands expire after ten minutes and work only once. Existing
shared-token runner arguments remain supported for compatibility.

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
