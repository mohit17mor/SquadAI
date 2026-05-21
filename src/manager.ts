import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

import { createDefaultClientFactory } from "./codexControlFactory.js";
import { MemoryAgentStateStore } from "./stateStore.js";
import type {
  AgentDefinition,
  AgentDefinitionUpdate,
  AgentEvent,
  AgentEventType,
  AgentSnapshot,
  AgentStateStore,
  AgentStatus,
  AskOptions,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalScope,
  CodexAgentManagerOptions,
  CodexControlClientFactory,
  CodexControlClientLike,
  CodexSessionLike,
  PersistedAgentManagerState,
  RoutingDecision,
  SensorEvent,
  SensorEventInput,
  SendResult,
  WorkItem,
} from "./types.js";
import { CodexAgentManagerError } from "./types.js";

const DEFAULT_AGENT_TURN_TIMEOUT_MS = 1_800_000;

type RuntimeRecord = {
  definition: AgentDefinition;
  status: AgentStatus;
  client: CodexControlClientLike | null;
  session: CodexSessionLike | null;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  activeTurn: Promise<SendResult> | null;
};

type PendingApproval = {
  approvalId: string;
  agentId: string;
  request: ApprovalRequest;
  resolve: (response: ApprovalResponse) => void;
  settled: boolean;
};

type ApprovalGrant = {
  agentId: string;
  method: string;
  serverName: string;
  toolName: string;
  threadId: string;
  scope: Exclude<ApprovalScope, "once">;
  createdAt: string;
};

type RouterRosterEntry = {
  id: string;
  name: string;
  capabilities: string;
  metadata: Record<string, unknown>;
};

type RouterRosterState = {
  digest: string;
  threadId: string;
};

export class CodexAgentManager extends EventEmitter {
  private readonly definitions = new Map<string, AgentDefinition>();
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly stateStore: AgentStateStore;
  private readonly clientFactory: CodexControlClientFactory;
  private readonly clock: () => Date;
  private events: AgentEvent[] = [];
  private sensorEvents: SensorEvent[] = [];
  private workItems: WorkItem[] = [];
  private pendingApprovals = new Map<string, PendingApproval>();
  private approvalGrants: ApprovalGrant[] = [];
  private nextEventId = 1;
  private nextApprovalId = 1;
  private nextSensorEventId = 1;
  private nextWorkItemId = 1;
  private routerRosterStates = new Map<string, RouterRosterState>();
  private started: Promise<void> | null = null;
  private closed = false;

  constructor(options: CodexAgentManagerOptions) {
    super();
    this.stateStore = options.stateStore ?? new MemoryAgentStateStore();
    this.clientFactory = options.clientFactory ?? createDefaultClientFactory();
    this.clock = options.clock ?? (() => new Date());

    for (const definition of options.agents) {
      validateDefinition(definition);
      if (this.definitions.has(definition.id)) {
        throw new CodexAgentManagerError(`Duplicate agent id: ${definition.id}`);
      }
      this.addRecord(definition);
    }
  }

  async start(): Promise<void> {
    this.assertOpen();
    if (!this.started) {
      this.started = this.loadState();
    }
    await this.started;
  }

  listAgents(): AgentSnapshot[] {
    return Array.from(this.records.values()).map((record) => this.snapshot(record));
  }

  getAgent(agentId: string): AgentSnapshot {
    return this.snapshot(this.requireRecord(agentId));
  }

  async createAgent(definition: AgentDefinition): Promise<AgentSnapshot> {
    this.assertOpen();
    await this.start();
    validateDefinition(definition);
    if (this.records.has(definition.id)) {
      throw new CodexAgentManagerError(`Agent already exists: ${definition.id}`);
    }
    const record = this.addRecord(definition);
    this.invalidateRouterRosters();
    await this.persist();
    return this.snapshot(record);
  }

  async updateAgent(agentId: string, update: AgentDefinitionUpdate): Promise<AgentSnapshot> {
    this.assertOpen();
    await this.start();
    const record = this.requireRecord(agentId);
    if (record.activeTurn || record.status === "starting" || record.status === "running") {
      throw new CodexAgentManagerError(`Agent ${agentId} is running and cannot be edited.`);
    }
    const nextDefinition: AgentDefinition = {
      ...record.definition,
      ...update,
      id: record.definition.id,
    };
    if (update.metadata !== undefined) {
      nextDefinition.metadata = cloneRecord(update.metadata);
    } else if (record.definition.metadata !== undefined) {
      nextDefinition.metadata = record.definition.metadata;
    }
    validateDefinition(nextDefinition);
    const restartNeeded = requiresFreshSession(record.definition, nextDefinition);
    if (restartNeeded) {
      await this.closeRecordClient(record);
      record.session = null;
      record.threadId = null;
      record.status = "idle";
      record.lastError = null;
    }
    record.definition = nextDefinition;
    record.updatedAt = this.now();
    this.definitions.set(agentId, nextDefinition);
    this.invalidateRouterRosters();
    await this.recordEvent(agentId, "agent_updated", "Agent updated.", {
      restartNeeded,
    });
    await this.persist();
    return this.snapshot(record);
  }

  async deleteAgent(agentId: string): Promise<AgentSnapshot> {
    this.assertOpen();
    await this.start();
    const record = this.requireRecord(agentId);
    if (record.activeTurn || record.status === "starting" || record.status === "running") {
      throw new CodexAgentManagerError(`Agent ${agentId} is running and cannot be deleted.`);
    }
    const blockingWork = this.workItems.find(
      (item) => item.targetAgentId === agentId && (item.status === "queued" || item.status === "running"),
    );
    if (blockingWork) {
      throw new CodexAgentManagerError(
        `Agent ${agentId} has active work item ${blockingWork.id} and cannot be deleted.`,
      );
    }
    const snapshot = this.snapshot(record);
    await this.closeRecordClient(record);
    this.records.delete(agentId);
    this.definitions.delete(agentId);
    this.invalidateRouterRosters();
    await this.recordEvent(agentId, "agent_deleted", "Agent deleted.", {});
    await this.persist();
    return snapshot;
  }

  listEvents(agentId?: string): AgentEvent[] {
    const events = agentId
      ? this.events.filter((event) => event.agentId === agentId)
      : this.events;
    return events.map((event) => ({ ...event, payload: { ...event.payload } }));
  }

  async sendToAgent(
    agentId: string,
    input: string,
    options: AskOptions = {},
  ): Promise<SendResult> {
    this.assertOpen();
    if (!input.trim()) {
      throw new CodexAgentManagerError("Cannot send an empty message to an agent.");
    }
    await this.start();

    const record = this.requireRecord(agentId);
    if (record.activeTurn || record.status === "starting" || record.status === "running") {
      throw new CodexAgentManagerError(`Agent ${agentId} is already running a turn.`);
    }

    const turn = this.runTurn(record, input, {
      timeoutMs: DEFAULT_AGENT_TURN_TIMEOUT_MS,
      ...options,
    });
    record.activeTurn = turn;
    return turn;
  }

  async interruptAgentTurn(agentId: string): Promise<AgentEvent> {
    this.assertOpen();
    await this.start();
    const record = this.requireRecord(agentId);
    if (!record.activeTurn || record.status !== "running") {
      throw new CodexAgentManagerError(`Agent ${agentId} does not have a running turn.`);
    }
    if (!record.session?.interrupt) {
      throw new CodexAgentManagerError(`Agent ${agentId} does not support turn interruption.`);
    }
    await record.session.interrupt();
    return this.recordEvent(agentId, "turn_interrupt_requested", "Turn interrupt requested.", {
      threadId: record.threadId,
    });
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalResponse["decision"],
    reason?: string,
    scope: ApprovalScope = "once",
  ): Promise<AgentEvent> {
    this.assertOpen();
    await this.start();
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.settled) {
      throw new CodexAgentManagerError(`Unknown or resolved approval: ${approvalId}`);
    }

    pending.settled = true;
    this.pendingApprovals.delete(approvalId);
    if (decision === "approved" && scope === "session") {
      const grant = approvalGrantForRequest(pending.agentId, pending.request, this.now(), scope);
      if (grant) {
        this.approvalGrants = this.approvalGrants.filter((item) => !sameApprovalGrant(item, grant));
        this.approvalGrants.push(grant);
      }
    }
    const response: ApprovalResponse = reason ? { decision, reason } : { decision };
    pending.resolve(response);
    return this.recordEvent(
      pending.agentId,
      "approval_resolved",
      decision === "approved" ? "Approval approved." : "Approval declined.",
      {
        approvalId,
        decision,
        reason,
        scope,
        kind: pending.request.kind,
        method: pending.request.method,
      },
    );
  }

  listSensorEvents(): SensorEvent[] {
    return this.sensorEvents.map(cloneSensorEvent);
  }

  getSensorEvent(eventId: string): SensorEvent {
    const event = this.sensorEvents.find((item) => item.id === eventId);
    if (!event) {
      throw new CodexAgentManagerError(`Unknown sensor event: ${eventId}`);
    }
    return cloneSensorEvent(event);
  }

  listWorkItems(): WorkItem[] {
    return this.workItems.map(cloneWorkItem);
  }

  getWorkItem(workItemId: string): WorkItem {
    const workItem = this.workItems.find((item) => item.id === workItemId);
    if (!workItem) {
      throw new CodexAgentManagerError(`Unknown work item: ${workItemId}`);
    }
    return cloneWorkItem(workItem);
  }

  async retryWorkItem(workItemId: string): Promise<WorkItem> {
    this.assertOpen();
    await this.start();
    const workItem = this.workItems.find((item) => item.id === workItemId);
    if (!workItem) {
      throw new CodexAgentManagerError(`Unknown work item: ${workItemId}`);
    }
    if (workItem.status !== "failed") {
      throw new CodexAgentManagerError(`Only failed work items can be retried: ${workItemId}`);
    }
    workItem.status = "queued";
    workItem.result = null;
    workItem.failureReason = null;
    workItem.startedAt = null;
    workItem.completedAt = null;
    workItem.updatedAt = this.now();
    await this.recordEvent(workItem.targetAgentId, "work_item_requeued", "Work item requeued.", {
      workItemId: workItem.id,
      sensorEventId: workItem.eventId,
    });
    await this.persist();
    return cloneWorkItem(workItem);
  }

  async ingestSensorEvent(input: SensorEventInput): Promise<SensorEvent> {
    this.assertOpen();
    await this.start();
    const normalized = normalizeSensorEventInput(input);
    if (normalized.dedupeKey) {
      const existing = this.sensorEvents.find(
        (event) => event.source === normalized.source && event.dedupeKey === normalized.dedupeKey,
      );
      if (existing) {
        return cloneSensorEvent(existing);
      }
    }

    const now = this.now();
    const event: SensorEvent = {
      id: `sensor-${this.nextSensorEventId++}`,
      ...normalized,
      status: "pending",
      workItemId: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sensorEvents.push(event);
    await this.recordEvent("system", "sensor_event_ingested", "Sensor event ingested.", {
      sensorEventId: event.id,
      source: event.source,
      type: event.type,
      dedupeKey: event.dedupeKey,
    });
    await this.persist();
    return cloneSensorEvent(event);
  }

  async processNextSensorEvent(routerAgentId?: string): Promise<WorkItem> {
    this.assertOpen();
    await this.start();
    const event = this.sensorEvents.find((item) => item.status === "pending");
    if (!event) {
      throw new CodexAgentManagerError("No pending sensor events.");
    }
    const router = routerAgentId ? this.requireRecord(routerAgentId) : this.findRouterRecord();
    event.status = "routing";
    event.updatedAt = this.now();
    await this.persist();

    try {
      let result: SendResult | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.ensureRouterRosterCurrent(router);
        const expectedRosterDigest = this.currentRouterRosterDigest(router.definition.id);
        result = await this.sendToAgent(
          router.definition.id,
          this.routerPrompt(event, expectedRosterDigest),
          { timeoutMs: 600_000 },
        );
        if (this.currentRouterRosterDigest(router.definition.id) === expectedRosterDigest) {
          break;
        }
        result = null;
      }
      if (!result) {
        throw new CodexAgentManagerError("Router session changed while routing; retry the event.");
      }
      const decision = parseRoutingDecision(result.finalText);
      this.validateRoutingDecision(decision, router.definition.id);
      const workItem = await this.createWorkItemFromDecision(event, router.definition.id, decision);
      event.status = "routed";
      event.workItemId = workItem.id;
      event.failureReason = null;
      event.updatedAt = this.now();
      await this.recordEvent(router.definition.id, "sensor_event_routed", "Sensor event routed.", {
        sensorEventId: event.id,
        workItemId: workItem.id,
        targetAgentId: workItem.targetAgentId,
      });
      await this.persist();
      return cloneWorkItem(workItem);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      event.status = "failed";
      event.failureReason = message;
      event.updatedAt = this.now();
      await this.recordEvent(router.definition.id, "sensor_event_failed", message, {
        sensorEventId: event.id,
      });
      await this.persist();
      throw error;
    }
  }

  async dispatchQueuedWork(): Promise<WorkItem[]> {
    this.assertOpen();
    await this.start();
    const started: WorkItem[] = [];
    for (const workItem of this.workItems.filter((item) => item.status === "queued")) {
      const record = this.records.get(workItem.targetAgentId);
      if (!record || !this.isAgentAvailable(record)) {
        continue;
      }
      workItem.status = "running";
      workItem.startedAt = this.now();
      workItem.updatedAt = workItem.startedAt;
      await this.recordEvent(workItem.targetAgentId, "work_item_started", "Work item started.", {
        workItemId: workItem.id,
        sensorEventId: workItem.eventId,
      });
      void this.runWorkItem(workItem);
      started.push(cloneWorkItem(workItem));
    }
    await this.persist();
    return started;
  }

  async runAutomationCycle(routerAgentId?: string): Promise<{
    routedWorkItem: WorkItem | null;
    dispatchedWorkItems: WorkItem[];
  }> {
    this.assertOpen();
    await this.start();
    let routedWorkItem: WorkItem | null = null;
    const router = routerAgentId
      ? this.records.get(routerAgentId) ?? null
      : this.findRouterRecordOrNull();
    if (
      router &&
      this.isAgentAvailable(router) &&
      this.sensorEvents.some((event) => event.status === "pending")
    ) {
      routedWorkItem = await this.processNextSensorEvent(routerAgentId);
    }
    const dispatchedWorkItems = await this.dispatchQueuedWork();
    return { routedWorkItem, dispatchedWorkItems };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const clients = Array.from(this.records.values())
      .map((record) => record.client)
      .filter((client): client is CodexControlClientLike => client !== null);
    await Promise.all(clients.map((client) => client.close()));
  }

  private async runTurn(
    record: RuntimeRecord,
    input: string,
    options: AskOptions,
  ): Promise<SendResult> {
    let recoveredStaleSession = false;
    try {
      for (;;) {
        try {
          return await this.runTurnOnce(record, input, options);
        } catch (error) {
          if (!recoveredStaleSession && record.threadId && isMissingRolloutError(error)) {
            recoveredStaleSession = true;
            await this.recoverStaleSession(record, error);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(record, "failed");
      record.lastError = message;
      await this.recordEvent(record.definition.id, "turn_failed", message, {});
      await this.persist();
      throw error;
    } finally {
      await this.resolvePendingApprovalsForAgent(
        record.definition.id,
        "declined",
        "Turn ended before approval was answered.",
      );
      record.activeTurn = null;
    }
  }

  private async runTurnOnce(
    record: RuntimeRecord,
    input: string,
    options: AskOptions,
  ): Promise<SendResult> {
    await this.ensureSession(record);
    const session = record.session;
    if (!session) {
      throw new CodexAgentManagerError(`Agent ${record.definition.id} did not create a session.`);
    }

    this.setStatus(record, "running");
    await this.recordEvent(record.definition.id, "turn_started", "Turn started.", {
      input,
    });

    const result = await session.ask(input, {
      ...record.definition.defaultAskOptions,
      ...options,
    });
    this.setStatus(record, "idle");
    record.lastError = null;
    await this.recordEvent(record.definition.id, "turn_completed", result.finalText, {
      threadId: result.threadId,
      turnStatus: result.turn.status,
    });
    await this.persist();

    return {
      agentId: record.definition.id,
      threadId: result.threadId,
      finalText: result.finalText,
      turn: result.turn,
    };
  }

  private async recoverStaleSession(record: RuntimeRecord, error: unknown): Promise<void> {
    const staleThreadId = record.threadId;
    await this.closeRecordClient(record);
    record.session = null;
    record.threadId = null;
    record.lastError = null;
    this.routerRosterStates.delete(record.definition.id);
    this.setStatus(record, "idle");
    await this.recordEvent(
      record.definition.id,
      "agent_failed",
      "Stored Codex session was unavailable; starting a fresh session.",
      {
        staleThreadId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    await this.persist();
  }

  private async closeRecordClient(record: RuntimeRecord): Promise<void> {
    if (record.client) {
      await record.client.close();
    }
    record.client = null;
  }

  private async ensureSession(record: RuntimeRecord): Promise<void> {
    if (record.session) {
      return;
    }

    this.setStatus(record, "starting");
    await this.recordEvent(record.definition.id, "agent_starting", "Agent session starting.", {});

    record.client = this.clientFactory({
      agentId: record.definition.id,
      approvalHandler: (request) => this.handleApprovalRequest(record.definition.id, request),
    });
    if (record.threadId) {
      record.session = await record.client.resumeSession(record.threadId);
    } else {
      record.session = await record.client.startSession({
        cwd: record.definition.cwd,
        model: record.definition.model,
        approvalPolicy: record.definition.approvalPolicy ?? "on-request",
        sandbox: record.definition.sandbox ?? "workspace-write",
        developerInstructions: record.definition.instructions,
        dynamicTools: record.definition.dynamicTools,
      });
      record.threadId = record.session.threadId;
    }
    this.attachSessionEvents(record);

    this.setStatus(record, "idle");
    record.lastError = null;
    await this.recordEvent(record.definition.id, "agent_started", "Agent session ready.", {
      threadId: record.threadId,
    });
    await this.persist();
  }

  private async loadState(): Promise<void> {
    const state = await this.stateStore.load();
    this.events = (state.events ?? []).map((event) => ({
      ...event,
      payload: { ...event.payload },
    }));
    this.sensorEvents = (state.sensorEvents ?? []).map(cloneSensorEvent);
    this.workItems = (state.workItems ?? []).map(cloneWorkItem);
    this.nextEventId =
      this.events.reduce((max, event) => Math.max(max, event.id), 0) + 1;
    this.nextApprovalId = nextApprovalEventId(this.events);
    this.nextSensorEventId = nextNumericId(this.sensorEvents, "sensor");
    this.nextWorkItemId = nextNumericId(this.workItems, "work");

    for (const [agentId, persisted] of Object.entries(state.agents ?? {})) {
      let record = this.records.get(agentId);
      if (!record && persisted.definition) {
        validateDefinition(persisted.definition);
        record = this.addRecord(persisted.definition);
      }
      if (!record) {
        continue;
      }
      record.threadId = persisted.threadId ?? null;
      if (
        persisted.routerRosterDigest
        && persisted.routerRosterThreadId
        && persisted.threadId === persisted.routerRosterThreadId
      ) {
        this.routerRosterStates.set(agentId, {
          digest: persisted.routerRosterDigest,
          threadId: persisted.routerRosterThreadId,
        });
      }
      record.status = normalizeRecoveredStatus(persisted.status);
      record.createdAt = persisted.createdAt ?? record.createdAt;
      record.updatedAt = persisted.updatedAt ?? record.updatedAt;
      record.lastError = persisted.lastError ?? null;
    }
    await this.recoverInterruptedWorkItems();
    await this.persist();
  }

  private async recoverInterruptedWorkItems(): Promise<void> {
    const interrupted = this.workItems.filter((item) => item.status === "running");
    for (const workItem of interrupted) {
      const now = this.now();
      workItem.status = "failed";
      workItem.failureReason = "Manager restarted while work item was running.";
      workItem.completedAt = now;
      workItem.updatedAt = now;
      await this.recordEvent(workItem.targetAgentId, "work_item_failed", workItem.failureReason, {
        workItemId: workItem.id,
        sensorEventId: workItem.eventId,
        recovered: true,
      });
    }
  }

  private snapshot(record: RuntimeRecord): AgentSnapshot {
    return {
      id: record.definition.id,
      name: record.definition.name,
      cwd: record.definition.cwd,
      instructions: record.definition.instructions,
      status: record.status,
      threadId: record.threadId,
      model: record.definition.model ?? null,
      metadata: { ...(record.definition.metadata ?? {}) },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastError: record.lastError,
    };
  }

  private setStatus(record: RuntimeRecord, status: AgentStatus): void {
    record.status = status;
    record.updatedAt = this.now();
  }

  private async recordEvent(
    agentId: string,
    type: AgentEventType,
    message: string,
    payload: Record<string, unknown>,
  ): Promise<AgentEvent> {
    const event: AgentEvent = {
      id: this.nextEventId++,
      agentId,
      type,
      message,
      payload: { ...payload },
      createdAt: this.now(),
    };
    this.events.push(event);
    this.emit("event", event);
    await this.persist();
    return event;
  }

  private async handleApprovalRequest(
    agentId: string,
    request: ApprovalRequest,
  ): Promise<ApprovalResponse> {
    const grant = this.findApprovalGrant(agentId, request);
    if (grant) {
      await this.recordEvent(agentId, "approval_auto_approved", "Approval auto-approved.", {
        kind: request.kind,
        method: request.method,
        scope: grant.scope,
        serverName: grant.serverName,
        toolName: grant.toolName,
        threadId: grant.threadId,
      });
      return {
        decision: "approved",
        reason: `Approved by ${grant.scope} rule for ${grant.serverName}/${grant.toolName}.`,
      };
    }
    const approvalId = `approval-${this.nextApprovalId++}`;
    const response = new Promise<ApprovalResponse>((resolve) => {
      this.pendingApprovals.set(approvalId, {
        approvalId,
        agentId,
        request,
        resolve,
        settled: false,
      });
    });
    await this.recordEvent(agentId, "approval_requested", "Approval requested.", {
      approvalId,
      kind: request.kind,
      method: request.method,
      params: request.params,
      proposedDecision: request.proposedDecision,
      proposedResult: request.proposedResult,
    });

    return response;
  }

  private attachSessionEvents(record: RuntimeRecord): void {
    const session = record.session;
    if (!session?.on) {
      return;
    }
    session.on("item.completed", (item) => {
      void this.recordCodexItemCompleted(record.definition.id, session.threadId, item);
    });
    session.on("thread.compacted", (params) => {
      void this.recordEvent(record.definition.id, "codex_thread_compacted", "Thread compacted.", {
        threadId: session.threadId,
        params: cloneUnknown(params),
      });
    });
  }

  private async recordCodexItemCompleted(
    agentId: string,
    threadId: string,
    item: unknown,
  ): Promise<void> {
    const summary = summarizeCodexItem(item);
    await this.recordEvent(agentId, "codex_item_completed", summary.title, {
      threadId,
      ...summary,
      item: cloneUnknown(item),
    });
  }

  private findApprovalGrant(agentId: string, request: ApprovalRequest): ApprovalGrant | null {
    const requested = approvalGrantForRequest(agentId, request, this.now(), "session");
    if (!requested) {
      return null;
    }
    return this.approvalGrants.find((grant) => sameApprovalGrant(grant, requested)) ?? null;
  }

  private async resolvePendingApprovalsForAgent(
    agentId: string,
    decision: ApprovalResponse["decision"],
    reason: string,
  ): Promise<void> {
    const approvals = Array.from(this.pendingApprovals.values()).filter(
      (approval) => approval.agentId === agentId && !approval.settled,
    );
    for (const approval of approvals) {
      approval.settled = true;
      this.pendingApprovals.delete(approval.approvalId);
      approval.resolve({ decision, reason });
      await this.recordEvent(agentId, "approval_resolved", "Approval resolved.", {
        approvalId: approval.approvalId,
        decision,
        reason,
        kind: approval.request.kind,
        method: approval.request.method,
      });
    }
  }

  private findRouterRecord(): RuntimeRecord {
    const routers = this.routerRecords();
    if (routers.length !== 1) {
      throw new CodexAgentManagerError(
        `Expected exactly one router agent, found ${routers.length}.`,
      );
    }
    return routers[0] as RuntimeRecord;
  }

  private findRouterRecordOrNull(): RuntimeRecord | null {
    const routers = this.routerRecords();
    return routers.length === 1 ? routers[0] as RuntimeRecord : null;
  }

  private routerRecords(): RuntimeRecord[] {
    return Array.from(this.records.values()).filter(
      (record) => record.definition.metadata?.role === "router",
    );
  }

  private async ensureRouterRosterCurrent(router: RuntimeRecord): Promise<void> {
    const { digest, roster } = this.workerRoster(router.definition.id);
    const current = this.routerRosterStates.get(router.definition.id);
    if (current?.digest === digest && current.threadId === router.threadId) {
      return;
    }
    await this.sendToAgent(
      router.definition.id,
      this.routerRosterPrompt(roster, digest),
      { timeoutMs: 600_000 },
    );
    if (!router.threadId) {
      throw new CodexAgentManagerError("Router session did not have a thread id after roster update.");
    }
    this.routerRosterStates.set(router.definition.id, {
      digest,
      threadId: router.threadId,
    });
    await this.persist();
  }

  private currentRouterRosterDigest(routerAgentId: string): string | null {
    return this.routerRosterStates.get(routerAgentId)?.digest ?? null;
  }

  private routerRosterPrompt(roster: RouterRosterEntry[], digest: string): string {
    return [
      "Worker roster update for the multi-agent Codex command center.",
      `Roster digest: ${digest}`,
      "Remember this compact worker roster for future routing decisions in this session.",
      "Use only these worker ids when assigning work. Do not assign work to yourself.",
      "The manager may queue work for busy or failed workers, so route by capability, not transient availability.",
      "",
      "Worker roster:",
      JSON.stringify(roster, null, 2),
      "",
      "Reply exactly: roster updated",
    ].join("\n");
  }

  private routerPrompt(event: SensorEvent, rosterDigest: string | null): string {
    return [
      "You are routing one sensor event for the multi-agent Codex command center.",
      `Use the compact worker roster already provided in this session${rosterDigest ? ` with digest ${rosterDigest}` : ""}.`,
      "Return only a JSON object with targetAgentId, prompt, and reason.",
      "Do not solve the task yourself. Do not assign work to yourself.",
      "",
      "Sensor event to route:",
      JSON.stringify(event, null, 2),
    ].join("\n");
  }

  private workerRoster(routerAgentId: string): { digest: string; roster: RouterRosterEntry[] } {
    const roster = Array.from(this.records.values())
      .filter((record) => record.definition.id !== routerAgentId)
      .filter((record) => record.definition.metadata?.role !== "router")
      .map((record) => ({
        id: record.definition.id,
        name: record.definition.name,
        capabilities: routingDescription(record.definition),
        metadata: routingMetadata(record.definition.metadata),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const serialized = JSON.stringify(roster);
    const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
    return { digest, roster };
  }

  private invalidateRouterRosters(): void {
    this.routerRosterStates.clear();
  }

  private validateRoutingDecision(decision: RoutingDecision, routerAgentId: string): void {
    if (decision.targetAgentId === routerAgentId) {
      throw new CodexAgentManagerError("Router agent cannot assign work to itself.");
    }
    this.requireRecord(decision.targetAgentId);
    if (!decision.prompt.trim()) {
      throw new CodexAgentManagerError("Routing decision prompt cannot be empty.");
    }
  }

  private async createWorkItemFromDecision(
    event: SensorEvent,
    routerAgentId: string,
    decision: RoutingDecision,
  ): Promise<WorkItem> {
    const now = this.now();
    const workItem: WorkItem = {
      id: `work-${this.nextWorkItemId++}`,
      eventId: event.id,
      targetAgentId: decision.targetAgentId,
      prompt: decision.prompt.trim(),
      status: "queued",
      routerAgentId,
      reason: decision.reason?.trim() || null,
      result: null,
      failureReason: null,
      metadata: { ...(decision.metadata ?? {}) },
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
    this.workItems.push(workItem);
    await this.recordEvent(decision.targetAgentId, "work_item_created", "Work item created.", {
      workItemId: workItem.id,
      sensorEventId: event.id,
      routerAgentId,
      reason: workItem.reason,
    });
    return workItem;
  }

  private async runWorkItem(workItem: WorkItem): Promise<void> {
    try {
      const result = await this.sendToAgent(workItem.targetAgentId, workItem.prompt, {
        timeoutMs: 600_000,
        network: "allow",
      });
      workItem.status = "done";
      workItem.result = result.finalText;
      workItem.failureReason = null;
      workItem.completedAt = this.now();
      workItem.updatedAt = workItem.completedAt;
      await this.recordEvent(workItem.targetAgentId, "work_item_completed", "Work item completed.", {
        workItemId: workItem.id,
        sensorEventId: workItem.eventId,
      });
      await this.persist();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      workItem.status = "failed";
      workItem.failureReason = message;
      workItem.completedAt = this.now();
      workItem.updatedAt = workItem.completedAt;
      await this.recordEvent(workItem.targetAgentId, "work_item_failed", message, {
        workItemId: workItem.id,
        sensorEventId: workItem.eventId,
      });
      await this.persist();
    }
  }

  private isAgentAvailable(record: RuntimeRecord): boolean {
    return !record.activeTurn && (record.status === "idle" || record.status === "failed");
  }

  private async persist(): Promise<void> {
    const agents: PersistedAgentManagerState["agents"] = {};
    for (const record of this.records.values()) {
      const persisted: NonNullable<PersistedAgentManagerState["agents"]>[string] = {
        definition: record.definition,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastError: record.lastError,
      };
      if (record.threadId) {
        persisted.threadId = record.threadId;
      }
      const routerRoster = this.routerRosterStates.get(record.definition.id);
      if (routerRoster && routerRoster.threadId === record.threadId) {
        persisted.routerRosterDigest = routerRoster.digest;
        persisted.routerRosterThreadId = routerRoster.threadId;
      }
      agents[record.definition.id] = persisted;
    }
    await this.stateStore.save({
      version: 1,
      agents,
      events: this.events,
      sensorEvents: this.sensorEvents,
      workItems: this.workItems,
    });
  }

  private requireRecord(agentId: string): RuntimeRecord {
    const record = this.records.get(agentId);
    if (!record) {
      throw new CodexAgentManagerError(`Unknown agent: ${agentId}`);
    }
    return record;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new CodexAgentManagerError("CodexAgentManager is closed.");
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private addRecord(definition: AgentDefinition): RuntimeRecord {
    const now = this.now();
    const record: RuntimeRecord = {
      definition,
      status: "idle",
      client: null,
      session: null,
      threadId: null,
      createdAt: now,
      updatedAt: now,
      lastError: null,
      activeTurn: null,
    };
    this.definitions.set(definition.id, definition);
    this.records.set(definition.id, record);
    return record;
  }
}

function validateDefinition(definition: AgentDefinition): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(definition.id)) {
    throw new CodexAgentManagerError(
      `Invalid agent id ${JSON.stringify(definition.id)}. Use letters, numbers, _, ., or -.`,
    );
  }
  if (typeof definition.name !== "string" || !definition.name.trim()) {
    throw new CodexAgentManagerError(`Agent ${definition.id} must have a name.`);
  }
  if (typeof definition.cwd !== "string" || !definition.cwd.trim()) {
    throw new CodexAgentManagerError(`Agent ${definition.id} must have a cwd.`);
  }
  if (typeof definition.instructions !== "string" || !definition.instructions.trim()) {
    throw new CodexAgentManagerError(`Agent ${definition.id} must have instructions.`);
  }
}

function requiresFreshSession(previous: AgentDefinition, next: AgentDefinition): boolean {
  return previous.cwd !== next.cwd ||
    previous.instructions !== next.instructions ||
    previous.model !== next.model ||
    previous.approvalPolicy !== next.approvalPolicy ||
    previous.sandbox !== next.sandbox ||
    JSON.stringify(previous.dynamicTools ?? null) !== JSON.stringify(next.dynamicTools ?? null);
}

function approvalGrantForRequest(
  agentId: string,
  request: ApprovalRequest,
  createdAt: string,
  scope: Exclude<ApprovalScope, "once">,
): ApprovalGrant | null {
  if (request.method !== "mcpServer/elicitation/request") {
    return null;
  }
  const params = isRecord(request.params) ? request.params : {};
  const metadata = isRecord(params._meta) ? params._meta : {};
  const serverName = optionalTrimmed(params.serverName);
  const toolName =
    optionalTrimmed(metadata.tool_title) ?? toolNameFromApprovalMessage(params.message);
  const threadId = optionalTrimmed(params.threadId);
  if (!serverName || !toolName || !threadId) {
    return null;
  }
  return {
    agentId,
    method: request.method,
    serverName,
    toolName,
    threadId,
    scope,
    createdAt,
  };
}

function sameApprovalGrant(left: ApprovalGrant, right: ApprovalGrant): boolean {
  return left.agentId === right.agentId &&
    left.method === right.method &&
    left.serverName === right.serverName &&
    left.toolName === right.toolName &&
    left.threadId === right.threadId &&
    left.scope === right.scope;
}

function summarizeCodexItem(item: unknown): {
  itemType: string;
  title: string;
  summary: string;
  serverName?: string;
  toolName?: string;
  command?: string;
  cwd?: string;
  exitCode?: number | string;
  durationMs?: number | string;
} {
  const value = isRecord(item) ? item : {};
  const itemType = optionalTrimmed(value.type) ?? "item";
  if (itemType === "commandExecution") {
    const command = commandToText(value.command);
    const status = firstTrimmed(value.status) ?? "command";
    const cwd = optionalTrimmed(value.cwd);
    const exitCode = primitiveStatusValue(value.exitCode);
    const durationMs = primitiveStatusValue(value.durationMs);
    const extra = [
      command,
      cwd ? `cwd: ${cwd}` : null,
      exitCode !== undefined ? `exit: ${exitCode}` : null,
      durationMs !== undefined ? `${durationMs}ms` : null,
    ].filter(Boolean).join(" · ");
    return {
      itemType,
      title: itemType,
      summary: extra ? `${status} - ${extra}` : status,
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  const serverName = firstTrimmed(value.serverName, value.mcpServerName, value.server);
  const toolName = firstTrimmed(
    value.toolName,
    value.tool,
    value.name,
    value.title,
    isRecord(value.call) ? value.call.name : undefined,
  );
  const title = serverName && toolName ? `${serverName}/${toolName}` : toolName ?? itemType;
  const text = firstTrimmed(value.text, value.message, value.summary, value.status);
  const summary = text ?? truncateForEvent(JSON.stringify(cloneUnknown(item)));
  return {
    itemType,
    title,
    summary,
    ...(serverName ? { serverName } : {}),
    ...(toolName ? { toolName } : {}),
  };
}

function commandToText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.map((part) => String(part)).join(" ").trim() || undefined;
  }
  return optionalTrimmed(value);
}

function primitiveStatusValue(value: unknown): number | string | undefined {
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  return undefined;
}

function firstTrimmed(...values: unknown[]): string | undefined {
  for (const value of values) {
    const trimmed = optionalTrimmed(value);
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function truncateForEvent(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 500) {
    return normalized;
  }
  return `${normalized.slice(0, 497)}...`;
}

function routingDescription(definition: AgentDefinition): string {
  const metadata = definition.metadata ?? {};
  const explicit = optionalTrimmed(metadata.routingDescription) ?? optionalTrimmed(metadata.capabilities);
  if (explicit) {
    return truncateForRouting(explicit);
  }
  const firstLine = definition.instructions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return truncateForRouting(firstLine ?? definition.name);
}

function routingMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const cloned = cloneRecord(metadata);
  delete cloned.role;
  delete cloned.routingDescription;
  delete cloned.capabilities;
  return cloned;
}

function truncateForRouting(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 237)}...`;
}

function normalizeRecoveredStatus(status: AgentStatus | undefined): AgentStatus {
  if (status === "stopped") {
    return "stopped";
  }
  if (status === "failed") {
    return "failed";
  }
  return "idle";
}

function normalizeSensorEventInput(input: SensorEventInput): SensorEventInput {
  const source = requiredTrimmed(input.source, "source");
  const type = requiredTrimmed(input.type, "type");
  const body = requiredTrimmed(input.body, "body");
  const normalized: SensorEventInput = {
    source,
    type,
    body,
    priority: input.priority ?? "normal",
    metadata: cloneRecord(input.metadata),
  };
  const title = optionalTrimmed(input.title);
  const url = optionalTrimmed(input.url);
  const dedupeKey = optionalTrimmed(input.dedupeKey);
  if (title) {
    normalized.title = title;
  }
  if (url) {
    normalized.url = url;
  }
  if (dedupeKey) {
    normalized.dedupeKey = dedupeKey;
  }
  return normalized;
}

function parseRoutingDecision(text: string): RoutingDecision {
  const parsed = parseJsonObject(text);
  const targetAgentId = requiredTrimmed(parsed.targetAgentId, "targetAgentId");
  const prompt = requiredTrimmed(parsed.prompt, "prompt");
  const decision: RoutingDecision = {
    targetAgentId,
    prompt,
    metadata: cloneRecord(asOptionalRecord(parsed.metadata)),
  };
  const reason = optionalTrimmed(parsed.reason);
  if (reason) {
    decision.reason = reason;
  }
  return decision;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new CodexAgentManagerError("Router response must be a JSON object.");
}

function requiredTrimmed(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CodexAgentManagerError(`Field ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new CodexAgentManagerError("Expected metadata to be an object.");
  }
  return value;
}

function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : {};
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneSensorEvent(event: SensorEvent): SensorEvent {
  return {
    ...event,
    metadata: cloneRecord(event.metadata),
  };
}

function cloneWorkItem(workItem: WorkItem): WorkItem {
  return {
    ...workItem,
    metadata: cloneRecord(workItem.metadata),
  };
}

function isMissingRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found for thread id/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nextNumericId(items: Array<{ id: string }>, prefix: string): number {
  return items.reduce((max, item) => {
    const match = item.id.match(new RegExp(`^${prefix}-(\\d+)$`));
    return match?.[1] ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
}

function nextApprovalEventId(events: AgentEvent[]): number {
  return events.reduce((max, event) => {
    const approvalId = event.payload?.approvalId;
    if (typeof approvalId !== "string") {
      return max;
    }
    const match = approvalId.match(/^approval-(\d+)$/);
    return match?.[1] ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
}

function toolNameFromApprovalMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/\btool\s+"([^"]+)"/i);
  return match?.[1]?.trim() || undefined;
}
