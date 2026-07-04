#!/usr/bin/env node
import { resolve } from "node:path";

import { CodexAgentManager } from "./manager.js";
import { createCommandCenterServer } from "./server.js";
import { SqliteAgentStateStore } from "./stateStore.js";
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
const statePath = resolve(
  args.get("state") ?? process.env.CODEX_AGENT_MANAGER_STATE ?? "./codex-agents.state.json",
);
const databasePath = resolve(
  args.get("database") ?? process.env.CODEX_AGENT_MANAGER_DATABASE ?? "./command-center.db",
);
const codexBinary = args.get("codex-binary");
const routingMode = parseRoutingMode(
  args.get("routing-mode") ?? process.env.CODEX_AGENT_MANAGER_ROUTING_MODE ?? "explicit",
);
if (codexBinary) {
  process.env.CODEX_BINARY = codexBinary;
}

const manager = new CodexAgentManager({
  agents: [],
  stateStore: new SqliteAgentStateStore(databasePath, { legacyJsonPath: statePath }),
  routingMode,
});
const server = createCommandCenterServer({ manager });

await manager.start();
await server.listen(port, host);
console.log(`Jarvis Command Center listening at http://${host}:${server.port}`);
console.log(`Database: ${databasePath}`);
console.log(`Legacy state backup: ${statePath}`);
console.log(`Codex binary: ${process.env.CODEX_BINARY ?? "auto"}`);
console.log(`Routing mode: ${routingMode}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown();
  });
}

async function shutdown(): Promise<void> {
  await server.close().catch(() => {});
  await manager.close().catch(() => {});
  process.exit(0);
}

function parseRoutingMode(value: string): RoutingMode {
  if (value === "explicit" || value === "router-fallback" || value === "router-only") {
    return value;
  }
  throw new Error(`Invalid routing mode: ${value}`);
}
