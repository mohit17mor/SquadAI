export type AgentStatus = "idle" | "starting" | "running" | "failed" | "stopped";

export type AgentEventType =
  | "agent_starting"
  | "agent_started"
  | "approval_requested"
  | "approval_resolved"
  | "approval_auto_approved"
  | "codex_item_completed"
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
  | "agent_stopped";

export type AgentDefinition = {
  id: string;
  name: string;
  cwd: string;
  instructions: string;
  model?: string;
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  defaultAskOptions?: AskOptions;
  dynamicTools?: unknown[];
  metadata?: Record<string, unknown>;
};

export type AgentDefinitionUpdate = Partial<Omit<AgentDefinition, "id">>;

export type AskOptions = {
  timeoutMs?: number;
  externalWrites?: "deny" | "allow";
  shellCommands?: "deny" | "allow";
  fileWrites?: "deny" | "allow";
  network?: "deny" | "allow";
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
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
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

export type SensorEventStatus = "pending" | "routing" | "routed" | "failed" | "ignored";

export type SensorEventInput = {
  source: string;
  type: string;
  body: string;
  title?: string;
  url?: string;
  dedupeKey?: string;
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

export type WorkItemStatus = "queued" | "running" | "done" | "failed";

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
};

export interface AgentStateStore {
  load(): Promise<PersistedAgentManagerState>;
  save(state: PersistedAgentManagerState): Promise<void>;
}

export type CodexControlClientLike = {
  startSession(options: Record<string, unknown>): Promise<CodexSessionLike>;
  resumeSession(threadId: string): Promise<CodexSessionLike>;
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
};

export class CodexAgentManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAgentManagerError";
  }
}
