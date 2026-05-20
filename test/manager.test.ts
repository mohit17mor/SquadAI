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

async function completeRouterRosterUpdate(
  client: FakeCodexClient | undefined,
  nextPromptLabel: string,
): Promise<void> {
  await waitFor(
    () => client?.session("thread-1").pending?.input.includes("Worker roster update") ?? false,
    "router roster update",
  );
  client?.session("thread-1").complete("roster updated");
  await waitFor(
    () => client?.session("thread-1").pending?.input.includes("Sensor event to route") ?? false,
    nextPromptLabel,
  );
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

test("recovers from stale persisted thread ids by starting a fresh Codex thread", async () => {
  const clients: FakeCodexClient[] = [];
  const state = {
    agents: {
      maintenance: {
        threadId: "missing-thread",
        status: "failed" as const,
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

  const send = manager.sendToAgent("maintenance", "continue after restart");
  await waitFor(() => clients.length === 1, "stale thread client");
  const staleSession = clients[0]?.session("missing-thread");
  staleSession?.pending?.reject(
    new Error(JSON.stringify({ code: -32600, message: "no rollout found for thread id missing-thread" })),
  );
  if (staleSession) {
    staleSession.pending = null;
  }

  await waitFor(() => clients.length === 2, "fresh thread client");
  assert.equal(clients[1]?.startCalls.length, 1);
  clients[1]?.session("thread-1").complete("fresh session worked");
  const result = await send;

  assert.equal(result.threadId, "thread-1");
  assert.equal(result.finalText, "fresh session worked");
  assert.equal(manager.getAgent("maintenance").threadId, "thread-1");
  assert.equal(manager.getAgent("maintenance").status, "idle");
  assert.deepEqual(clients[0]?.resumeCalls, ["missing-thread"]);
  assert.equal(clients[0]?.closeCalls.length, 1);
  assert.ok(
    manager
      .listEvents("maintenance")
      .some((event) => event.type === "agent_failed" && event.payload.staleThreadId === "missing-thread"),
  );
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

test("updates agent instructions by clearing the existing Codex session", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(clients),
  });

  const first = manager.sendToAgent("maintenance", "hello");
  await waitFor(() => clients.length === 1, "initial client");
  clients[0]?.session("thread-1").complete("first");
  await first;
  assert.equal(manager.getAgent("maintenance").threadId, "thread-1");

  const updated = await manager.updateAgent("maintenance", {
    instructions: "You now specialize in postmortem drafting.",
  });

  assert.equal(updated.threadId, null);
  assert.equal(clients[0]?.closeCalls.length, 1);
  assert.ok(
    manager
      .listEvents("maintenance")
      .some((event) => event.type === "agent_updated" && event.payload.restartNeeded === true),
  );

  const second = manager.sendToAgent("maintenance", "continue");
  await waitFor(() => clients.length === 2, "fresh client after update");
  assert.deepEqual(clients[1]?.startCalls[0], {
    cwd: "/tmp/ops-poc",
    model: undefined,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    developerInstructions: "You now specialize in postmortem drafting.",
    dynamicTools: undefined,
  });
  clients[1]?.session("thread-1").complete("second");
  assert.equal((await second).finalText, "second");
});

test("updates routing metadata without clearing the worker session", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(clients),
  });

  const first = manager.sendToAgent("maintenance", "hello");
  await waitFor(() => clients.length === 1, "metadata update client");
  clients[0]?.session("thread-1").complete("first");
  await first;

  const updated = await manager.updateAgent("maintenance", {
    metadata: { routingDescription: "Drafts incident postmortems." },
  });

  assert.equal(updated.threadId, "thread-1");
  assert.equal(updated.metadata.routingDescription, "Drafts incident postmortems.");
  assert.equal(clients[0]?.closeCalls.length, 0);
  assert.ok(
    manager
      .listEvents("maintenance")
      .some((event) => event.type === "agent_updated" && event.payload.restartNeeded === false),
  );
});

test("deletes idle agents and persists removal", async () => {
  const clients: FakeCodexClient[] = [];
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
    agents: [agent()],
    stateStore,
    clientFactory: fakeFactory(clients),
  });

  const send = manager.sendToAgent("maintenance", "hello");
  await waitFor(() => clients.length === 1, "delete client");
  clients[0]?.session("thread-1").complete("done");
  await send;

  const deleted = await manager.deleteAgent("maintenance");

  assert.equal(deleted.id, "maintenance");
  assert.equal(clients[0]?.closeCalls.length, 1);
  assert.equal(manager.listAgents().length, 0);
  assert.throws(() => manager.getAgent("maintenance"), /Unknown agent/);
  assert.equal(Object.keys((state.agents as Record<string, unknown>) ?? {}).length, 0);
  assert.ok(
    manager
      .listEvents("maintenance")
      .some((event) => event.type === "agent_deleted"),
  );
});

test("rejects deleting agents with queued or running work", async () => {
  const manager = new CodexAgentManager({
    agents: [
      agent({
        id: "router",
        name: "Router",
        instructions: "Route incoming sensor events.",
        metadata: { role: "router" },
      }),
      agent({
        id: "ops-debugger",
        name: "Ops Debugger",
        instructions: "You classify issue tracker tickets.",
      }),
    ],
    clientFactory: fakeFactory(),
  });

  await manager.ingestSensorEvent({
    source: "issue-tracker",
    type: "ticket.claimed",
    body: "INC-01-1 needs classification.",
  });
  await manager.start();
  const work = await (manager as any).createWorkItemFromDecision(
    manager.getSensorEvent("sensor-1"),
    "router",
    {
      targetAgentId: "ops-debugger",
      prompt: "Classify INC-01-1.",
      reason: "Ops ticket classification.",
    },
  );

  await assert.rejects(
    manager.deleteAgent("ops-debugger"),
    new RegExp(`active work item ${work.id}`),
  );
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

test("ingests sensor events, routes them through a router agent, and dispatches work", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [
      agent({
        id: "router",
        name: "Router",
        instructions: "Route incoming sensor events.",
        metadata: { role: "router" },
      }),
      agent({
        id: "storage",
        name: "storage Debugger",
        instructions: "You specialize in storage incidents.",
      }),
    ],
    clientFactory: fakeFactory(clients),
  });

  const event = await manager.ingestSensorEvent({
    source: "jira",
    type: "ticket.created",
    title: "storage backup stuck",
    body: "platform-123 reports an storage backup stuck in region-a.",
    dedupeKey: "jira:platform-123",
    url: "https://jira.example/browse/platform-123",
  });
  const duplicate = await manager.ingestSensorEvent({
    source: "jira",
    type: "ticket.created",
    body: "same ticket",
    dedupeKey: "jira:platform-123",
  });

  assert.equal(event.status, "pending");
  assert.equal(duplicate.id, event.id);
  assert.equal(manager.listSensorEvents().length, 1);

  const route = manager.processNextSensorEvent("router");
  await waitFor(() => clients.length === 1, "router client");
  await completeRouterRosterUpdate(clients[0], "router event prompt");
  assert.match(clients[0]?.session("thread-1").pending?.input ?? "", /platform-123/);
  assert.match(clients[0]?.session("thread-1").pending?.input ?? "", /storage/);
  clients[0]?.session("thread-1").complete(
    JSON.stringify({
      targetAgentId: "storage",
      prompt: "Investigate platform-123. Customer reports an storage backup stuck in region-a.",
      reason: "storage backup issue.",
    }),
  );

  const work = await route;
  assert.equal(work.status, "queued");
  assert.equal(work.targetAgentId, "storage");
  assert.equal(manager.getSensorEvent(event.id).status, "routed");

  await manager.dispatchQueuedWork();
  await waitFor(() => clients.length === 2, "worker client");
  assert.equal(manager.getWorkItem(work.id).status, "running");
  assert.match(clients[1]?.session("thread-1").pending?.input ?? "", /Investigate platform-123/);

  clients[1]?.session("thread-1").complete("storage investigation complete");
  await waitFor(() => manager.getWorkItem(work.id).status === "done", "work completion");
  assert.equal(manager.getWorkItem(work.id).result, "storage investigation complete");
});

test("sends compact router roster once and omits long worker instructions from event prompts", async () => {
  const clients: FakeCodexClient[] = [];
  const longInstructions = [
    "You are an on-call ticket intake agent.",
    "For this POC, do not investigate, update tickets, run commands, or contact anyone.",
    "Treat tickets as instance-maintenance candidates when DbInstances are unavailable.",
  ].join("\n");
  const manager = new CodexAgentManager({
    agents: [
      agent({
        id: "router",
        name: "Router",
        instructions: "Route incoming sensor events.",
        metadata: { role: "router" },
      }),
      agent({
        id: "ops-debugger",
        name: "Ops Debugger",
        instructions: longInstructions,
        metadata: {
          routingDescription: "Classifies issue tracker tickets for instance-maintenance candidates.",
        },
      }),
    ],
    clientFactory: fakeFactory(clients),
  });

  await manager.ingestSensorEvent({
    source: "issue-tracker",
    type: "ticket.claimed",
    body: "INC-01-1 needs classification.",
  });
  const firstRoute = manager.processNextSensorEvent("router");
  await waitFor(() => clients.length === 1, "router client");

  const rosterPrompt = clients[0]?.session("thread-1").pending?.input ?? "";
  assert.match(rosterPrompt, /Worker roster update/);
  assert.match(rosterPrompt, /Classifies issue tracker tickets for instance-maintenance candidates/);
  assert.doesNotMatch(rosterPrompt, /For this POC, do not investigate/);

  clients[0]?.session("thread-1").complete("roster updated");
  await waitFor(
    () => clients[0]?.session("thread-1").pending?.input.includes("Sensor event to route") ?? false,
    "first route event prompt",
  );
  const firstEventPrompt = clients[0]?.session("thread-1").pending?.input ?? "";
  assert.doesNotMatch(firstEventPrompt, /Available worker agents/);
  assert.doesNotMatch(firstEventPrompt, /For this POC, do not investigate/);
  clients[0]?.session("thread-1").complete(
    JSON.stringify({
      targetAgentId: "ops-debugger",
      prompt: "Classify INC-01-1.",
      reason: "issue tracker classification.",
    }),
  );
  await firstRoute;

  await manager.ingestSensorEvent({
    source: "issue-tracker",
    type: "ticket.claimed",
    body: "INC-01-2 needs classification.",
  });
  const secondRoute = manager.processNextSensorEvent("router");
  await waitFor(
    () => clients[0]?.session("thread-1").pending?.input.includes("INC-01-2") ?? false,
    "second route event prompt",
  );
  const secondEventPrompt = clients[0]?.session("thread-1").pending?.input ?? "";
  assert.doesNotMatch(secondEventPrompt, /Worker roster update/);
  assert.doesNotMatch(secondEventPrompt, /Available worker agents/);
  assert.doesNotMatch(secondEventPrompt, /Classifies issue tracker tickets for instance-maintenance candidates/);
  clients[0]?.session("thread-1").complete(
    JSON.stringify({
      targetAgentId: "ops-debugger",
      prompt: "Classify INC-01-2.",
      reason: "issue tracker classification.",
    }),
  );
  await secondRoute;
});

test("dispatches queued work to a failed agent so it can recover", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [
      agent({
        id: "router",
        name: "Router",
        instructions: "Route incoming sensor events.",
        metadata: { role: "router" },
      }),
      agent({
        id: "ops-debugger",
        name: "Ops Debugger",
        instructions: "You classify issue tracker tickets.",
      }),
    ],
    clientFactory: fakeFactory(clients),
  });

  const failing = manager.sendToAgent("ops-debugger", "fail once");
  await waitFor(() => clients.length === 1, "failed worker client");
  clients[0]?.session("thread-1").pending?.reject(new Error("temporary failure"));
  if (clients[0]) {
    clients[0].session("thread-1").pending = null;
  }
  await assert.rejects(failing, /temporary failure/);
  assert.equal(manager.getAgent("ops-debugger").status, "failed");

  await manager.ingestSensorEvent({
    source: "issue-tracker",
    type: "ticket.claimed",
    body: "INC-01-1 needs classification.",
  });
  const route = manager.processNextSensorEvent("router");
  await waitFor(() => clients.length === 2, "router client");
  await completeRouterRosterUpdate(clients[1], "router event prompt for failed worker");
  clients[1]?.session("thread-1").complete(
    JSON.stringify({
      targetAgentId: "ops-debugger",
      prompt: "Classify INC-01-1.",
      reason: "Ops ticket classification.",
    }),
  );
  const work = await route;

  await manager.dispatchQueuedWork();
  assert.equal(manager.getWorkItem(work.id).status, "running");
  await waitFor(
    () => clients[0]?.session("thread-1").pending?.input === "Classify INC-01-1.",
    "recovery worker prompt",
  );
  clients[0]?.session("thread-1").complete("classification recovered");
  await waitFor(() => manager.getWorkItem(work.id).status === "done", "recovered work");
  assert.equal(manager.getAgent("ops-debugger").status, "idle");
});

test("requeues failed work items so they can be dispatched again", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [
      agent({
        id: "router",
        name: "Router",
        instructions: "Route incoming sensor events.",
        metadata: { role: "router" },
      }),
      agent({
        id: "ops-debugger",
        name: "Ops Debugger",
        instructions: "You classify issue tracker tickets.",
      }),
    ],
    clientFactory: fakeFactory(clients),
  });

  await manager.ingestSensorEvent({
    source: "issue-tracker",
    type: "ticket.claimed",
    body: "INC-01-1 needs classification.",
  });
  const route = manager.processNextSensorEvent("router");
  await waitFor(() => clients.length === 1, "router client for retry test");
  await completeRouterRosterUpdate(clients[0], "router event prompt for retry test");
  clients[0]?.session("thread-1").complete(
    JSON.stringify({
      targetAgentId: "ops-debugger",
      prompt: "Classify INC-01-1.",
      reason: "Ops ticket classification.",
    }),
  );
  const work = await route;

  await manager.dispatchQueuedWork();
  await waitFor(() => clients.length === 2, "worker client for retry test");
  clients[1]?.session("thread-1").pending?.reject(new Error("transient worker failure"));
  if (clients[1]) {
    clients[1].session("thread-1").pending = null;
  }
  await waitFor(() => manager.getWorkItem(work.id).status === "failed", "failed work item");

  const retried = await manager.retryWorkItem(work.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.failureReason, null);

  await manager.dispatchQueuedWork();
  await waitFor(
    () => clients[1]?.session("thread-1").pending?.input === "Classify INC-01-1.",
    "retry worker prompt",
  );
  clients[1]?.session("thread-1").complete("classification succeeded after retry");
  await waitFor(() => manager.getWorkItem(work.id).status === "done", "retried work completion");
  assert.equal(manager.getWorkItem(work.id).result, "classification succeeded after retry");
});
