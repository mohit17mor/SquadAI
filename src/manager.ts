import { EventEmitter } from "node:events";

import { createDefaultClientFactory } from "./codexControlFactory.js";
import { MemoryAgentStateStore } from "./stateStore.js";
import type {
  AgentDefinition,
  AgentEvent,
  AgentEventType,
  AgentSnapshot,
  AgentStateStore,
  AgentStatus,
  AskOptions,
  ApprovalRequest,
  ApprovalResponse,
  CodexAgentManagerOptions,
  CodexControlClientFactory,
  CodexControlClientLike,
  CodexSessionLike,
  PersistedAgentManagerState,
  SendResult,
} from "./types.js";
import { CodexAgentManagerError } from "./types.js";

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

export class CodexAgentManager extends EventEmitter {
  private readonly definitions = new Map<string, AgentDefinition>();
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly stateStore: AgentStateStore;
  private readonly clientFactory: CodexControlClientFactory;
  private readonly clock: () => Date;
  private events: AgentEvent[] = [];
  private pendingApprovals = new Map<string, PendingApproval>();
  private nextEventId = 1;
  private nextApprovalId = 1;
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
    await this.persist();
    return this.snapshot(record);
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

    const turn = this.runTurn(record, input, options);
    record.activeTurn = turn;
    return turn;
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalResponse["decision"],
    reason?: string,
  ): Promise<AgentEvent> {
    this.assertOpen();
    await this.start();
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.settled) {
      throw new CodexAgentManagerError(`Unknown or resolved approval: ${approvalId}`);
    }

    pending.settled = true;
    this.pendingApprovals.delete(approvalId);
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
        kind: pending.request.kind,
        method: pending.request.method,
      },
    );
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
    try {
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
    this.nextEventId =
      this.events.reduce((max, event) => Math.max(max, event.id), 0) + 1;

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
      record.status = normalizeRecoveredStatus(persisted.status);
      record.createdAt = persisted.createdAt ?? record.createdAt;
      record.updatedAt = persisted.updatedAt ?? record.updatedAt;
      record.lastError = persisted.lastError ?? null;
    }
    await this.persist();
  }

  private snapshot(record: RuntimeRecord): AgentSnapshot {
    return {
      id: record.definition.id,
      name: record.definition.name,
      cwd: record.definition.cwd,
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
      agents[record.definition.id] = persisted;
    }
    await this.stateStore.save({
      version: 1,
      agents,
      events: this.events,
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
  if (!definition.name.trim()) {
    throw new CodexAgentManagerError(`Agent ${definition.id} must have a name.`);
  }
  if (!definition.cwd.trim()) {
    throw new CodexAgentManagerError(`Agent ${definition.id} must have a cwd.`);
  }
  if (!definition.instructions.trim()) {
    throw new CodexAgentManagerError(`Agent ${definition.id} must have instructions.`);
  }
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
