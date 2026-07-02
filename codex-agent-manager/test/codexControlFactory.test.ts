import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDefaultClientFactory } from "../src/index.js";

test("default client factory lazily loads codex-control and forwards context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-control-factory-"));
  const modulePath = join(dir, "fake-codex-control.mjs");
  const events: Array<Record<string, unknown>> = [];
  (globalThis as typeof globalThis & { __codexAgentManagerFactoryEvents?: typeof events })
    .__codexAgentManagerFactoryEvents = events;

  await writeFile(
    modulePath,
    `
const events = globalThis.__codexAgentManagerFactoryEvents;
export class CodexControlClient {
  constructor(options) {
    events.push({ type: "construct", hasApprovalHandler: typeof options.approvalHandler === "function" });
  }

  async startSession(options) {
    events.push({ type: "start", options });
    return { threadId: "started-thread" };
  }

  async resumeSession(threadId) {
    events.push({ type: "resume", threadId });
    return { threadId };
  }

  async listModels(options) {
    events.push({ type: "listModels", options });
    return { models: [{ id: "gpt-test", model: "gpt-test" }] };
  }

  async getRuntimeInfo() {
    events.push({ type: "runtimeInfo" });
    return { userAgent: "codex_cli_rs/0.130.0", platformFamily: "unix", platformOs: "macos", codexHome: "/tmp/codex" };
  }

  async close() {
    events.push({ type: "close" });
  }
}
`,
    "utf8",
  );

  const factory = createDefaultClientFactory(modulePath);
  const client = factory({
    agentId: "maintenance",
    approvalHandler: () => ({ decision: "approved" }),
  });

  assert.deepEqual(events, []);
  assert.equal((await client.startSession({ cwd: "/tmp/ops-poc" })).threadId, "started-thread");
  assert.equal((await client.resumeSession("existing-thread")).threadId, "existing-thread");
  assert.deepEqual(await client.listModels?.({ includeHidden: true }), {
    models: [{ id: "gpt-test", model: "gpt-test" }],
  });
  assert.equal((await client.getRuntimeInfo?.())?.userAgent, "codex_cli_rs/0.130.0");
  await client.close();

  assert.deepEqual(events, [
    { type: "construct", hasApprovalHandler: true },
    { type: "start", options: { cwd: "/tmp/ops-poc" } },
    { type: "resume", threadId: "existing-thread" },
    { type: "listModels", options: { includeHidden: true } },
    { type: "runtimeInfo" },
    { type: "close" },
  ]);
});

test("default client factory close is a no-op before the client is loaded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-control-factory-"));
  const modulePath = join(dir, "fake-codex-control.mjs");
  await writeFile(
    modulePath,
    "export class CodexControlClient { constructor() { throw new Error('should not load'); } }\n",
    "utf8",
  );

  const client = createDefaultClientFactory(modulePath)();

  await client.close();
});
