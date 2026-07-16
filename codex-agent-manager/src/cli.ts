#!/usr/bin/env node
import { resolve } from "node:path";

import { createDefaultClientFactory } from "./codexControlFactory.js";
import { GitWorkspaceManager } from "./gitWorkspace.js";
import { CodexAgentManager } from "./manager.js";
import { RunnerDaemon } from "./runnerDaemon.js";
import { RunnerAwareWorkspaceManager, RunnerHub } from "./runnerHub.js";
import { createCommandCenterServer } from "./server.js";
import { SqliteAgentStateStore } from "./stateStore.js";
import { SqliteTelegramMessageStore, TelegramListener } from "./telegram.js";
import { SqliteTelegramAgentBindingStore, TelegramAgentBindingService } from "./telegramBindings.js";
import { SqliteTelegramRequestStore, TelegramMentionIntake } from "./telegramRequests.js";
import type { RoutingMode } from "./types.js";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg?.startsWith("--")) {
    continue;
  }
  const next = process.argv[index + 1];
  args.set(arg.slice(2), next && !next.startsWith("--") ? next : "true");
}

const port = Number(args.get("port") ?? process.env.CODEX_AGENT_MANAGER_PORT ?? 4317);
const host = args.get("host") ?? process.env.CODEX_AGENT_MANAGER_HOST ?? "127.0.0.1";
const mode = args.get("mode") ?? process.env.CODEX_AGENT_MANAGER_MODE ?? "embedded";
const runnerToken = args.get("runner-token") ?? process.env.CODEX_AGENT_MANAGER_RUNNER_TOKEN ?? "";
const statePath = resolve(
  args.get("state") ?? process.env.CODEX_AGENT_MANAGER_STATE ?? "./codex-agents.state.json",
);
const databasePath = resolve(
  args.get("database") ?? process.env.CODEX_AGENT_MANAGER_DATABASE ?? "./command-center.db",
);
const codexBinary = args.get("codex-binary");
const telegramToken = args.get("telegram-token") ?? process.env.SQUADAI_TELEGRAM_TOKEN;
const routingMode = parseRoutingMode(
  args.get("routing-mode") ?? process.env.CODEX_AGENT_MANAGER_ROUTING_MODE ?? "explicit",
);
if (codexBinary) {
  process.env.CODEX_BINARY = codexBinary;
}

if (mode === "runner") {
  const controlUrl = args.get("control-url") ?? process.env.CODEX_AGENT_MANAGER_CONTROL_URL;
  const runnerId = args.get("runner-id") ?? process.env.CODEX_AGENT_MANAGER_RUNNER_ID;
  if (!controlUrl) throw new Error("Runner mode requires --control-url or CODEX_AGENT_MANAGER_CONTROL_URL.");
  if (!runnerId) throw new Error("Runner mode requires --runner-id or CODEX_AGENT_MANAGER_RUNNER_ID.");
  const runnerName = args.get("runner-name") ?? process.env.CODEX_AGENT_MANAGER_RUNNER_NAME;
  const sshHost = args.get("ssh-host") ?? process.env.CODEX_AGENT_MANAGER_SSH_HOST;
  const daemon = new RunnerDaemon({
    controlUrl,
    token: runnerToken,
    id: runnerId,
    ...(runnerName ? { name: runnerName } : {}),
    ...(sshHost ? { sshHost } : {}),
  });
  console.log(`SquadAI runner ${runnerId} connecting to ${controlUrl}`);
  for (const signal of shutdownSignals()) {
    process.once(signal, () => void daemon.close().finally(() => process.exit(0)));
  }
  await daemon.start();
  process.exit(0);
}

if (mode !== "embedded" && mode !== "control") {
  throw new Error(`Invalid mode: ${mode}. Use embedded, control, or runner.`);
}

const runnerHub = new RunnerHub(runnerToken);
const localClientFactory = createDefaultClientFactory();

const manager = new CodexAgentManager({
  agents: [],
  stateStore: new SqliteAgentStateStore(databasePath, { legacyJsonPath: statePath }),
  routingMode,
  clientFactory: runnerHub.createClientFactory(localClientFactory),
  workspaceManager: new RunnerAwareWorkspaceManager(runnerHub, new GitWorkspaceManager()),
});
const telegramStore = telegramToken ? new SqliteTelegramMessageStore(databasePath) : null;
const telegramBindingStore = new SqliteTelegramAgentBindingStore(databasePath);
const telegramBindings = new TelegramAgentBindingService({
  store: telegramBindingStore,
  agentExists: (agentId) => {
    try {
      manager.getAgent(agentId);
      return true;
    } catch {
      return false;
    }
  },
});
const telegramRequestStore = new SqliteTelegramRequestStore(databasePath);
const telegramMentionIntake = new TelegramMentionIntake({
  bindings: telegramBindings,
  store: telegramRequestStore,
});
const server = createCommandCenterServer({
  manager,
  runnerHub,
  telegramBindings,
  telegramMentionIntake,
});
const telegramListener = telegramToken && telegramStore
  ? new TelegramListener({
      token: telegramToken,
      store: telegramStore,
      onMessage: (message) => {
        telegramMentionIntake.processMessage(message);
      },
    })
  : null;
let telegramRun: Promise<void> | undefined;

await manager.start();
await server.listen(port, host);
telegramRun = telegramListener?.start();
console.log(`SquadAI listening at http://${host}:${server.port}`);
console.log(`Database: ${databasePath}`);
console.log(`Legacy state backup: ${statePath}`);
console.log(`Codex binary: ${process.env.CODEX_BINARY ?? "auto"}`);
console.log(`Routing mode: ${routingMode}`);
console.log(`Mode: ${mode}`);
console.log(`Remote runners: ${runnerToken ? "token protected" : "development mode (no token)"}`);
console.log(`Telegram listener: ${telegramListener ? "enabled" : "disabled"}`);

for (const signal of shutdownSignals()) {
  process.once(signal, () => {
    void shutdown();
  });
}

async function shutdown(): Promise<void> {
  await telegramListener?.close().catch(() => {});
  await telegramRun?.catch(() => {});
  await telegramStore?.close().catch(() => {});
  await telegramBindingStore.close().catch(() => {});
  await telegramRequestStore.close().catch(() => {});
  await server.close().catch(() => {});
  await manager.close().catch(() => {});
  process.exit(0);
}

function shutdownSignals(): NodeJS.Signals[] {
  return process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM"];
}

function parseRoutingMode(value: string): RoutingMode {
  if (value === "explicit" || value === "router-fallback" || value === "router-only") {
    return value;
  }
  throw new Error(`Invalid routing mode: ${value}`);
}
