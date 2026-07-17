import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneShutdown } from "../src/shutdown.js";

test("control plane shutdown stops HTTP before closing databases and runs only once", async () => {
  const calls: string[] = [];
  let serverAcceptingRequests = true;
  let databaseOpen = true;
  const shutdown = createControlPlaneShutdown({
    async stopInputs() {
      calls.push("inputs");
    },
    async stopServer() {
      assert.equal(databaseOpen, true);
      serverAcceptingRequests = false;
      calls.push("server");
    },
    async closeServices() {
      assert.equal(serverAcceptingRequests, false);
      databaseOpen = false;
      calls.push("services");
    },
    onComplete() {
      calls.push("complete");
    },
  });

  const first = shutdown();
  const second = shutdown();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["inputs", "server", "services", "complete"]);
});
