export type AgentStatus = "idle" | "starting" | "running" | "failed" | "stopped";

export type AgentEventType =
  | "agent_starting"
  | "agent_started"
  | "turn_started"
  | "turn_completed"
  | "turn_failed"
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

export type AgentSnapshot = {
  id: string;
  name: string;
  cwd: string;
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

export type PersistedAgentState = {
  definition?: AgentDefinition;
  threadId?: string;
  status?: AgentStatus;
  createdAt?: string;
  updatedAt?: string;
  lastError?: string | null;
};

export type PersistedAgentManagerState = {
  version?: 1;
  agents?: Record<string, PersistedAgentState>;
  events?: AgentEvent[];
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
  ask(
    input: string,
    options: Record<string, unknown>,
  ): Promise<{
    finalText: string;
    threadId: string;
    turn: Record<string, unknown>;
  }>;
};

export type CodexControlClientFactory = () => CodexControlClientLike;

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
