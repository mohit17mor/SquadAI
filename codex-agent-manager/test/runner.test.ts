import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexAgentManager,
  MemoryAgentStateStore,
  RunnerDaemon,
  RunnerHub,
} from "../src/index.js";
import { expandHomePath } from "../src/runnerDaemon.js";
import type {
  AgentDefinition,
  AgentWorkspaceManager,
  ApprovalHandler,
  CodexControlClientContext,
  CodexControlClientFactory,
  CodexSessionLike,
  RunnerCommandCompletion,
  RunnerCommandEvent,
  RunnerRegistration,
} from "../src/types.js";

test("runner hub dispatches commands and tracks runner health", async () => {
  const hub = new RunnerHub("secret");
  assert.equal(hub.authenticate("secret"), true);
  assert.equal(hub.authenticate("wrong"), false);
  hub.register(registration("vm-1"));

  const resultPromise = hub.execute("vm-1", "runtime.info", "catalog");
  const command = await hub.poll("vm-1", 100);
  assert.equal(command?.type, "runtime.info");
  hub.complete("vm-1", command?.id ?? "", {
    ok: true,
    value: { userAgent: "codex-test" },
  });

  assert.deepEqual(await resultPromise, { userAgent: "codex-test" });
  assert.equal(hub.getRunner("vm-1").activeCommands, 0);
});

test("remote runner advertises its SSH host and browses its filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "command-center-runner-directory-"));
  await mkdir(join(root, "alpha"));
  await mkdir(join(root, "Beta"));
  const hub = new RunnerHub("secret");
  const daemon = new RunnerDaemon({
    controlUrl: "http://control.test",
    token: "secret",
    id: "vm-browser",
    name: "Browser VM",
    sshHost: "browser-vm",
    clientFactory: fakeRunnerClientFactory(),
    fetch: hubFetch(hub),
  });
  const daemonRun = daemon.start();
  try {
    await waitFor(() => hub.listRunners().some((runner) => runner.id === "vm-browser"));

    const runner = hub.getRunner("vm-browser");
    assert.equal(runner.sshHost, "browser-vm");
    const listing = await hub.execute(
      "vm-browser",
      "filesystem.listDirectories",
      "directory-browser",
      { path: root },
    ) as { path: string; directories: Array<{ name: string; path: string }> };
    assert.equal(listing.path, await realpath(root));
    assert.deepEqual(
      new Set(listing.directories.map((entry) => entry.name)),
      new Set(["alpha", "Beta"]),
    );
    await assert.rejects(
      hub.execute("vm-browser", "filesystem.listDirectories", "directory-browser", {
        path: join(root, "missing"),
      }),
      /ENOENT|does not exist/,
    );
  } finally {
    await daemon.close();
    await daemonRun;
  }
});

test("runner expands both Unix and Windows home path syntax", () => {
  assert.equal(expandHomePath("~/repo", "/home/dev"), join("/home/dev", "repo"));
  assert.equal(expandHomePath("~\\repo", "C:\\Users\\dev"), join("C:\\Users\\dev", "repo"));
  assert.equal(expandHomePath("C:\\work\\repo", "C:\\Users\\dev"), "C:\\work\\repo");
});

test("remote runner executes a Codex turn and forwards activity and approvals", async () => {
  const hub = new RunnerHub("secret");
  const localFactory: CodexControlClientFactory = () => {
    throw new Error("The control plane must not start a local Codex client for a remote agent.");
  };
  const manager = new CodexAgentManager({
    agents: [{
      id: "remote-worker",
      name: "Remote worker",
      runnerId: "vm-1",
      cwd: "/workspace/repo",
      instructions: "Work remotely.",
    }],
    stateStore: new MemoryAgentStateStore(),
    clientFactory: hub.createClientFactory(localFactory),
    workspaceManager: identityWorkspaceManager(),
  });
  await manager.start();

  const daemon = new RunnerDaemon({
    controlUrl: "http://control.test",
    token: "secret",
    id: "vm-1",
    clientFactory: fakeRunnerClientFactory(),
    fetch: hubFetch(hub),
  });
  const daemonRun = daemon.start();
  await waitFor(() => hub.listRunners().some((runner) => runner.id === "vm-1"));

  const approvalRequested = new Promise<{ payload: Record<string, unknown> }>((resolve) => {
    const listener = (event: { type: string; payload: Record<string, unknown> }) => {
      if (event.type !== "approval_requested") return;
      manager.off("event", listener);
      resolve(event);
    };
    manager.on("event", listener);
  });
  const send = manager.sendToAgent("remote-worker", "inspect the repository");
  const approval = await approvalRequested;
  await manager.resolveApproval(String(approval.payload.approvalId), "approved");
  const result = await send;

  assert.equal(result.finalText, "remote result");
  assert.equal(manager.getAgent("remote-worker").runnerId, "vm-1");
  assert.ok(manager.listEvents("remote-worker").some((event) => event.type === "codex_item_completed"));
  assert.ok(manager.listEvents("remote-worker").some((event) => event.type === "approval_resolved"));

  await manager.close();
  await daemon.close();
  await daemonRun;
});

function registration(id: string): RunnerRegistration {
  return {
    id,
    name: id,
    hostname: `${id}.test`,
    platform: "linux",
    arch: "arm64",
    version: "test",
  };
}

function identityWorkspaceManager(): AgentWorkspaceManager {
  return {
    async prepareBase(definition) { return definition; },
    async prepareInstance(_base, instance) { return instance; },
    async inspect() { return null; },
    async cleanup(definition) { return definition; },
  };
}

function fakeRunnerClientFactory(): CodexControlClientFactory {
  return (context?: CodexControlClientContext) => {
    let session: FakeSession | null = null;
    return {
      async startSession() {
        session = new FakeSession(context?.approvalHandler);
        return session;
      },
      async resumeSession() {
        session = new FakeSession(context?.approvalHandler);
        return session;
      },
      async close() {},
    };
  };
}

class FakeSession extends EventEmitter implements CodexSessionLike {
  readonly threadId = "remote-thread-1";

  constructor(private readonly approvalHandler?: ApprovalHandler) {
    super();
  }

  async ask() {
    this.emit("item.completed", {
      id: "item-1",
      type: "commandExecution",
      command: "git status",
      status: "completed",
    });
    const response = await this.approvalHandler?.({
      timestamp: new Date().toISOString(),
      kind: "command_approval",
      method: "item/commandExecution/requestApproval",
      params: { command: "git status" },
      proposedDecision: "approved",
      proposedResult: null,
    });
    assert.equal(response?.decision, "approved");
    return {
      finalText: "remote result",
      threadId: this.threadId,
      turn: { status: "completed" },
    };
  }
}

function hubFetch(hub: RunnerHub): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    try {
      const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.pathname === "/api/runners/register") {
        return jsonResponse({ runner: hub.register(body as RunnerRegistration) });
      }
      const heartbeat = url.pathname.match(/^\/api\/runners\/([^/]+)\/heartbeat$/);
      if (heartbeat?.[1]) return jsonResponse({ runner: hub.heartbeat(decodeURIComponent(heartbeat[1])) });
      const poll = url.pathname.match(/^\/api\/runners\/([^/]+)\/poll$/);
      if (poll?.[1]) {
        const command = await hub.poll(
          decodeURIComponent(poll[1]),
          Number(body.timeoutMs ?? 25_000),
          init?.signal ?? undefined,
        );
        return jsonResponse({ command });
      }
      const event = url.pathname.match(/^\/api\/runners\/([^/]+)\/commands\/([^/]+)\/events$/);
      if (event?.[1] && event[2]) {
        return jsonResponse(await hub.reportEvent(
          decodeURIComponent(event[1]),
          decodeURIComponent(event[2]),
          body as RunnerCommandEvent,
        ));
      }
      const complete = url.pathname.match(/^\/api\/runners\/([^/]+)\/commands\/([^/]+)\/complete$/);
      if (complete?.[1] && complete[2]) {
        hub.complete(
          decodeURIComponent(complete[1]),
          decodeURIComponent(complete[2]),
          body as RunnerCommandCompletion,
        );
        return jsonResponse({ completed: true });
      }
      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
