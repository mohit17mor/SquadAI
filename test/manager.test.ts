import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexAgentManager,
  type AgentDefinition,
  type CodexControlClientContext,
  type CodexControlClientFactory,
} from "../src/index.js";

class FakeCodexClient {
  readonly startCalls: Array<Record<string, unknown>> = [];
  readonly resumeCalls: string[] = [];
  readonly closeCalls: number[] = [];
  private nextThread = 1;
  private readonly sessions = new Map<string, FakeCodexSession>();

  async startSession(options: Record<string, unknown>): Promise<FakeCodexSession> {
    this.startCalls.push(options);
    const session = new FakeCodexSession(`thread-${this.nextThread++}`);
    this.sessions.set(session.threadId, session);
    return session;
  }

  async resumeSession(threadId: string): Promise<FakeCodexSession> {
    this.resumeCalls.push(threadId);
    const session = new FakeCodexSession(threadId);
    this.sessions.set(threadId, session);
    return session;
  }

  async close(): Promise<void> {
    this.closeCalls.push(Date.now());
  }

  session(threadId: string): FakeCodexSession {
    const session = this.sessions.get(threadId);
    assert.ok(session, `expected fake session ${threadId}`);
    return session;
  }
}

class FakeCodexSession {
  readonly asks: Array<{ input: string; options: Record<string, unknown> }> = [];
  pending:
    | {
        input: string;
        resolve: (value: { finalText: string; threadId: string; turn: Record<string, unknown> }) => void;
        reject: (error: Error) => void;
      }
    | null = null;

  constructor(readonly threadId: string) {}

  async ask(
    input: string,
    options: Record<string, unknown>,
  ): Promise<{ finalText: string; threadId: string; turn: Record<string, unknown> }> {
    this.asks.push({ input, options });
    return new Promise((resolve, reject) => {
      this.pending = { input, resolve, reject };
    });
  }

  complete(finalText = "done"): void {
    assert.ok(this.pending, "expected pending ask");
    const pending = this.pending;
    this.pending = null;
    pending.resolve({
      finalText,
      threadId: this.threadId,
      turn: { status: "completed" },
    });
  }
}

function fakeFactory(clients: FakeCodexClient[] = []): CodexControlClientFactory {
  return () => {
    const client = new FakeCodexClient();
    clients.push(client);
    return client;
  };
}

function contextualFakeFactory(
  clients: FakeCodexClient[] = [],
  contexts: CodexControlClientContext[] = [],
): CodexControlClientFactory {
  return (context) => {
    assert.ok(context, "expected client context");
    contexts.push(context);
    const client = new FakeCodexClient();
    clients.push(client);
    return client;
  };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "maintenance",
    name: "Maintenance Debugger",
    cwd: "/tmp/ops-poc",
    instructions: "You specialize in read-only maintenance debugging.",
    ...overrides,
  };
}

test("starts named agents lazily and sends plain text to the matching session", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(clients),
  });

  assert.equal(manager.listAgents()[0]?.status, "idle");

  const send = manager.sendToAgent("maintenance", "Please inspect this incident.", {
    timeoutMs: 1234,
    network: "allow",
  });
  await waitFor(() => clients.length === 1, "maintenance client");

  assert.equal(manager.getAgent("maintenance").status, "running");
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0]?.startCalls[0], {
    cwd: "/tmp/ops-poc",
    model: undefined,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    developerInstructions: "You specialize in read-only maintenance debugging.",
    dynamicTools: undefined,
  });

  clients[0]?.session("thread-1").complete("classification complete");
  const result = await send;

  assert.equal(result.agentId, "maintenance");
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.finalText, "classification complete");
  assert.equal(manager.getAgent("maintenance").status, "idle");
  assert.deepEqual(clients[0]?.session("thread-1").asks[0], {
    input: "Please inspect this incident.",
    options: { timeoutMs: 1234, network: "allow" },
  });
});

test("rejects concurrent sends to the same agent while allowing another agent to run", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [
      agent(),
      agent({ id: "storage", name: "storage Debugger", instructions: "You specialize in storage incidents." }),
    ],
    clientFactory: fakeFactory(clients),
  });

  const first = manager.sendToAgent("maintenance", "first");
  await waitFor(() => clients.length === 1, "first agent client");
  await assert.rejects(
    manager.sendToAgent("maintenance", "second"),
    /already running/i,
  );

  const secondAgent = manager.sendToAgent("storage", "parallel");
  await waitFor(() => clients.length === 2, "second agent client");
  assert.equal(manager.getAgent("maintenance").status, "running");
  assert.equal(manager.getAgent("storage").status, "running");

  clients[0]?.session("thread-1").complete("first done");
  clients[1]?.session("thread-1").complete("parallel done");

  assert.equal((await first).finalText, "first done");
  assert.equal((await secondAgent).finalText, "parallel done");
});

test("resumes persisted thread ids instead of starting new Codex threads", async () => {
  const clients: FakeCodexClient[] = [];
  const state = {
    agents: {
      maintenance: {
        threadId: "existing-thread",
        status: "idle" as const,
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z",
      },
    },
  };
  const manager = new CodexAgentManager({
    agents: [agent()],
    stateStore: {
      async load() {
        return state;
      },
      async save(nextState) {
        Object.assign(state, nextState);
      },
    },
    clientFactory: fakeFactory(clients),
  });

  await manager.start();
  const send = manager.sendToAgent("maintenance", "continue");
  await waitFor(() => clients.length === 1, "resumed client");

  assert.deepEqual(clients[0]?.resumeCalls, ["existing-thread"]);
  assert.deepEqual(clients[0]?.startCalls, []);

  clients[0]?.session("existing-thread").complete("resumed");
  assert.equal((await send).threadId, "existing-thread");
});

test("emits durable status events for agent lifecycle transitions", async () => {
  const clients: FakeCodexClient[] = [];
  const events: string[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(clients),
  });
  manager.on("event", (event) => {
    events.push(`${event.agentId}:${event.type}`);
  });

  const send = manager.sendToAgent("maintenance", "hello");
  await waitFor(() => clients.length === 1, "event test client");
  clients[0]?.session("thread-1").complete("hello back");
  await send;

  assert.deepEqual(events, [
    "maintenance:agent_starting",
    "maintenance:agent_started",
    "maintenance:turn_started",
    "maintenance:turn_completed",
  ]);
  assert.equal(manager.listEvents("maintenance").length, 4);
}
);

test("closes started agent clients and rejects later sends", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(clients),
  });

  const send = manager.sendToAgent("maintenance", "hello");
  await waitFor(() => clients.length === 1, "client before close");
  clients[0]?.session("thread-1").complete("done");
  await send;

  await manager.close();

  assert.equal(clients[0]?.closeCalls.length, 1);
  await assert.rejects(
    manager.sendToAgent("maintenance", "after close"),
    /closed/i,
  );
});

test("creates agents dynamically and persists their definitions", async () => {
  const state: Record<string, unknown> = {};
  const stateStore = {
    async load() {
      return state;
    },
    async save(nextState: Record<string, unknown>) {
      Object.assign(state, nextState);
    },
  };

  const manager = new CodexAgentManager({
    agents: [],
    stateStore,
    clientFactory: fakeFactory(),
  });

  await manager.start();
  const created = await manager.createAgent(agent({ id: "dynamic", name: "Dynamic Agent" }));

  assert.equal(created.id, "dynamic");
  assert.equal(created.status, "idle");
  assert.equal(manager.listAgents().length, 1);

  const resumed = new CodexAgentManager({
    agents: [],
    stateStore,
    clientFactory: fakeFactory(),
  });
  await resumed.start();

  assert.equal(resumed.getAgent("dynamic").name, "Dynamic Agent");
  assert.equal(resumed.getAgent("dynamic").cwd, "/tmp/ops-poc");
});

test("surfaces approval requests and resolves them through the manager", async () => {
  const clients: FakeCodexClient[] = [];
  const contexts: CodexControlClientContext[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: contextualFakeFactory(clients, contexts),
  });

  const send = manager.sendToAgent("maintenance", "run tests");
  await waitFor(() => contexts.length === 1, "client context");
  assert.ok(contexts[0]?.approvalHandler, "expected approval handler");

  const approval = contexts[0].approvalHandler({
    timestamp: "2026-05-20T00:00:00.000Z",
    kind: "command_approval",
    method: "item/commandExecution/requestApproval",
    params: { command: ["npm", "test"], cwd: "/tmp/ops-poc" },
    proposedDecision: "declined",
    proposedResult: { decision: "decline" },
  });

  await waitFor(
    () => manager.listEvents("maintenance").some((event) => event.type === "approval_requested"),
    "approval requested event",
  );
  const requested = manager
    .listEvents("maintenance")
    .find((event) => event.type === "approval_requested");
  assert.equal(requested?.payload.kind, "command_approval");
  assert.deepEqual(requested?.payload.params, {
    command: ["npm", "test"],
    cwd: "/tmp/ops-poc",
  });

  await manager.resolveApproval(String(requested?.payload.approvalId), "approved", "looks safe");
  assert.deepEqual(await approval, {
    decision: "approved",
    reason: "looks safe",
  });
  assert.ok(
    manager
      .listEvents("maintenance")
      .some((event) => event.type === "approval_resolved" && event.payload.decision === "approved"),
  );

  clients[0]?.session("thread-1").complete("tests passed");
  assert.equal((await send).finalText, "tests passed");
});
