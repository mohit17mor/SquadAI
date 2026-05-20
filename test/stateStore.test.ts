import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonFileAgentStateStore } from "../src/index.js";

test("json file state store handles concurrent saves with same clock tick", async () => {
  const originalNow = Date.now;
  const dir = await mkdtemp(join(tmpdir(), "codex-agent-state-"));
  const store = new JsonFileAgentStateStore(join(dir, "agents.state.json"));
  Date.now = () => 1234;

  try {
    await Promise.all([
      store.save({ events: [{ id: 1, agentId: "a", type: "turn_started", message: "one", payload: {}, createdAt: "now" }] }),
      store.save({ events: [{ id: 2, agentId: "b", type: "turn_completed", message: "two", payload: {}, createdAt: "now" }] }),
    ]);
    const loaded = await store.load();
    assert.equal(loaded.version, 1);
    assert.equal(loaded.events?.length, 1);
  } finally {
    Date.now = originalNow;
  }
});
