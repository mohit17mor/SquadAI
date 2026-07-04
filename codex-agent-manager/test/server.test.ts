import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CodexAgentManager,
  type AgentModelCatalog,
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

  async listModels(): Promise<AgentModelCatalog> {
    return {
      models: [
        {
          id: "gpt-test",
          model: "gpt-test",
          displayName: "GPT Test",
          description: "Test model",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "high", description: "Thorough" },
          ],
          defaultReasoningEffort: "low",
          serviceTiers: [{ id: "fast", name: "Fast", description: "Lower latency" }],
          isDefault: true,
        },
      ],
    };
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
  interruptCalls = 0;

  constructor(readonly threadId: string) {}

  async ask(): Promise<{
    finalText: string;
    threadId: string;
    turn: Record<string, unknown>;
  }> {
    return new Promise(() => {});
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
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
        model: "gpt-test",
        reasoningEffort: "high",
        serviceTier: "fast",
        permissionMode: "auto-review",
        metadata: { routingDescription: "Debugs maintenance tickets." },
      },
    });
    assert.equal(created.agent.id, "maintenance");
    assert.equal(created.agent.model, "gpt-test");
    assert.equal(created.agent.reasoningEffort, "high");
    assert.equal(created.agent.serviceTier, "fast");
    assert.equal(created.agent.approvalPolicy, "on-request");
    assert.equal(created.agent.approvalsReviewer, "auto_review");
    assert.equal(created.agent.sandbox, "workspace-write");
    assert.equal(created.agent.metadata.routingDescription, "Debugs maintenance tickets.");

    const modelOptions = await jsonFetch(`${baseUrl}/api/model-options`);
    assert.equal(modelOptions.models.length, 1);
    assert.equal(modelOptions.models[0].model, "gpt-test");
    assert.equal(modelOptions.models[0].supportedReasoningEfforts[1].reasoningEffort, "high");
    assert.equal(modelOptions.models[0].serviceTiers[0].id, "fast");

    const listed = await jsonFetch(`${baseUrl}/api/agents`);
    assert.equal(listed.agents.length, 1);
    assert.equal(listed.agents[0].status, "idle");
    const workspace = await jsonFetch(`${baseUrl}/api/agents/maintenance/workspace`);
    assert.equal(workspace.agentId, "maintenance");
    assert.equal(workspace.workspace, null);

    const sent = await jsonFetch(`${baseUrl}/api/agents/maintenance/messages`, {
      method: "POST",
      body: {
        message: "hello agent",
        options: {
          timeoutMs: 1234,
          externalWrites: "deny",
          shellCommands: "allow",
          fileWrites: "deny",
          network: "allow",
        },
      },
    });
    assert.equal(sent.result.finalText, "received: hello agent");

    const events = await jsonFetch(`${baseUrl}/api/events`);
    assert.ok(events.events.some((event: { type: string }) => event.type === "turn_completed"));

    const latestEventPage = await jsonFetch(`${baseUrl}/api/events?agentId=maintenance&limit=1`);
    assert.equal(latestEventPage.events.length, 1);
    assert.equal(latestEventPage.hasMore, true);
    assert.equal(latestEventPage.nextBeforeId, latestEventPage.events[0].id);
    const olderEventPage = await jsonFetch(
      `${baseUrl}/api/events?agentId=maintenance&limit=1&beforeId=${latestEventPage.nextBeforeId}`,
    );
    assert.equal(olderEventPage.events.length, 1);
    assert.ok(olderEventPage.events[0].id < latestEventPage.events[0].id);

    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Jarvis Command Center/);
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center API returns useful errors for invalid requests", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;

    await expectJsonStatus(`${baseUrl}/missing`, {}, 404, /Not found/);
    await expectJsonStatus(
      `${baseUrl}/api/agents`,
      { method: "POST", body: [] },
      400,
      /Expected a JSON object/,
    );
    await expectJsonStatus(
      `${baseUrl}/api/agents`,
      {
        method: "POST",
        body: {
          name: "!!!",
          cwd: "/tmp",
          instructions: "help",
        },
      },
      400,
      /Agent name must contain/,
    );
    await expectJsonStatus(
      `${baseUrl}/api/agents`,
      {
        method: "POST",
        body: {
          id: "bad",
          name: "Bad",
          cwd: "/tmp",
          instructions: "help",
          approvalPolicy: "sometimes",
        },
      },
      400,
      /Invalid enum value/,
    );
    await expectJsonStatus(
      `${baseUrl}/api/sensor-events`,
      { method: "POST", body: { source: "", type: "ticket", body: "x" } },
      400,
      /Field source/,
    );
    await expectJsonStatus(
      `${baseUrl}/api/approvals/approval-1`,
      { method: "POST", body: { decision: "maybe" } },
      400,
      /Invalid enum value/,
    );

    const automation = await jsonFetch(`${baseUrl}/api/automation/tick`, {
      method: "POST",
      body: {},
    });
    assert.deepEqual(automation.result, {
      routedWorkItem: null,
      dispatchedWorkItems: [],
      jarvisNotificationDelivery: null,
    });
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center API delegates workspace selection to the native picker", async () => {
  let requestedInitialPath = "";
  const manager = new CodexAgentManager({ agents: [], clientFactory: immediateFactory() });
  const server = createCommandCenterServer({
    manager,
    directoryPicker: async (initialPath) => {
      requestedInitialPath = initialPath;
      return "/tmp/chosen-workspace";
    },
  });
  await server.listen(0);

  try {
    const response = await jsonFetch(
      `http://127.0.0.1:${server.port}/api/directories/pick`,
      { method: "POST", body: { initialPath: "/tmp/current-workspace" } },
    );
    assert.equal(requestedInitialPath, "/tmp/current-workspace");
    assert.equal(response.path, "/tmp/chosen-workspace");
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
        permissionMode: "full-access",
        metadata: { routingDescription: "Writes postmortems." },
      },
    });
    assert.equal(updated.agent.name, "Postmortem Writer");
    assert.equal(updated.agent.instructions, "You write incident postmortems.");
    assert.equal(updated.agent.approvalPolicy, "never");
    assert.equal(updated.agent.approvalsReviewer, "user");
    assert.equal(updated.agent.sandbox, "danger-full-access");
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
    const baseUrl = `http://127.0.0.1:${server.port}`;

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

    const pendingNotifications = await jsonFetch(`${baseUrl}/api/notifications`);
    const pendingNotification = pendingNotifications.notifications.find(
      (item: { kind: string }) => item.kind === "approval_required",
    );
    assert.equal(pendingNotification.status, "pending");
    assert.equal(pendingNotification.agentId, "maintenance");
    await expectJsonStatus(
      `${baseUrl}/api/notifications/${pendingNotification.id}/dismiss`,
      { method: "POST" },
      400,
      /Approval notifications resolve/,
    );

    const resolved = await jsonFetch(`${baseUrl}/api/approvals/${event?.payload.approvalId}`, {
      method: "POST",
      body: { decision: "approved", reason: "confirmed from UI" },
    });

    assert.equal(resolved.approval.payload.decision, "approved");
    assert.deepEqual(await approval, {
      decision: "approved",
      reason: "confirmed from UI",
    });
    const resolvedNotifications = await jsonFetch(`${baseUrl}/api/notifications`);
    assert.equal(
      resolvedNotifications.notifications.find((item: { id: string }) => item.id === pendingNotification.id)
        ?.status,
      "resolved",
    );
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center API exposes and resolves compatibility migration approvals", async () => {
  const manager = new CodexAgentManager({
    agents: [{
      id: "maintenance",
      name: "Maintenance Debugger",
      cwd: "/tmp/ops-poc",
      instructions: "You specialize in maintenance debugging.",
      model: "gpt-retired",
    }],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    await expectJsonStatus(
      `${baseUrl}/api/agents/maintenance/messages`,
      { method: "POST", body: { message: "continue" } },
      400,
      /blocked/i,
    );

    const compatibility = await jsonFetch(`${baseUrl}/api/compatibility`);
    assert.equal(compatibility.approvals.length, 1);
    assert.equal(compatibility.approvals[0].issue.kind, "model_unavailable");
    assert.equal(compatibility.approvals[0].issue.suggestedModels[0].model, "gpt-test");
    const notifications = await jsonFetch(`${baseUrl}/api/notifications`);
    const compatibilityNotification = notifications.notifications.find(
      (item: { kind: string }) => item.kind === "compatibility_required",
    );
    assert.ok(compatibilityNotification);
    await expectJsonStatus(
      `${baseUrl}/api/notifications/${compatibilityNotification.id}/dismiss`,
      { method: "POST" },
      400,
      /Compatibility approvals resolve/,
    );

    const resolved = await jsonFetch(
      `${baseUrl}/api/compatibility/${compatibility.approvals[0].id}/resolve`,
      { method: "POST", body: { decision: "approved", model: "gpt-test" } },
    );
    assert.equal(resolved.approval.status, "approved");
    assert.equal(resolved.approval.replacementModel, "gpt-test");

    const agents = await jsonFetch(`${baseUrl}/api/agents`);
    assert.equal(agents.agents[0].model, "gpt-test");
    assert.equal(agents.agents[0].status, "idle");
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center API interrupts running agents", async () => {
  const manager = new CodexAgentManager({
    agents: [
      {
        id: "maintenance",
        name: "Maintenance Debugger",
        cwd: "/tmp/ops-poc",
        instructions: "You specialize in maintenance debugging.",
      },
    ],
    clientFactory: () => new PendingCodexClient(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    void manager.sendToAgent("maintenance", "stop this risky work").catch(() => {});
    await waitFor(() => manager.getAgent("maintenance").status === "running", "running agent");

    const cancelled = await jsonFetch(`http://127.0.0.1:${server.port}/api/agents/maintenance/cancel`, {
      method: "POST",
    });
    assert.equal(cancelled.event.type, "turn_interrupt_requested");
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

    assert.equal(created.event.status, "unassigned");
    assert.equal(duplicate.event.id, created.event.id);
    assert.equal(listed.events.length, 1);
    assert.deepEqual(workItems.workItems, []);
  } finally {
    await server.close();
    await manager.close();
  }
});

test("direct event routing is recorded before its worker starts", async () => {
  const manager = new CodexAgentManager({
    agents: [
      {
        id: "maintenance",
        name: "Maintenance Debugger",
        cwd: "/tmp/ops-poc",
        instructions: "You specialize in maintenance debugging.",
      },
    ],
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
        body: "platform-456 needs maintenance triage.",
        dedupeKey: "jira:platform-456",
        targetAgentId: "maintenance",
        executionPolicy: "new",
      },
    });

    assert.equal(created.event.executionPolicy, "new");
    assert.equal(created.event.targetAgentId, `maintenance--${created.event.id}`);
    assert.equal(manager.getAgent(created.event.targetAgentId).metadata.instanceOfAgentId, "maintenance");

    await waitFor(
      () => manager.listWorkItems().some((item) => item.eventId === created.event.id && item.status === "done"),
      "directly routed work completion",
    );

    const eventTypes = manager.listEvents().map((event) => event.type);
    const createdIndex = eventTypes.indexOf("work_item_created");
    const routedIndex = eventTypes.indexOf("sensor_event_routed");
    const startedIndex = eventTypes.indexOf("work_item_started");

    assert.ok(createdIndex >= 0);
    assert.ok(routedIndex > createdIndex);
    assert.ok(startedIndex > routedIndex);

    const resolved = await jsonFetch(
      `${baseUrl}/api/agents/${encodeURIComponent(created.event.targetAgentId)}/instance/resolve`,
      { method: "POST", body: { resolution: "done" } },
    );
    assert.equal(resolved.agent.metadata.instanceLifecycle, "done");
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
    assert.match(html, /id="shell" class="shell topology-mode"/);
    assert.match(html, /data-panel="jarvis"/);
    assert.match(html, /data-panel="create"/);
    assert.match(html, /data-panel="events"/);
    assert.match(html, /data-panel="work"/);
    assert.match(html, /data-panel="notifications"/);
    assert.match(html, /data-sensor-event-assign/);
    assert.match(html, /notification-count/);
    assert.match(html, /instance-done-button/);
    assert.match(html, /instance-cancel-button/);
    assert.match(html, /workspace-cleanup-button/);
    assert.match(html, /needs you/);
    assert.match(html, /activePanel = "topology"/);
    assert.match(html, /class="shell topology-mode"/);
    assert.match(html, /window\.addEventListener\("pageshow"/);
    assert.doesNotMatch(html, /id="directory-picker"/);
    assert.match(html, /data-browse-cwd/);
    assert.match(html, /\/api\/directories\/pick/);
    assert.match(html, /jarvis-mode/);
    assert.match(html, /ops-mode/);
    assert.match(html, /ops-workspace/);
    assert.match(html, /ops-title/);
    assert.match(html, /ops-count/);
    assert.match(html, /Talk to the command center as a whole/);
    assert.match(html, /jarvisAgent/);
    assert.match(html, /const previousPanel = activePanel/);
    assert.match(html, /previousPanel !== activePanel/);
    assert.match(html, /lastMessagesHtml = ""/);
    assert.match(html, /render\(\);/);
    assert.match(html, /editAgentDirty = false/);
    assert.match(html, /editAgentLoadedId = null/);
    assert.match(html, /event\.currentTarget\.reset/);
    assert.match(html, /await refreshAgents\(\)/);
    assert.match(html, /renderPanel/);
    assert.match(html, /class="message-list"/);
    assert.match(html, /message-bubble\.user/);
    assert.match(html, /message-bubble\.agent/);
    assert.match(html, /pending-message/);
    assert.match(html, /lastMessagesHtml/);
    assert.match(html, /renderMessagesIfChanged/);
    assert.match(html, /isScrolledNearBottom/);
    assert.doesNotMatch(html, /message-row .*animation/);
    assert.match(html, /Agent created/);
    assert.match(html, /Message sent/);
    assert.match(html, /deriveAgentId/);
    assert.match(html, /upsertAgent/);
    assert.match(html, /ID \(optional\)/);
    assert.match(html, /\/api\/model-options/);
    assert.match(html, /data-model-select/);
    assert.match(html, /Default Codex model/);
    assert.match(html, /updateModelSelect/);
    assert.match(html, /name="reasoningEffort"/);
    assert.match(html, /data-reasoning-select/);
    assert.match(html, /name="serviceTier"/);
    assert.match(html, /data-service-tier-select/);
    assert.match(html, /name="permissionMode"/);
    assert.match(html, /Ask for approval/);
    assert.match(html, /Approve for me/);
    assert.match(html, /Full access/);
    assert.match(html, /permissionModeForAgent/);
    assert.match(html, /permissionSummary/);
    assert.match(html, /confirmFullAccess/);
    assert.match(html, /Enable full access\?/);
    assert.match(html, /Permission changes apply on the next turn without replacing this thread/);
    assert.match(html, /id="composer-permission"/);
    assert.match(html, /id="composer-runtime-toggle"/);
    assert.match(html, /id="composer-runtime-menu"/);
    assert.match(html, /id="composer-reasoning-options"/);
    assert.match(html, /id="composer-model-options"/);
    assert.match(html, /updatePermissionFromComposer/);
    assert.match(html, /updateModelFromComposer/);
    assert.match(html, /updateReasoningFromComposer/);
    assert.match(html, /renderComposerRuntimeMenu/);
    assert.match(html, /updateAgentFromComposer/);
    assert.match(html, /Agent settings updated/);
    assert.match(html, /refreshModelOptions/);
    assert.match(html, /renderModelControls/);
    assert.match(html, /serviceTierOptions/);
    assert.match(html, /selected\.reasoningEffort/);
    assert.match(html, /selected\.serviceTier/);
    assert.match(html, /compatibilityApprovals/);
    assert.match(html, /resolveCompatibilityApproval/);
    assert.match(html, /id="compatibility-health"/);
    assert.doesNotMatch(html, /<datalist id="model-options"/);
    assert.doesNotMatch(html, /list="model-options"/);
    assert.match(html, /<option value="router">Router<\/option>/);
    assert.match(html, /<option value="jarvis">Jarvis<\/option>/);
    assert.match(html, /Routing description/);
    assert.match(html, /metadata\.routingDescription = body\.routingDescription/);
    assert.match(html, /defaultRouterInstructions/);
    assert.match(html, /defaultJarvisInstructions/);
    assert.match(html, /applyCreateRoleDefaults/);
    assert.match(html, /You are the router agent for the multi-agent Codex command center/);
    assert.match(html, /You are Jarvis, the human-facing agent for the multi-agent Codex command center/);
    assert.match(html, /edit-agent-form/);
    assert.match(html, /id="rail-agents"/);
    assert.match(html, /class="settings-modal"/);
    assert.match(html, /id="close-agent-settings"/);
    assert.match(html, /topology:edit-agent/);
    assert.match(html, /forceLatestMessage/);
    assert.match(html, /requestAnimationFrame/);
    assert.doesNotMatch(html, /<details id="agent-settings"/);
    assert.match(html, /Developer instructions/);
    assert.match(html, /updateSelectedAgent/);
    assert.match(html, /deleteSelectedAgent/);
    assert.match(html, /cancel-agent-button/);
    assert.match(html, /cancelSelectedAgent/);
    assert.match(html, /\/cancel/);
    assert.match(html, /method: "PATCH"/);
    assert.match(html, /method: "DELETE"/);
    assert.match(html, /approval-card/);
    assert.match(html, /activity-sequence/);
    assert.match(html, /activity-toggle/);
    assert.match(html, /commentary-sequence/);
    assert.match(html, /commentary-live/);
    assert.match(html, /data-commentary-id/);
    assert.match(html, /summarizeCommentaryEvents/);
    assert.match(html, /commentarySummaryToTimelineMessages/);
    assert.match(html, /liveTurnToTimelineMessages/);
    assert.match(html, /liveActivityEntry/);
    assert.match(html, /summarizeLiveActivityBatch/);
    assert.match(html, /kind: "liveActivityBatch"/);
    assert.match(html, /kind: "liveActivity"/);
    assert.match(html, /live-activity-line/);
    assert.match(html, /commentarySummaries\.filter\(\(summary\) => summary\.status !== "running"\)/);
    assert.match(html, /activitySummaries\.filter\(\(summary\) => summary\.status !== "running"\)/);
    assert.match(html, /isCommentaryEvent/);
    assert.match(html, /isDisplayableActivityEvent/);
    assert.match(html, /event\.type !== "codex_item_started"/);
    assert.match(html, /existingIndex = activityBatch\.findIndex/);
    assert.match(html, /itemType === "commandExecution"/);
    assert.match(html, /itemType === "mcpToolCall"/);
    assert.match(html, /itemType === "fileChange"/);
    assert.match(html, /payload\?\.item\?\.phase \|\| ""\) === "commentary"/);
    assert.match(html, /String\(event\.payload\?\.itemType \|\| event\.payload\?\.item\?\.type \|\| ""\) === "agentMessage"/);
    assert.match(html, /Commentary extends the original dark command-center theme/);
    assert.match(html, /body \{ margin: 0;[^\n]+color: #e6edf3; background: #0d1117;/);
    assert.match(html, /activityOpenState/);
    assert.match(html, /activityScrollState/);
    assert.match(html, /captureActivityScrollPositions/);
    assert.match(html, /restoreActivityScrollPositions/);
    assert.match(html, /activityInteractionPauseUntil/);
    assert.match(html, /markActivityInteraction/);
    assert.match(html, /Date\.now\(\) > activityInteractionPauseUntil/);
    assert.match(html, /bindActivityToggles/);
    assert.match(html, /data-activity-id/);
    assert.match(html, /max-height: 260px/);
    assert.doesNotMatch(html, /summary\.entries\.slice\(-10\)/);
    assert.match(html, /shouldShowTimelineInChat/);
    assert.match(html, /summary\.status === "running" \|\| summary\.status === "failed" \|\| summary\.status === "cancelled" \|\| summary\.hasApproval \|\| summary\.hasCompaction/);
    assert.match(html, /hasCompaction/);
    assert.match(html, /Approve Tool/);
    assert.match(html, /approved-session/);
    assert.match(html, /canApproveApprovalForSession/);
    assert.match(html, /const scope = decision === "approved-session" \? "session" : "once"/);
    assert.match(html, /approvalParamsText/);
    assert.match(html, /tool_params/);
    assert.doesNotMatch(html, /activity-card/);
    assert.match(html, /summarizeActivityEvents/);
    assert.match(html, /codex_item_completed/);
    assert.match(html, /codex_thread_compacted/);
    assert.match(html, /Thread compacted/);
    assert.match(html, /summarizeWorkEvents/);
    assert.match(html, /workSummaryToTimelineMessage/);
    assert.match(html, /activitySummaryToTimelineMessage/);
    assert.match(html, /activityId: "activity-" \+ event\.id/);
    assert.match(html, /summary\.activityId \|\| "activity-" \+ String\(summary\.eventIds\[0\] \|\| summary\.createdAt\)/);
    assert.doesNotMatch(html, /current\.eventIds\.push\(event\.id\);\s+continue;\s+\}\s+if \(event\.type === "codex_item_completed"\)/);
    assert.match(html, /resolveApproval/);
    assert.match(html, /data-approval-action="approved"/);
    assert.match(html, /Event Inbox/);
    assert.match(html, /ops-log/);
    assert.match(html, /\.shell\.jarvis-mode \.workspace, \.shell\.agents-mode \.workspace, \.shell\.ops-mode \.ops-workspace \{ display: grid; grid-column: 2; \}/);
    assert.match(html, /queue-time/);
    assert.match(html, /queue-state/);
    assert.match(html, /queue-message/);
    assert.match(html, /log-summary/);
    assert.match(html, /log-detail/);
    assert.match(html, /renderSensorEventLog/);
    assert.match(html, /renderWorkItemLog/);
    assert.match(html, /eventBelongsToAgentInstance/);
    assert.match(html, /return eventTime >= agentTime/);
    assert.match(html, /formatShortTime/);
    assert.match(html, /updateOpsCount/);
    assert.match(html, /No sensor events yet/);
    assert.doesNotMatch(html, /visibleSensorEvents/);
    assert.doesNotMatch(html, /event\.status !== "routed"/);
    assert.doesNotMatch(html, /No pending or failed sensor events/);
    assert.match(html, /Work Queue/);
    assert.match(html, /Notifications/);
    assert.match(html, /notifications-list/);
    assert.match(html, /renderNotifications/);
    assert.match(html, /openNotification/);
    assert.match(html, /dismissNotification/);
    assert.match(html, /data-notification-agent-id/);
    assert.match(html, /event\.payload\.internal === true/);
    assert.match(html, /sensor-events/);
    assert.match(html, /work-items/);
    assert.match(html, /hasActiveTurnPending/);
    assert.match(html, /turnStartedAt > turnFinishedAt/);
    assert.match(html, /event\.startedAt >= item\.createdAt/);
    assert.match(html, /item\.agentId === selected\.id && eventBelongsToAgentInstance\(item, selected\)/);
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

test("command center UI exposes a topology-first home and rendering module", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const page = await fetch(`${baseUrl}/`);
    const html = await page.text();

    assert.match(html, /data-panel="topology"/);
    assert.match(html, /id="topology-workspace"/);
    assert.match(html, /id="topology-canvas"/);
    assert.match(html, /id="topology-inspector"/);
    assert.match(html, /id="topology-agent-list"/);
    assert.match(html, /id="topology-add-agent"/);
    assert.match(html, /id="topology-motion-toggle"/);
    assert.match(html, /id="topology-zoom-out"/);
    assert.match(html, /id="topology-fit-secondary"/);
    assert.match(html, /activePanel = "topology"/);
    assert.match(html, /type="module" src="\/assets\/topology\.js"/);

    const moduleResponse = await fetch(`${baseUrl}/assets/topology.js`);
    assert.equal(moduleResponse.status, 200);
    assert.match(moduleResponse.headers.get("content-type") ?? "", /javascript/);
    const moduleSource = await moduleResponse.text();
    assert.match(moduleSource, /from "three"/);
    assert.match(moduleSource, /SphereGeometry/);
    assert.match(moduleSource, /prefers-reduced-motion/);
    assert.match(moduleSource, /permissionLabel/);
    assert.match(moduleSource, /Automatic risk review/);
    assert.match(moduleSource, /Approval prompts disabled/);
    assert.match(moduleSource, /data-edit-agent/);
    assert.match(moduleSource, /topology:edit-agent/);
    assert.match(moduleSource, /\/api\/sensor-events/);
    assert.match(moduleSource, /createSourceNode/);
    assert.match(moduleSource, /jarvis\.topology\.viewport\.v1/);
    assert.match(moduleSource, /panning-view/);
    assert.match(moduleSource, /setCameraDistance/);
    assert.match(moduleSource, /route-selected/);
    assert.doesNotMatch(moduleSource, /sensorSources\.slice\(0, 5\)/);

    const vendorResponse = await fetch(`${baseUrl}/vendor/three.module.js`);
    assert.equal(vendorResponse.status, 200);
    assert.match(vendorResponse.headers.get("content-type") ?? "", /javascript/);
    assert.match(await vendorResponse.text(), /SphereGeometry/);

    const coreVendorResponse = await fetch(`${baseUrl}/vendor/three.core.min.js`);
    assert.equal(coreVendorResponse.status, 200);
    assert.match(coreVendorResponse.headers.get("content-type") ?? "", /javascript/);
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

async function expectJsonStatus(
  url: string,
  init: { method?: string; body?: unknown },
  status: number,
  errorPattern: RegExp,
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
  assert.equal(response.status, status, JSON.stringify(body));
  assert.match(String(body.error), errorPattern);
  return body;
}
