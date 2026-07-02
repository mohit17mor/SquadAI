#!/usr/bin/env node
import { resolve } from "node:path";

import { CodexAgentManager } from "./manager.js";
import { createCommandCenterServer } from "./server.js";
import { JsonFileAgentStateStore } from "./stateStore.js";

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
const codexBinary = args.get("codex-binary");
if (codexBinary) {
  process.env.CODEX_BINARY = codexBinary;
}

const manager = new CodexAgentManager({
  agents: [],
  stateStore: new JsonFileAgentStateStore(statePath),
});
const server = createCommandCenterServer({ manager });

await manager.start();
await server.listen(port, host);
console.log(`Jarvis Command Center listening at http://${host}:${server.port}`);
console.log(`State: ${statePath}`);
console.log(`Codex binary: ${process.env.CODEX_BINARY ?? "auto"}`);

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
