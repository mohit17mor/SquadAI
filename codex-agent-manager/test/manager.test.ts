import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexAgentManager,
  MemoryAgentStateStore,
  type AgentDefinition,
  type AgentModelCatalog,
  type CodexControlClientContext,
  type CodexControlClientFactory,
} from "../src/index.js";

class FakeCodexClient {
  readonly startCalls: Array<Record<string, unknown>> = [];
  readonly resumeCalls: string[] = [];
  readonly closeCalls: number[] = [];
  modelCatalog: AgentModelCatalog = { models: [] };
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

  async listModels(): Promise<AgentModelCatalog> {
    return this.modelCatalog;
  }

  session(threadId: string): FakeCodexSession {
    const session = this.sessions.get(threadId);
    assert.ok(session, `expected fake session ${threadId}`);
    return session;
  }
}

class FakeCodexSession {
  readonly asks: Array<{ input: string; options: Record<string, unknown> }> = [];
  interruptCalls = 0;
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  pending:
    | {
        input: string;
        resolve: (value: { finalText: string; threadId: string; turn: Record<string, unknown> }) => void;
        reject: (error: Error) => void;
      }
    | null = null;

  constructor(readonly threadId: string) {}

  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  emitItemCompleted(item: Record<string, unknown>): void {
    for (const handler of this.handlers.get("item.completed") ?? []) {
      handler(item);
    }
  }

  emitThreadCompacted(params: Record<string, unknown>): void {
    for (const handler of this.handlers.get("thread.compacted") ?? []) {
      handler(params);
    }
  }

  emitTurnRetrying(params: Record<string, unknown>): void {
    for (const handler of this.handlers.get("turn.retrying") ?? []) {
      handler(params);
    }
  }

  async ask(
    input: string,
    options: Record<string, unknown>,
  ): Promise<{ finalText: string; threadId: string; turn: Record<string, unknown> }> {
    this.asks.push({ input, options });
    return new Promise((resolve, reject) => {
      this.pending = { input, resolve, reject };
    });
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
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

  fail(error: Error): void {
    assert.ok(this.pending, "expected pending ask");
    const pending = this.pending;
    this.pending = null;
    pending.reject(error);
  }
}

function fakeFactory(clients: FakeCodexClient[] = []): CodexControlClientFactory {
  return () => {
    const client = new FakeCodexClient();
    clients.push(client);
    return client;
  };
}

function catalogFactory(
  modelCatalog: AgentModelCatalog,
  clients: FakeCodexClient[] = [],
): CodexControlClientFactory {
  return () => {
    const client = new FakeCodexClient();
    client.modelCatalog = modelCatalog;
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

function mcpApprovalRequest(query: string) {
  return {
    timestamp: "2026-05-20T00:00:00.000Z",
    kind: "mcp_elicitation" as const,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "mcp-issue-tracker",
      mode: "form",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        persist: ["session"],
        tool_title: "search_issues",
        tool_params: { tql: query },
      },
      requestedSchema: { type: "object", properties: {} },
    },
    proposedDecision: "declined" as const,
    proposedResult: { action: "decline", content: null, _meta: null },
  };
}

function mcpApprovalRequestWithoutToolTitle(query: string) {
  return {
    timestamp: "2026-05-20T00:00:00.000Z",
    kind: "mcp_elicitation" as const,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "mcp-issue-tracker",
      mode: "form",
      message: 'Allow the mcp-issue-tracker MCP server to run tool "search_issues"?',
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        persist: ["session"],
        tool_params: { tql: query },
      },
      requestedSchema: { type: "object", properties: {} },
    },
    proposedDecision: "declined" as const,
    proposedResult: { action: "decline", content: null, _meta: null },
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
    reasoningEffort: undefined,
    serviceTier: undefined,
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

test("passes model, reasoning, and speed settings to new Codex sessions", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [
      agent({
        model: "gpt-test",
        reasoningEffort: "high",
        serviceTier: "fast",
      }),
    ],
    clientFactory: fakeFactory(clients),
  });

  const send = manager.sendToAgent("maintenance", "Use the configured runtime.");
  await waitFor(
    () => clients.some((client) => client.startCalls.length === 1),
    "maintenance client",
  );
  const runtimeClient = clients.find((client) => client.startCalls.length === 1);

  assert.equal(manager.getAgent("maintenance").model, "gpt-test");
  assert.equal(manager.getAgent("maintenance").reasoningEffort, "high");
  assert.equal(manager.getAgent("maintenance").serviceTier, "fast");
  assert.deepEqual(runtimeClient?.startCalls[0], {
    cwd: "/tmp/ops-poc",
    model: "gpt-test",
    reasoningEffort: "high",
    serviceTier: "fast",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    developerInstructions: "You specialize in read-only maintenance debugging.",
    dynamicTools: undefined,
  });

  runtimeClient?.session("thread-1").complete("done");
  await send;
});

test("blocks a pinned agent and requests migration approval when its model disappears", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [agent({ model: "gpt-retired" })],
    clientFactory: catalogFactory({
      models: [{
        id: "gpt-current",
        model: "gpt-current",
        displayName: "GPT Current",
        description: "Current default",
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        defaultReasoningEffort: "medium",
        additionalSpeedTiers: [],
        serviceTiers: [],
        isDefault: true,
      }],
    }, clients),
  });

  await assert.rejects(
    manager.sendToAgent("maintenance", "continue the queued work"),
    /blocked.*gpt-retired/i,
  );

  assert.equal(manager.getAgent("maintenance").status, "blocked");
  assert.equal(clients.every((client) => client.startCalls.length === 0), true);
  const approvals = manager.listCompatibilityApprovals();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.issue.kind, "model_unavailable");
  assert.equal(approvals[0]?.issue.suggestedModels[0]?.model, "gpt-current");
});

test("approved model migration unblocks the agent and allows work to resume", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [agent({ model: "gpt-retired" })],
    clientFactory: catalogFactory({
      models: [{
        id: "gpt-current",
        model: "gpt-current",
        displayName: "GPT Current",
        description: "Current default",
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        defaultReasoningEffort: "medium",
        additionalSpeedTiers: [],
        serviceTiers: [],
        isDefault: true,
      }],
    }, clients),
  });

  await assert.rejects(manager.sendToAgent("maintenance", "original prompt"), /blocked/i);
  const approval = manager.listCompatibilityApprovals()[0];
  assert.ok(approval);

  const resolved = await manager.resolveCompatibilityApproval(approval.id, {
    decision: "approved",
    model: "gpt-current",
  });

  assert.equal(resolved.status, "approved");
  assert.equal(manager.getAgent("maintenance").model, "gpt-current");
  assert.equal(manager.getAgent("maintenance").status, "idle");

  const send = manager.sendToAgent("maintenance", "original prompt");
  await waitFor(
    () => clients.some((client) => client.startCalls.length === 1),
    "migrated agent session",
  );
  const runtimeClient = clients.find((client) => client.startCalls.length === 1);
  assert.equal(runtimeClient?.startCalls[0]?.model, "gpt-current");
  runtimeClient?.session("thread-1").complete("resumed");
  assert.equal((await send).finalText, "resumed");
  assert.ok(manager.listEvents("maintenance").some((event) => event.type === "compatibility_migrated"));
});

test("approved migration automatically retries blocked work with its original prompt", async () => {
  const clients: FakeCodexClient[] = [];
  const stateStore = new MemoryAgentStateStore({
    workItems: [{
      id: "work-1",
      eventId: null,
      targetAgentId: "maintenance",
      prompt: "preserve this exact prompt",
      status: "queued",
      routerAgentId: null,
      reason: null,
      result: null,
      failureReason: null,
      metadata: {},
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      retryGeneration: 0,
    }],
  });
  const manager = new CodexAgentManager({
    agents: [agent({ model: "gpt-retired" })],
    stateStore,
    clientFactory: catalogFactory({
      models: [{
        id: "gpt-current",
        model: "gpt-current",
        displayName: "GPT Current",
        description: "Current default",
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        defaultReasoningEffort: "medium",
        additionalSpeedTiers: [],
        serviceTiers: [],
        isDefault: true,
      }],
    }, clients),
  });

  await manager.dispatchQueuedWork();
  await waitFor(() => manager.getWorkItem("work-1").status === "blocked", "blocked work item");
  const approval = manager.listCompatibilityApprovals()[0];
  assert.ok(approval);

  await manager.resolveCompatibilityApproval(approval.id, {
    decision: "approved",
    model: "gpt-current",
  });
  await waitFor(
    () => clients.some((client) => client.startCalls.length === 1),
    "automatically retried work session",
  );
  const runtimeClient = clients.find((client) => client.startCalls.length === 1);
  assert.equal(runtimeClient?.session("thread-1").pending?.input, "preserve this exact prompt");
  runtimeClient?.session("thread-1").complete("retried result");
  await waitFor(() => manager.getWorkItem("work-1").status === "done", "retried work completion");

  const workItem = manager.getWorkItem("work-1");
  assert.equal(workItem.result, "retried result");
  assert.equal(workItem.retryGeneration, 1);
});

test("reactively diagnoses a model removed after preflight instead of marking an ordinary failure", async () => {
  const clients: FakeCodexClient[] = [];
  let liveCatalog: AgentModelCatalog = {
    models: [{
      id: "gpt-current",
      model: "gpt-current",
      displayName: "GPT Current",
      description: "Initially available",
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
      defaultReasoningEffort: "medium",
      additionalSpeedTiers: [],
      serviceTiers: [],
      isDefault: true,
    }],
  };
  const manager = new CodexAgentManager({
    agents: [agent({ model: "gpt-current" })],
    clientFactory: () => {
      const client = new FakeCodexClient();
      client.modelCatalog = liveCatalog;
      clients.push(client);
      return client;
    },
  });

  const send = manager.sendToAgent("maintenance", "work started before catalog changed");
  await waitFor(
    () => clients.some((client) => client.startCalls.length === 1),
    "runtime session before model removal",
  );
  const runtimeClient = clients.find((client) => client.startCalls.length === 1);
  liveCatalog = {
    models: [{
      id: "gpt-replacement",
      model: "gpt-replacement",
      displayName: "GPT Replacement",
      description: "New default",
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
      defaultReasoningEffort: "medium",
      additionalSpeedTiers: [],
      serviceTiers: [],
      isDefault: true,
    }],
  };
  runtimeClient?.session("thread-1").fail(new Error("Model gpt-current is not available"));

  await assert.rejects(send, /blocked.*gpt-current/i);
  assert.equal(manager.getAgent("maintenance").status, "blocked");
  assert.equal(manager.listCompatibilityApprovals()[0]?.issue.suggestedModels[0]?.model, "gpt-replacement");
  assert.equal(manager.listEvents("maintenance").some((event) => event.type === "turn_failed"), false);
});

test("restores pending compatibility approvals and resolves them after manager restart", async () => {
  const stateStore = new MemoryAgentStateStore();
  const modelCatalog: AgentModelCatalog = {
    models: [{
      id: "gpt-current",
      model: "gpt-current",
      displayName: "GPT Current",
      description: "Current default",
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
      defaultReasoningEffort: "medium",
      additionalSpeedTiers: [],
      serviceTiers: [],
      isDefault: true,
    }],
  };
  const first = new CodexAgentManager({
    agents: [agent({ model: "gpt-retired" })],
    stateStore,
    clientFactory: catalogFactory(modelCatalog),
  });
  await assert.rejects(first.sendToAgent("maintenance", "detect removal"), /blocked/i);
  const approvalId = first.listCompatibilityApprovals()[0]?.id;
  assert.ok(approvalId);
  await first.close();

  const second = new CodexAgentManager({
    agents: [],
    stateStore,
    clientFactory: catalogFactory(modelCatalog),
  });
  await second.start();
  assert.equal(second.getAgent("maintenance").status, "blocked");
  assert.equal(second.listCompatibilityApprovals()[0]?.id, approvalId);

  const resolved = await second.resolveCompatibilityApproval(approvalId, {
    decision: "approved",
    model: "gpt-current",
  });
  assert.equal(resolved.status, "approved");
  assert.equal(second.getAgent("maintenance").model, "gpt-current");
});

test("lists model options through a short-lived codex-control client", async () => {
  const clients: FakeCodexClient[] = [];
  const modelCatalog: AgentModelCatalog = {
    models: [
      {
        id: "gpt-test",
        model: "gpt-test",
        displayName: "GPT Test",
        description: "Test model",
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Thorough" }],
        defaultReasoningEffort: "high",
        serviceTiers: [{ id: "fast", name: "Fast", description: "Lower latency" }],
        isDefault: true,
      },
    ],
  };
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: () => {
      const client = new FakeCodexClient();
      client.modelCatalog = modelCatalog;
      clients.push(client);
      return client;
    },
  });

  const catalog = await manager.listModelOptions();

  assert.equal(catalog.models[0]?.model, "gpt-test");
  assert.equal(catalog.models[0]?.supportedReasoningEfforts[0]?.reasoningEffort, "high");
  assert.equal(catalog.models[0]?.serviceTiers[0]?.id, "fast");
  assert.equal(clients[0]?.closeCalls.length, 1);
});

test("uses a long default timeout for agent turns unless caller overrides it", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(clients),
  });

  const send = manager.sendToAgent("maintenance", "long investigation");
  await waitFor(() => clients.length === 1, "default timeout client");

  assert.equal(clients[0]?.session("thread-1").asks[0]?.options.timeoutMs, 1_800_000);

  clients[0]?.session("thread-1").complete("done");
  await send;
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

test("interrupts a running agent turn through the active session", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(clients),
  });

  const turn = manager.sendToAgent("maintenance", "risky work");
  await waitFor(() => clients.length === 1, "maintenance client");

  const event = await manager.interruptAgentTurn("maintenance");
  assert.equal(event.type, "turn_interrupt_requested");
  assert.equal(clients[0]?.session("thread-1").interruptCalls, 1);

  clients[0]?.session("thread-1").complete("interrupted");
  await turn;
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

test("rejects invalid agent definitions and invalid manager operations", async () => {
  assert.throws(
    () => new CodexAgentManager({ agents: [agent(), agent()], clientFactory: fakeFactory() }),
    /Duplicate agent id/,
  );
  assert.throws(
    () => new CodexAgentManager({ agents: [agent({ id: "bad id" })], clientFactory: fakeFactory() }),
    /Invalid agent id/,
  );
  assert.throws(
    () => new CodexAgentManager({ agents: [agent({ name: " " })], clientFactory: fakeFactory() }),
    /must have a name/,
  );
  assert.throws(
    () => new CodexAgentManager({ agents: [agent({ cwd: " " })], clientFactory: fakeFactory() }),
    /must have a cwd/,
  );
  assert.throws(
    () => new CodexAgentManager({ agents: [agent({ instructions: " " })], clientFactory: fakeFactory() }),
    /must have instructions/,
  );

  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(),
  });

  await assert.rejects(manager.sendToAgent("maintenance", " "), /empty message/);
  assert.throws(() => manager.getAgent("missing"), /Unknown agent/);
  assert.throws(() => manager.getSensorEvent("missing"), /Unknown sensor event/);
  assert.throws(() => manager.getWorkItem("missing"), /Unknown work item/);
  await assert.rejects(manager.retryWorkItem("missing"), /Unknown work item/);
  await assert.rejects(manager.interruptAgentTurn("maintenance"), /does not have a running turn/);

  await manager.close();
  await manager.close();
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
    reasoningEffort: undefined,
    serviceTier: undefined,
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
  const notification = manager.listNotifications().find((item) => item.kind === "approval_required");
  assert.equal(notification?.agentId, "maintenance");
  assert.equal(notification?.sourceEventId, requested?.id);
  assert.equal(notification?.status, "pending");
  assert.match(notification?.summary ?? "", /Maintenance Debugger needs approval/);
  assert.match(notification?.summary ?? "", /npm test/);

  await manager.resolveApproval(String(requested?.payload.approvalId), "approved", "looks safe");
  assert.deepEqual(await approval, {
    decision: "approved",
    reason: "looks safe",
  });
  assert.equal(manager.listNotifications().find((item) => item.id === notification?.id)?.status, "resolved");
  assert.ok(
    manager
      .listEvents("maintenance")
      .some((event) => event.type === "approval_resolved" && event.payload.decision === "approved"),
  );

  clients[0]?.session("thread-1").complete("tests passed");
  assert.equal((await send).finalText, "tests passed");
});

test("queues and dismisses failure notifications for human attention", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(clients),
  });

  const send = manager.sendToAgent("maintenance", "fail this turn");
  await waitFor(() => clients.length === 1, "failure notification client");
  clients[0]?.session("thread-1").pending?.reject(new Error("tool crashed"));
  if (clients[0]) {
    clients[0].session("thread-1").pending = null;
  }
  await assert.rejects(send, /tool crashed/);

  const notification = manager.listNotifications().find((item) => item.kind === "turn_failed");
  assert.equal(notification?.agentId, "maintenance");
  assert.equal(notification?.agentName, "Maintenance Debugger");
  assert.equal(notification?.status, "pending");
  assert.match(notification?.summary ?? "", /tool crashed/);

  const dismissed = await manager.dismissNotification(String(notification?.id));
  assert.equal(dismissed.status, "resolved");
  assert.equal(manager.listNotifications().find((item) => item.id === notification?.id)?.status, "resolved");
});

test("automation delivers pending notifications to an idle Jarvis agent", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [
      agent({
        id: "jarvis",
        name: "Jarvis",
        instructions: "Tell the human what needs attention.",
        metadata: { role: "jarvis" },
      }),
      agent({
        id: "maintenance",
        name: "Maintenance Debugger",
        instructions: "You specialize in read-only maintenance debugging.",
      }),
    ],
    clientFactory: fakeFactory(clients),
  });

  const failedTurn = manager.sendToAgent("maintenance", "fail while investigating");
  await waitFor(() => clients.length === 1, "worker client");
  clients[0]?.session("thread-1").pending?.reject(new Error("tool crashed"));
  if (clients[0]) {
    clients[0].session("thread-1").pending = null;
  }
  await assert.rejects(failedTurn, /tool crashed/);

  const notification = manager.listNotifications().find((item) => item.kind === "turn_failed");
  assert.equal(notification?.jarvisDeliveredAt, null);

  const automation = manager.runAutomationCycle();
  await waitFor(() => clients.length === 2, "jarvis client");
  const jarvisPrompt = clients[1]?.session("thread-1").pending?.input ?? "";
  assert.match(jarvisPrompt, /^Notify user:/);
  assert.match(jarvisPrompt, /notif-/);
  assert.match(jarvisPrompt, /Maintenance Debugger/);
  assert.match(jarvisPrompt, /tool crashed/);
  assert.doesNotMatch(jarvisPrompt, /Command center notifications need the human's attention/);
  assert.doesNotMatch(jarvisPrompt, /The user can click each notification/);

  const jarvisStarted = manager
    .listEvents("jarvis")
    .find((event) => event.type === "turn_started" && event.payload.input === jarvisPrompt);
  assert.equal(jarvisStarted?.payload.internal, true);
  assert.equal(jarvisStarted?.payload.reason, "jarvis_notification_delivery");

  assert.equal(
    manager.listNotifications().find((item) => item.id === notification?.id)?.jarvisDeliveredAt,
    null,
  );

  clients[1]?.session("thread-1").complete("I told the human.");
  const result = await automation;
  assert.deepEqual(result.jarvisNotificationDelivery?.notificationIds, [notification?.id]);
  assert.equal(result.jarvisNotificationDelivery?.jarvisAgentId, "jarvis");
  assert.equal(
    manager.listNotifications().find((item) => item.id === notification?.id)?.jarvisDeliveryThreadId,
    "thread-1",
  );
  assert.ok(manager.listNotifications().find((item) => item.id === notification?.id)?.jarvisDeliveredAt);
});

test("automation leaves notifications queued while Jarvis is busy", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [
      agent({
        id: "jarvis",
        name: "Jarvis",
        instructions: "Tell the human what needs attention.",
        metadata: { role: "jarvis" },
      }),
      agent(),
    ],
    clientFactory: fakeFactory(clients),
  });

  const jarvisTurn = manager.sendToAgent("jarvis", "hello jarvis");
  await waitFor(() => clients.length === 1, "busy jarvis client");

  const failedTurn = manager.sendToAgent("maintenance", "fail while jarvis is busy");
  await waitFor(() => clients.length === 2, "worker client while jarvis busy");
  clients[1]?.session("thread-1").pending?.reject(new Error("still needs attention"));
  if (clients[1]) {
    clients[1].session("thread-1").pending = null;
  }
  await assert.rejects(failedTurn, /still needs attention/);

  const result = await manager.runAutomationCycle();
  assert.equal(result.jarvisNotificationDelivery, null);
  const notification = manager.listNotifications().find((item) => item.kind === "turn_failed");
  assert.equal(notification?.jarvisDeliveredAt, null);

  clients[0]?.session("thread-1").complete("ready");
  assert.equal((await jarvisTurn).finalText, "ready");
});

test("continues approval ids from persisted approval events", async () => {
  const clients: FakeCodexClient[] = [];
  const contexts: CodexControlClientContext[] = [];
  const stateStore = new MemoryAgentStateStore({
    events: [
      {
        id: 1,
        agentId: "maintenance",
        type: "approval_resolved",
        message: "Approval approved.",
        payload: { approvalId: "approval-4", decision: "approved" },
        createdAt: "2026-05-20T00:00:00.000Z",
      },
    ],
  });
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: contextualFakeFactory(clients, contexts),
    stateStore,
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
    .filter((event) => event.type === "approval_requested")
    .at(-1);
  assert.equal(requested?.payload.approvalId, "approval-5");

  await manager.resolveApproval(String(requested?.payload.approvalId), "approved");
  assert.deepEqual(await approval, { decision: "approved" });
  clients[0]?.session("thread-1").complete("tests passed");
  assert.equal((await send).finalText, "tests passed");
});

test("can approve repeated MCP tool calls for the current agent session", async () => {
  const clients: FakeCodexClient[] = [];
  const contexts: CodexControlClientContext[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: contextualFakeFactory(clients, contexts),
  });

  const send = manager.sendToAgent("maintenance", "search tickets");
  await waitFor(() => contexts.length === 1, "mcp approval context");
  const context = contexts[0];
  assert.ok(context);
  const firstApproval = context.approvalHandler(mcpApprovalRequest("one"));

  await waitFor(
    () => manager.listEvents("maintenance").some((event) => event.type === "approval_requested"),
    "first mcp approval requested",
  );
  const requested = manager
    .listEvents("maintenance")
    .find((event) => event.type === "approval_requested");

  await manager.resolveApproval(
    String(requested?.payload.approvalId),
    "approved",
    "safe read-only lookup",
    "session",
  );
  assert.deepEqual(await firstApproval, {
    decision: "approved",
    reason: "safe read-only lookup",
  });

  const secondApproval = await context.approvalHandler(mcpApprovalRequest("two"));
  assert.deepEqual(secondApproval, {
    decision: "approved",
    reason: "Approved by session rule for mcp-issue-tracker/search_issues.",
  });
  assert.equal(
    manager.listEvents("maintenance").filter((event) => event.type === "approval_requested").length,
    1,
  );
  assert.ok(
    manager
      .listEvents("maintenance")
      .some((event) => event.type === "approval_auto_approved"),
  );

  clients[0]?.session("thread-1").complete("done");
  assert.equal((await send).finalText, "done");
});

test("can approve repeated MCP tool calls when tool name is only in the elicitation message", async () => {
  const clients: FakeCodexClient[] = [];
  const contexts: CodexControlClientContext[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: contextualFakeFactory(clients, contexts),
  });

  const send = manager.sendToAgent("maintenance", "search tickets");
  await waitFor(() => contexts.length === 1, "mcp approval context");
  const context = contexts[0];
  assert.ok(context);
  const firstApproval = context.approvalHandler(mcpApprovalRequestWithoutToolTitle("one"));

  await waitFor(
    () => manager.listEvents("maintenance").some((event) => event.type === "approval_requested"),
    "first mcp approval requested",
  );
  const requested = manager
    .listEvents("maintenance")
    .find((event) => event.type === "approval_requested");

  await manager.resolveApproval(
    String(requested?.payload.approvalId),
    "approved",
    "safe read-only lookup",
    "session",
  );
  assert.deepEqual(await firstApproval, {
    decision: "approved",
    reason: "safe read-only lookup",
  });

  const secondApproval = await context.approvalHandler(mcpApprovalRequestWithoutToolTitle("two"));
  assert.deepEqual(secondApproval, {
    decision: "approved",
    reason: "Approved by session rule for mcp-issue-tracker/search_issues.",
  });
  assert.equal(
    manager.listEvents("maintenance").filter((event) => event.type === "approval_requested").length,
    1,
  );

  clients[0]?.session("thread-1").complete("done");
  assert.equal((await send).finalText, "done");
});

test("records Codex item and compaction events emitted by the session", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(clients),
  });

  const send = manager.sendToAgent("maintenance", "inspect ticket");
  await waitFor(() => clients.length === 1, "codex activity client");
  const session = clients[0]?.session("thread-1");
  assert.ok(session);

  session.emitItemCompleted({
    type: "mcpToolCall",
    serverName: "mcp-issue-tracker",
    toolName: "get_issue",
    arguments: { ticket_id: "INC-01-1" },
  });
  session.emitThreadCompacted({ threadId: "thread-1", reason: "history limit" });

  await waitFor(
    () => manager.listEvents("maintenance").some((event) => event.type === "codex_item_completed"),
    "codex item event",
  );
  const itemEvent = manager
    .listEvents("maintenance")
    .find((event) => event.type === "codex_item_completed");
  assert.equal(itemEvent?.payload.itemType, "mcpToolCall");
  assert.equal(itemEvent?.payload.title, "mcp-issue-tracker/get_issue");

  assert.ok(
    manager
      .listEvents("maintenance")
      .some((event) => event.type === "codex_thread_compacted"),
  );

  session.emitTurnRetrying({
    error: { message: "Reconnecting... 2/5" },
    willRetry: true,
  });
  await waitFor(
    () => manager.listEvents("maintenance").some((event) => event.type === "codex_turn_retrying"),
    "codex retrying event",
  );

  session.complete("done");
  assert.equal((await send).finalText, "done");
});

test("records command execution details in Codex activity summaries", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(clients),
  });

  const send = manager.sendToAgent("maintenance", "run tests");
  await waitFor(() => clients.length === 1, "command activity client");
  const session = clients[0]?.session("thread-1");
  assert.ok(session);

  session.emitItemCompleted({
    type: "commandExecution",
    command: ["npm", "test"],
    cwd: "/tmp/ops-poc",
    status: "completed",
    exitCode: 0,
    durationMs: 1234,
  });

  await waitFor(
    () => manager.listEvents("maintenance").some((event) => event.type === "codex_item_completed"),
    "command item event",
  );
  const itemEvent = manager
    .listEvents("maintenance")
    .find((event) => event.type === "codex_item_completed");
  assert.equal(itemEvent?.payload.itemType, "commandExecution");
  assert.equal(itemEvent?.payload.command, "npm test");
  assert.match(String(itemEvent?.payload.summary), /completed - npm test/);
  assert.match(String(itemEvent?.payload.summary), /cwd: \/tmp\/ops-poc/);
  assert.equal(itemEvent?.payload.exitCode, 0);

  session.complete("done");
  assert.equal((await send).finalText, "done");
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
  assert.equal(clients[1]?.session("thread-1").asks[0]?.options.timeoutMs, 1_800_000);

  clients[1]?.session("thread-1").complete("storage investigation complete");
  await waitFor(() => manager.getWorkItem(work.id).status === "done", "work completion");
  assert.equal(manager.getWorkItem(work.id).result, "storage investigation complete");
});

test("dispatches only one queued work item per target agent at a time", async () => {
  const clients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [
      agent({
        id: "worker",
        name: "Worker",
        instructions: "Handle routed work.",
      }),
    ],
    clientFactory: fakeFactory(clients),
  });

  await manager.ingestSensorEvent({
    source: "issue-tracker",
    type: "ticket.created",
    body: "INC-01-1",
  });
  await manager.ingestSensorEvent({
    source: "issue-tracker",
    type: "ticket.created",
    body: "INC-01-2",
  });
  const first = await (manager as any).createWorkItemFromDecision(
    manager.getSensorEvent("sensor-1"),
    "router",
    {
      targetAgentId: "worker",
      prompt: "Investigate INC-01-1.",
    },
  );
  const second = await (manager as any).createWorkItemFromDecision(
    manager.getSensorEvent("sensor-2"),
    "router",
    {
      targetAgentId: "worker",
      prompt: "Investigate INC-01-2.",
    },
  );

  const started = await manager.dispatchQueuedWork();
  assert.deepEqual(started.map((item) => item.id), [first.id]);
  assert.equal(manager.getWorkItem(first.id).status, "running");
  assert.equal(manager.getWorkItem(second.id).status, "queued");
  await waitFor(() => clients.length === 1, "first worker client");
  assert.equal(clients[0]?.session("thread-1").pending?.input, "Investigate INC-01-1.");

  clients[0]?.session("thread-1").complete("first done");
  await waitFor(() => manager.getWorkItem(first.id).status === "done", "first work done");

  const laterStarted = await manager.dispatchQueuedWork();
  assert.deepEqual(laterStarted.map((item) => item.id), [second.id]);
  assert.equal(manager.getWorkItem(second.id).status, "running");
  await waitFor(
    () => clients[0]?.session("thread-1").pending?.input === "Investigate INC-01-2.",
    "second worker prompt",
  );
  clients[0]?.session("thread-1").complete("second done");
  await waitFor(() => manager.getWorkItem(second.id).status === "done", "second work done");
});

test("returns immutable sensor and work item snapshots", async () => {
  const manager = new CodexAgentManager({
    agents: [
      agent({
        id: "router",
        name: "Router",
        instructions: "Route incoming sensor events.",
        metadata: { role: "router" },
      }),
      agent({
        id: "worker",
        name: "Worker",
        instructions: "Handle routed work.",
      }),
    ],
    clientFactory: fakeFactory(),
  });

  await manager.ingestSensorEvent({
    source: "issue-tracker",
    type: "ticket.claimed",
    body: "INC-01-1",
    metadata: { nested: { value: 1 } },
  });
  const work = await (manager as any).createWorkItemFromDecision(
    manager.getSensorEvent("sensor-1"),
    "router",
    {
      targetAgentId: "worker",
      prompt: "Classify INC-01-1.",
      metadata: { nested: { value: 2 } },
    },
  );

  const sensorSnapshot = manager.listSensorEvents()[0]!;
  assert.ok(sensorSnapshot.metadata);
  sensorSnapshot.metadata.changed = true;
  const workSnapshot = manager.getWorkItem(work.id);
  workSnapshot.metadata.changed = true;

  assert.equal(manager.getSensorEvent("sensor-1").metadata?.changed, undefined);
  assert.equal(manager.getWorkItem(work.id).metadata.changed, undefined);
});

test("rejects invalid sensor event and routing inputs", async () => {
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
        id: "other-router",
        name: "Other Router",
        instructions: "Also route incoming sensor events.",
        metadata: { role: "router" },
      }),
      agent({
        id: "worker",
        name: "Worker",
        instructions: "Handle routed work.",
      }),
    ],
    clientFactory: fakeFactory(clients),
  });

  await assert.rejects(
    manager.ingestSensorEvent({ source: " ", type: "ticket.claimed", body: "body" }),
    /Field source/,
  );
  await assert.rejects(manager.processNextSensorEvent("router"), /No pending sensor events/);

  await manager.ingestSensorEvent({
    source: "issue-tracker",
    type: "ticket.claimed",
    body: "INC-01-1",
  });
  await assert.rejects(manager.processNextSensorEvent(), /Expected exactly one router agent, found 2/);

  const route = manager.processNextSensorEvent("router");
  await waitFor(() => clients.length === 1, "router client for invalid routing");
  await completeRouterRosterUpdate(clients[0], "router prompt for invalid routing");
  clients[0]?.session("thread-1").complete("not json");

  await assert.rejects(route, /Router response must be a JSON object/);
  assert.equal(manager.getSensorEvent("sensor-1").status, "failed");
});

test("rejects unsafe or malformed routing decisions", async () => {
  const cases: Array<{ name: string; response: Record<string, unknown>; error: RegExp }> = [
    {
      name: "self assignment",
      response: { targetAgentId: "router", prompt: "Do the work." },
      error: /cannot assign work to itself/,
    },
    {
      name: "unknown worker",
      response: { targetAgentId: "missing", prompt: "Do the work." },
      error: /Unknown agent/,
    },
    {
      name: "empty prompt",
      response: { targetAgentId: "worker", prompt: " " },
      error: /Field prompt/,
    },
    {
      name: "metadata not object",
      response: { targetAgentId: "worker", prompt: "Do the work.", metadata: "bad" },
      error: /Expected metadata to be an object/,
    },
  ];

  for (const item of cases) {
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
          id: "worker",
          name: "Worker",
          instructions: "Handle routed work.",
        }),
      ],
      clientFactory: fakeFactory(clients),
    });

    await manager.ingestSensorEvent({
      source: "issue-tracker",
      type: "ticket.claimed",
      body: `${item.name}: INC-01-1`,
    });

    const route = manager.processNextSensorEvent("router");
    await waitFor(() => clients.length === 1, `${item.name} router client`);
    await completeRouterRosterUpdate(clients[0], `${item.name} router prompt`);
    clients[0]?.session("thread-1").complete(JSON.stringify(item.response));

    await assert.rejects(route, item.error);
    assert.equal(manager.getSensorEvent("sensor-1").status, "failed");
  }
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
      agent({
        id: "jarvis",
        name: "Jarvis",
        instructions: "Tell the human what needs attention.",
        metadata: { role: "jarvis" },
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
  assert.doesNotMatch(rosterPrompt, /Jarvis/);
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

test("does not resend router roster after manager restart when router thread is resumed", async () => {
  const stateStore = new MemoryAgentStateStore();
  const firstClients: FakeCodexClient[] = [];
  const manager = new CodexAgentManager({
    agents: [
      agent({
        id: "router",
        name: "Router",
        instructions: "Route incoming sensor events.",
        metadata: { role: "router" },
      }),
      agent({
        id: "ops-helper",
        name: "Ops Helper",
        instructions: "Debug ops tickets.",
        metadata: {
          routingDescription: "Helps in debugging ops tickets/issues.",
        },
      }),
    ],
    stateStore,
    clientFactory: fakeFactory(firstClients),
  });

  await manager.ingestSensorEvent({
    source: "issue-tracker",
    type: "ticket.claimed",
    body: "INC-01-1 needs routing.",
  });
  const firstRoute = manager.processNextSensorEvent("router");
  await waitFor(() => firstClients.length === 1, "initial router client");
  await completeRouterRosterUpdate(firstClients[0], "initial router event prompt");
  firstClients[0]?.session("thread-1").complete(
    JSON.stringify({
      targetAgentId: "ops-helper",
      prompt: "Handle INC-01-1.",
      reason: "Ops ticket.",
    }),
  );
  await firstRoute;
  await manager.close();

  const resumedClients: FakeCodexClient[] = [];
  const resumed = new CodexAgentManager({
    agents: [],
    stateStore,
    clientFactory: fakeFactory(resumedClients),
  });
  await resumed.start();
  await resumed.ingestSensorEvent({
    source: "issue-tracker",
    type: "ticket.claimed",
    body: "INC-01-2 needs routing.",
  });

  const secondRoute = resumed.processNextSensorEvent("router");
  await waitFor(() => resumedClients.length === 1, "resumed router client");
  assert.deepEqual(resumedClients[0]?.resumeCalls, ["thread-1"]);
  await waitFor(
    () => resumedClients[0]?.session("thread-1").pending?.input.includes("INC-01-2") ?? false,
    "resumed router event prompt",
  );
  const resumedPrompt = resumedClients[0]?.session("thread-1").pending?.input ?? "";
  assert.doesNotMatch(resumedPrompt, /Worker roster update/);
  assert.match(resumedPrompt, /Use the compact worker roster already provided/);
  resumedClients[0]?.session("thread-1").complete(
    JSON.stringify({
      targetAgentId: "ops-helper",
      prompt: "Handle INC-01-2.",
      reason: "Ops ticket.",
    }),
  );
  await secondRoute;
  await resumed.close();
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

test("recovers running work items as failed after manager restart", async () => {
  const stateStore = new MemoryAgentStateStore({
    workItems: [
      {
        id: "work-9",
        eventId: "sensor-9",
        targetAgentId: "maintenance",
        prompt: "Investigate ticket.",
        status: "running",
        routerAgentId: "router",
        reason: "matched worker",
        result: null,
        failureReason: null,
        metadata: {},
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:01:00.000Z",
        startedAt: "2026-05-20T00:01:00.000Z",
        completedAt: null,
      },
    ],
  });
  const manager = new CodexAgentManager({
    agents: [agent()],
    clientFactory: fakeFactory(),
    stateStore,
    clock: () => new Date("2026-05-20T00:02:00.000Z"),
  });

  await manager.start();

  const recovered = manager.getWorkItem("work-9");
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.failureReason, "Manager restarted while work item was running.");
  assert.equal(recovered.completedAt, "2026-05-20T00:02:00.000Z");
  assert.ok(
    manager
      .listEvents("maintenance")
      .some((event) => event.type === "work_item_failed" && event.payload.recovered === true),
  );
});
