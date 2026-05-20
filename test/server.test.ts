import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CodexAgentManager,
  type CodexControlClientContext,
  createCommandCenterServer,
  type CodexControlClientFactory,
} from "../src/index.js";

class ImmediateCodexClient {
  private nextThread = 1;

  async startSession(): Promise<ImmediateCodexSession> {
    return new ImmediateCodexSession(`thread-${this.nextThread++}`);
  }

  async resumeSession(threadId: string): Promise<ImmediateCodexSession> {
    return new ImmediateCodexSession(threadId);
  }

  async close(): Promise<void> {}
}

class ImmediateCodexSession {
  constructor(readonly threadId: string) {}

  async ask(input: string): Promise<{
    finalText: string;
    threadId: string;
    turn: Record<string, unknown>;
  }> {
    return {
      finalText: `received: ${input}`,
      threadId: this.threadId,
      turn: { status: "completed" },
    };
  }
}

class PendingCodexClient {
  async startSession(): Promise<PendingCodexSession> {
    return new PendingCodexSession("thread-1");
  }

  async resumeSession(threadId: string): Promise<PendingCodexSession> {
    return new PendingCodexSession(threadId);
  }

  async close(): Promise<void> {}
}

class PendingCodexSession {
  constructor(readonly threadId: string) {}

  async ask(): Promise<{
    finalText: string;
    threadId: string;
    turn: Record<string, unknown>;
  }> {
    return new Promise(() => {});
  }
}

function immediateFactory(): CodexControlClientFactory {
  return () => new ImmediateCodexClient();
}

function approvalCapturingFactory(
  contexts: CodexControlClientContext[],
): CodexControlClientFactory {
  return (context) => {
    assert.ok(context, "expected client context");
    contexts.push(context);
    return new PendingCodexClient();
  };
}

test("command center API creates agents, lists them, sends messages, and exposes events", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const created = await jsonFetch(`${baseUrl}/api/agents`, {
      method: "POST",
      body: {
        id: "maintenance",
        name: "Maintenance Debugger",
        cwd: "/tmp/ops-poc",
        instructions: "You specialize in maintenance debugging.",
      },
    });
    assert.equal(created.agent.id, "maintenance");

    const listed = await jsonFetch(`${baseUrl}/api/agents`);
    assert.equal(listed.agents.length, 1);
    assert.equal(listed.agents[0].status, "idle");

    const sent = await jsonFetch(`${baseUrl}/api/agents/maintenance/messages`, {
      method: "POST",
      body: { message: "hello agent", options: { network: "allow" } },
    });
    assert.equal(sent.result.finalText, "received: hello agent");

    const events = await jsonFetch(`${baseUrl}/api/events`);
    assert.ok(events.events.some((event: { type: string }) => event.type === "turn_completed"));

    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Jarvis Command Center/);
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center API derives an agent id from name when id is omitted", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const created = await jsonFetch(`http://127.0.0.1:${server.port}/api/agents`, {
      method: "POST",
      body: {
        name: "Slack Debugger",
        cwd: "/tmp/ops-poc",
        instructions: "You specialize in Slack workflows.",
      },
    });

    assert.equal(created.agent.id, "slack-debugger");
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center API updates and deletes agents", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    await jsonFetch(`${baseUrl}/api/agents`, {
      method: "POST",
      body: {
        id: "maintenance",
        name: "Maintenance Debugger",
        cwd: "/tmp/ops-poc",
        instructions: "You specialize in maintenance debugging.",
        metadata: { routingDescription: "Debugs maintenance tickets." },
      },
    });

    const updated = await jsonFetch(`${baseUrl}/api/agents/maintenance`, {
      method: "PATCH",
      body: {
        name: "Postmortem Writer",
        cwd: "/tmp/ops-poc",
        instructions: "You write incident postmortems.",
        metadata: { routingDescription: "Writes postmortems." },
      },
    });
    assert.equal(updated.agent.name, "Postmortem Writer");
    assert.equal(updated.agent.instructions, "You write incident postmortems.");
    assert.equal(updated.agent.metadata.routingDescription, "Writes postmortems.");

    const deleted = await jsonFetch(`${baseUrl}/api/agents/maintenance`, {
      method: "DELETE",
    });
    assert.equal(deleted.agent.id, "maintenance");

    const listed = await jsonFetch(`${baseUrl}/api/agents`);
    assert.equal(listed.agents.length, 0);
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center API resolves pending approvals", async () => {
  const contexts: CodexControlClientContext[] = [];
  const manager = new CodexAgentManager({
    agents: [
      {
        id: "maintenance",
        name: "Maintenance Debugger",
        cwd: "/tmp/ops-poc",
        instructions: "You specialize in maintenance debugging.",
      },
    ],
    clientFactory: approvalCapturingFactory(contexts),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    void manager.sendToAgent("maintenance", "run tests").catch(() => {});
    await waitFor(() => contexts.length === 1, "approval context");
    const approval = contexts[0]?.approvalHandler({
      timestamp: "2026-05-20T00:00:00.000Z",
      kind: "command_approval",
      method: "item/commandExecution/requestApproval",
      params: { command: ["npm", "test"], cwd: "/tmp/ops-poc" },
      proposedDecision: "declined",
      proposedResult: { decision: "decline" },
    });

    await waitFor(
      () => manager.listEvents("maintenance").some((event) => event.type === "approval_requested"),
      "approval requested",
    );
    const event = manager
      .listEvents("maintenance")
      .find((item) => item.type === "approval_requested");

    const resolved = await jsonFetch(
      `http://127.0.0.1:${server.port}/api/approvals/${event?.payload.approvalId}`,
      {
        method: "POST",
        body: { decision: "approved", reason: "confirmed from UI" },
      },
    );

    assert.equal(resolved.approval.payload.decision, "approved");
    assert.deepEqual(await approval, {
      decision: "approved",
      reason: "confirmed from UI",
    });
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center API ingests sensor events and exposes work queues", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const created = await jsonFetch(`${baseUrl}/api/sensor-events`, {
      method: "POST",
      body: {
        source: "jira",
        type: "ticket.created",
        body: "platform-123 needs triage.",
        dedupeKey: "jira:platform-123",
      },
    });
    const duplicate = await jsonFetch(`${baseUrl}/api/sensor-events`, {
      method: "POST",
      body: {
        source: "jira",
        type: "ticket.created",
        body: "duplicate",
        dedupeKey: "jira:platform-123",
      },
    });
    const listed = await jsonFetch(`${baseUrl}/api/sensor-events`);
    const workItems = await jsonFetch(`${baseUrl}/api/work-items`);

    assert.equal(created.event.status, "pending");
    assert.equal(duplicate.event.id, created.event.id);
    assert.equal(listed.events.length, 1);
    assert.deepEqual(workItems.workItems, []);
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center UI exposes chat-style messaging affordances", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const html = await response.text();

    assert.match(html, /chat-stream/);
    assert.match(html, /command-rail/);
    assert.match(html, /side-panel/);
    assert.match(html, /data-panel="create"/);
    assert.match(html, /data-panel="events"/);
    assert.match(html, /data-panel="work"/);
    assert.match(html, /activePanel = "agents"/);
    assert.match(html, /editAgentDirty = false/);
    assert.match(html, /editAgentLoadedId = null/);
    assert.match(html, /event\.currentTarget\.reset/);
    assert.match(html, /await refreshAgents\(\)/);
    assert.match(html, /renderPanel/);
    assert.match(html, /class="message-list"/);
    assert.match(html, /message-bubble\.user/);
    assert.match(html, /message-bubble\.agent/);
    assert.match(html, /pending-message/);
    assert.match(html, /Agent created/);
    assert.match(html, /Message sent/);
    assert.match(html, /deriveAgentId/);
    assert.match(html, /upsertAgent/);
    assert.match(html, /ID \(optional\)/);
    assert.match(html, /<option value="router">Router<\/option>/);
    assert.match(html, /Routing description/);
    assert.match(html, /metadata\.routingDescription = body\.routingDescription/);
    assert.match(html, /defaultRouterInstructions/);
    assert.match(html, /applyCreateRoleDefaults/);
    assert.match(html, /You are the router agent for the multi-agent Codex command center/);
    assert.match(html, /edit-agent-form/);
    assert.match(html, /Developer instructions/);
    assert.match(html, /updateSelectedAgent/);
    assert.match(html, /deleteSelectedAgent/);
    assert.match(html, /method: "PATCH"/);
    assert.match(html, /method: "DELETE"/);
    assert.match(html, /approval-card/);
    assert.match(html, /work-card/);
    assert.match(html, /Approve Tool/);
    assert.match(html, /approved-session/);
    assert.match(html, /canApproveApprovalForSession/);
    assert.match(html, /const scope = decision === "approved-session" \? "session" : "once"/);
    assert.match(html, /summarizeWorkEvents/);
    assert.match(html, /workSummaryToMessage/);
    assert.match(html, /resolveApproval/);
    assert.match(html, /data-approval-action="approved"/);
    assert.match(html, /Event Inbox/);
    assert.match(html, /Work Queue/);
    assert.match(html, /sensor-events/);
    assert.match(html, /work-items/);
    assert.match(html, /hasActiveTurnPending/);
    assert.match(html, /turnStartedAt > turnFinishedAt/);
    assert.match(html, /event\.startedAt >= item\.createdAt/);
    assert.match(html, /selectedAgentId \? events\.filter\(\(item\) => item\.agentId === selectedAgentId\) : \[\]/);
    assert.match(html, /selectedAgentId \? pendingMessages/);
    assert.match(html, /Create or select an agent to begin/);
    assert.match(html, /e\.key === "Enter" && !e\.shiftKey/);
    assert.match(html, /dedupePendingMessages/);
    assert.match(html, /hasCompletion/);
    assert.match(html, /Starting agent session/);
    assert.doesNotMatch(html, /slice\(\)\.reverse\(\)/);
  } finally {
    await server.close();
    await manager.close();
  }
});

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

test("command center inline script parses as JavaScript", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const html = await response.text();
    const start = html.indexOf("<script>") + "<script>".length;
    const end = html.lastIndexOf("</script>");
    assert.ok(start > -1 && end > start);

    const dir = await mkdtemp(join(tmpdir(), "codex-agent-manager-ui-"));
    const scriptPath = join(dir, "inline.js");
    await writeFile(scriptPath, html.slice(start, end), "utf8");

    const result = spawnSync(process.execPath, ["--check", scriptPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await server.close();
    await manager.close();
  }
});

async function jsonFetch(
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<any> {
  const request: RequestInit = {
    method: init.method ?? "GET",
  };
  if (init.body !== undefined) {
    request.headers = { "content-type": "application/json" };
    request.body = JSON.stringify(init.body);
  }
  const response = await fetch(url, request);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
