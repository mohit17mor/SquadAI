export type AgentStatus = "idle" | "starting" | "running" | "failed" | "blocked" | "stopped";
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type AgentEventType =
  | "agent_starting"
  | "agent_started"
  | "approval_requested"
  | "approval_resolved"
  | "approval_auto_approved"
  | "codex_item_completed"
  | "codex_turn_retrying"
  | "codex_thread_compacted"
  | "sensor_event_ingested"
  | "sensor_event_routed"
  | "sensor_event_failed"
  | "work_item_created"
  | "work_item_started"
  | "work_item_completed"
  | "work_item_failed"
  | "work_item_requeued"
  | "turn_started"
  | "turn_interrupt_requested"
  | "turn_completed"
  | "turn_failed"
  | "agent_updated"
  | "agent_deleted"
  | "agent_failed"
  | "compatibility_blocked"
  | "compatibility_migrated"
  | "compatibility_declined"
  | "agent_stopped";

export type AgentDefinition = {
  id: string;
  name: string;
  cwd: string;
  instructions: string;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  serviceTier?: string | undefined;
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never" | undefined;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | undefined;
  defaultAskOptions?: AskOptions | undefined;
  dynamicTools?: unknown[] | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type AgentDefinitionUpdate = {
  [Key in keyof Omit<AgentDefinition, "id">]?: Omit<AgentDefinition, "id">[Key] | undefined;
};

export type AskOptions = {
  timeoutMs?: number;
  externalWrites?: "deny" | "allow";
  shellCommands?: "deny" | "allow";
  fileWrites?: "deny" | "allow";
  network?: "deny" | "allow";
  internal?: {
    hiddenInput?: boolean;
    reason?: string;
  };
  confirmation?: {
    confirmed: boolean;
    reason?: string;
  };
};

export type ApprovalRequest = {
  timestamp: string;
  kind: "command_approval" | "file_approval" | "permission_approval" | "mcp_elicitation";
  method: string;
  params: unknown;
  proposedDecision: "approved" | "declined" | "failed";
  proposedResult: unknown;
};

export type ApprovalResponse = {
  decision: "approved" | "declined";
  reason?: string;
  result?: unknown;
};

export type ApprovalScope = "once" | "session";

export type ApprovalHandler = (
  request: ApprovalRequest,
) => ApprovalResponse | Promise<ApprovalResponse>;

export type AgentSnapshot = {
  id: string;
  name: string;
  cwd: string;
  instructions: string;
  status: AgentStatus;
  threadId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  serviceTier: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  compatibilityIssue: CompatibilityIssue | null;
};

export type AgentEvent = {
  id: number;
  agentId: string;
  type: AgentEventType;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type SendResult = {
  agentId: string;
  threadId: string;
  finalText: string;
  turn: Record<string, unknown>;
};

export type SensorEventStatus = "unassigned" | "pending" | "routing" | "routed" | "failed" | "ignored";

export type RoutingMode = "explicit" | "router-fallback" | "router-only";

export type SensorEventInput = {
  source: string;
  type: string;
  body: string;
  title?: string;
  url?: string;
  dedupeKey?: string;
  targetAgentId?: string;
  priority?: "low" | "normal" | "high";
  metadata?: Record<string, unknown>;
};

export type SensorEvent = SensorEventInput & {
  id: string;
  status: SensorEventStatus;
  workItemId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkItemStatus = "queued" | "running" | "done" | "failed" | "blocked";

export type WorkItem = {
  id: string;
  eventId: string | null;
  targetAgentId: string;
  prompt: string;
  status: WorkItemStatus;
  routerAgentId: string | null;
  reason: string | null;
  result: string | null;
  failureReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  retryGeneration?: number;
};

export type AgentNotificationKind =
  | "approval_required"
  | "compatibility_required"
  | "agent_failed"
  | "turn_failed"
  | "work_item_failed"
  | "sensor_event_failed";

export type AgentNotificationStatus = "pending" | "resolved";

export type AgentNotificationSeverity = "attention" | "warning";

export type AgentNotification = {
  id: string;
  kind: AgentNotificationKind;
  status: AgentNotificationStatus;
  severity: AgentNotificationSeverity;
  agentId: string;
  agentName: string;
  summary: string;
  sourceEventId: number;
  approvalId: string | null;
  workItemId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  jarvisDeliveredAt: string | null;
  jarvisDeliveryThreadId: string | null;
};

export type JarvisNotificationDelivery = {
  jarvisAgentId: string;
  threadId: string;
  notificationIds: string[];
  deliveredAt: string;
  finalText: string;
};

export type ModelServiceTier = {
  id: string;
  name: string;
  description: string;
};

export type ReasoningEffortOption = {
  reasoningEffort: ReasoningEffort;
  description: string;
};

export type AgentModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: ReasoningEffort;
  additionalSpeedTiers?: string[];
  serviceTiers: ModelServiceTier[];
  isDefault: boolean;
};

export type AgentModelCatalog = {
  models: AgentModelOption[];
};

export type CodexRuntimeInfo = {
  userAgent: string;
  platformFamily: string;
  platformOs: string;
  codexHome: string;
  binaryPath?: string;
};

export type CompatibilityIssueKind =
  | "model_unavailable"
  | "reasoning_effort_unsupported"
  | "service_tier_unsupported";

export type CompatibilityIssue = {
  kind: CompatibilityIssueKind;
  fingerprint: string;
  agentId: string;
  model: string;
  configuredValue: string;
  recommendedValue: string | null;
  message: string;
  suggestedModels: AgentModelOption[];
};

export type CompatibilityApprovalStatus = "pending" | "approved" | "declined";

export type CompatibilityApproval = {
  id: string;
  agentId: string;
  status: CompatibilityApprovalStatus;
  issue: CompatibilityIssue;
  affectedWorkItemIds: string[];
  createdAt: string;
  resolvedAt: string | null;
  replacementModel: string | null;
};

export type CompatibilityApprovalResolution = {
  decision: "approved" | "declined";
  model?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: string;
};

export type RoutingDecision = {
  targetAgentId: string;
  prompt: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type PersistedAgentState = {
  definition?: AgentDefinition;
  threadId?: string;
  routerRosterDigest?: string;
  routerRosterThreadId?: string;
  status?: AgentStatus;
  createdAt?: string;
  updatedAt?: string;
  lastError?: string | null;
};

export type PersistedAgentManagerState = {
  version?: 1;
  agents?: Record<string, PersistedAgentState>;
  events?: AgentEvent[];
  sensorEvents?: SensorEvent[];
  workItems?: WorkItem[];
  notifications?: AgentNotification[];
  compatibilityApprovals?: CompatibilityApproval[];
};

export interface AgentStateStore {
  load(): Promise<PersistedAgentManagerState>;
  save(state: PersistedAgentManagerState): Promise<void>;
}

export type CodexControlClientLike = {
  startSession(options: Record<string, unknown>): Promise<CodexSessionLike>;
  resumeSession(threadId: string): Promise<CodexSessionLike>;
  listModels?(options?: { includeHidden?: boolean }): Promise<AgentModelCatalog>;
  getRuntimeInfo?(): Promise<CodexRuntimeInfo>;
  close(): Promise<void>;
};

export type CodexSessionLike = {
  threadId: string;
  on?(event: string, handler: (...args: unknown[]) => void): unknown;
  interrupt?(): Promise<void>;
  ask(
    input: string,
    options: Record<string, unknown>,
  ): Promise<{
    finalText: string;
    threadId: string;
    turn: Record<string, unknown>;
  }>;
};

export type CodexControlClientContext = {
  agentId: string;
  approvalHandler: ApprovalHandler;
};

export type CodexControlClientFactory = (
  context?: CodexControlClientContext,
) => CodexControlClientLike;

export type CodexAgentManagerOptions = {
  agents: AgentDefinition[];
  stateStore?: AgentStateStore;
  clientFactory?: CodexControlClientFactory;
  clock?: () => Date;
  routingMode?: RoutingMode;
};

export class CodexAgentManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAgentManagerError";
  }
}
