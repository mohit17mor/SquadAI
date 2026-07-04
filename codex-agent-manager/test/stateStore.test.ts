import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonFileAgentStateStore, SqliteAgentStateStore } from "../src/index.js";

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

test("sqlite state store imports legacy json once and pages activity events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-agent-sqlite-"));
  const legacyPath = join(dir, "agents.state.json");
  const databasePath = join(dir, "command-center.db");
  await writeFile(legacyPath, JSON.stringify({
    version: 1,
    agents: {
      alpha: {
        definition: { id: "alpha", name: "Alpha", cwd: dir, instructions: "Help." },
        status: "idle",
      },
    },
    events: [
      { id: 1, agentId: "alpha", type: "turn_started", message: "one", payload: {}, createdAt: "2026-01-01T00:00:00Z" },
      { id: 2, agentId: "alpha", type: "approval_requested", message: "two", payload: { approvalId: "approval-7" }, createdAt: "2026-01-01T00:00:01Z" },
      { id: 3, agentId: "beta", type: "turn_completed", message: "three", payload: {}, createdAt: "2026-01-01T00:00:02Z" },
    ],
    sensorEvents: [],
    workItems: [],
    notifications: [],
    compatibilityApprovals: [],
  }), "utf8");

  const store = new SqliteAgentStateStore(databasePath, { legacyJsonPath: legacyPath });
  const loaded = await store.load();
  assert.equal(Object.keys(loaded.agents ?? {}).length, 1);
  assert.equal(loaded.events, undefined);
  assert.deepEqual(store.eventCursor(), { maxEventId: 3, maxApprovalId: 7 });

  const latest = store.queryEvents({ limit: 2 });
  assert.deepEqual(latest.events.map((event) => event.id), [2, 3]);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.nextBeforeId, 2);
  assert.deepEqual(
    store.queryEvents({ agentId: "alpha" }).events.map((event) => event.id),
    [1, 2],
  );

  await store.appendEvent({
    id: 4,
    agentId: "alpha",
    type: "turn_completed",
    message: "new database event",
    payload: {},
    createdAt: "2026-01-01T00:00:03Z",
  });
  await store.close();

  const reopened = new SqliteAgentStateStore(databasePath, { legacyJsonPath: legacyPath });
  await reopened.load();
  assert.deepEqual(reopened.queryEvents().events.map((event) => event.id), [1, 2, 3, 4]);
  await reopened.close();
});
