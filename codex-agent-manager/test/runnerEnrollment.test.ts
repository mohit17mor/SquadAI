import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decodeRunnerEnrollmentBundle,
  enrollRunner,
  loadRunnerConfig,
  SqliteRunnerEnrollmentStore,
} from "../src/index.js";
import type { RunnerRegistration } from "../src/types.js";

test("runner enrollment creates a one-time credential bound to one runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "squadai-runner-enrollment-"));
  const store = new SqliteRunnerEnrollmentStore(join(root, "command-center.db"));
  try {
    const enrollment = store.create("http://100.64.0.10:4317/");
    const decoded = decodeRunnerEnrollmentBundle(enrollment.bundle);
    assert.equal(decoded.controlUrl, "http://100.64.0.10:4317");
    assert.match(enrollment.command, /^squadai runner connect sq1_/);

    const credential = store.exchange(decoded.code, registration("build-machine"));
    assert.equal(credential.runnerId, "build-machine");
    assert.equal(store.authenticate(credential.runnerId, credential.token), true);
    assert.equal(store.authenticate(credential.runnerId, "wrong"), false);
    assert.equal(store.authenticate("another-runner", credential.token), false);
    assert.throws(
      () => store.exchange(decoded.code, registration("another-runner")),
      /already been used/i,
    );
  } finally {
    await store.close();
  }
});

test("runner enrollment expires and duplicate machine IDs receive unique identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "squadai-runner-expiry-"));
  let now = new Date("2026-07-16T10:00:00.000Z");
  const store = new SqliteRunnerEnrollmentStore(join(root, "command-center.db"), () => now);
  try {
    const first = decodeRunnerEnrollmentBundle(store.create("https://control.tailnet.ts.net").bundle);
    const firstCredential = store.exchange(first.code, registration("workstation"));
    const second = decodeRunnerEnrollmentBundle(store.create("https://control.tailnet.ts.net").bundle);
    const secondCredential = store.exchange(second.code, registration("workstation"));
    assert.equal(firstCredential.runnerId, "workstation");
    assert.match(secondCredential.runnerId, /^workstation-/);

    const expired = decodeRunnerEnrollmentBundle(
      store.create("https://control.tailnet.ts.net", 1_000).bundle,
    );
    now = new Date("2026-07-16T10:00:02.000Z");
    assert.throws(
      () => store.exchange(expired.code, registration("late-runner")),
      /expired/i,
    );
  } finally {
    await store.close();
  }
});

test("runner connect exchanges the bundle and saves reusable cross-platform config", async () => {
  const root = await mkdtemp(join(tmpdir(), "squadai-runner-config-"));
  const configPath = join(root, ".squadai", "runner.json");
  let exchangeRunnerName = "";
  const config = await enrollRunner(
    "sq1_" + Buffer.from(JSON.stringify({
      v: 1,
      controlUrl: "https://control.tailnet.ts.net",
      code: "one-time-code",
    })).toString("base64url"),
    {
      name: "Review machine",
      sshHost: "review-machine",
      configPath,
      fetch: async (_input, init) => {
        const exchangeBody = JSON.parse(String(init?.body)) as { runner: RunnerRegistration };
        exchangeRunnerName = exchangeBody.runner.name;
        return new Response(JSON.stringify({
          controlUrl: "https://control.tailnet.ts.net",
          runnerId: "review-machine",
          token: "runner-token",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  assert.equal(exchangeRunnerName, "Review machine");
  assert.equal(config.id, "review-machine");
  assert.equal(config.sshHost, "review-machine");
  assert.deepEqual(await loadRunnerConfig(configPath), config);
  assert.doesNotMatch(await readFile(configPath, "utf8"), /one-time-code/);
});

function registration(id: string): RunnerRegistration {
  return {
    id,
    name: id,
    hostname: `${id}.local`,
    platform: "linux",
    arch: "arm64",
    version: "test",
  };
}
