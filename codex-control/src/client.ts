import { ApprovalManager } from "./approval.js";
import { DynamicToolManager } from "./dynamicTools.js";
import { JsonRpcPeer } from "./jsonRpcPeer.js";
import { CodexSession, threadStartParams } from "./session.js";
import { StdioCodexAppServerTransport } from "./stdioTransport.js";
import type {
  AppServerTransport,
  ApprovalHandler,
  AuditSink,
  CodexRuntimeInfo,
  JsonRpcMessage,
  ModelListOptions,
  ModelListResult,
  SessionStartOptions,
} from "./types.js";

type ThreadStartResponse = {
  thread?: {
    id?: string;
  };
};

type ModelListResponse = {
  data?: unknown[];
  nextCursor?: string | null;
};

type InitializeResponse = Partial<CodexRuntimeInfo>;

export type CodexControlClientOptions = {
  transport?: AppServerTransport;
  requestTimeoutMs?: number;
  auditSink?: AuditSink;
  approvalHandler?: ApprovalHandler;
};

export class CodexControlClient {
  private readonly peer: JsonRpcPeer;
  private readonly approvalManager: ApprovalManager;
  private readonly dynamicToolManager = new DynamicToolManager();
  private readonly sessions = new Map<string, CodexSession>();
  private started = false;
  private runtimeInfo: CodexRuntimeInfo | null = null;

  constructor(options: CodexControlClientOptions = {}) {
    const transport = options.transport ?? new StdioCodexAppServerTransport();
    this.peer = new JsonRpcPeer(transport, options.requestTimeoutMs);
    this.approvalManager = new ApprovalManager(options.auditSink, options.approvalHandler);

    this.peer.onServerRequest((message) =>
      this.dynamicToolManager.canHandle(message)
        ? this.dynamicToolManager.handle(message)
        : this.approvalManager.handle(message),
    );
    this.peer.onNotification((message) => this.handleNotification(message));
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.peer.start();
    const initialized = await this.peer.request<InitializeResponse>("initialize", {
      clientInfo: {
        name: "codex_control",
        title: "Codex Control",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.runtimeInfo = {
      userAgent: stringValue(initialized.userAgent),
      platformFamily: stringValue(initialized.platformFamily),
      platformOs: stringValue(initialized.platformOs),
      codexHome: stringValue(initialized.codexHome),
    };
    this.peer.notify("initialized", {});
    this.started = true;
  }

  async getRuntimeInfo(): Promise<CodexRuntimeInfo> {
    await this.start();
    return { ...(this.runtimeInfo as CodexRuntimeInfo) };
  }

  async startSession(options: SessionStartOptions): Promise<CodexSession> {
    await this.start();
    const result = await this.peer.request<ThreadStartResponse>(
      "thread/start",
      threadStartParams(options),
    );
    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("App Server did not return a thread id.");
    }

    const session = new CodexSession(this.peer, this.approvalManager, threadId);
    this.dynamicToolManager.register(threadId, options.dynamicTools);
    this.sessions.set(threadId, session);
    return session;
  }

  async resumeSession(threadId: string): Promise<CodexSession> {
    await this.start();
    await this.peer.request("thread/resume", { threadId });
    const session = new CodexSession(this.peer, this.approvalManager, threadId);
    this.sessions.set(threadId, session);
    return session;
  }

  async listModels(options: ModelListOptions = {}): Promise<ModelListResult> {
    await this.start();
    const models: unknown[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await this.peer.request<ModelListResponse>("model/list", {
        includeHidden: options.includeHidden === true,
        cursor: cursor ?? null,
      });
      models.push(...(response.data ?? []));
      cursor = response.nextCursor ?? null;
    } while (cursor);
    return { models: models.map(normalizeModelOption) };
  }

  async close(): Promise<void> {
    await this.peer.close();
  }

  private handleNotification(message: JsonRpcMessage): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (threadId) {
      this.sessions.get(threadId)?.handleNotification(message);
      return;
    }

    for (const session of this.sessions.values()) {
      if (session.handleNotification(message)) {
        return;
      }
    }
  }
}

function normalizeModelOption(value: unknown): ModelListResult["models"][number] {
  const record = isRecord(value) ? value : {};
  return {
    id: stringValue(record.id),
    model: stringValue(record.model),
    displayName: stringValue(record.displayName),
    description: stringValue(record.description),
    hidden: record.hidden === true,
    supportedReasoningEfforts: Array.isArray(record.supportedReasoningEfforts)
      ? record.supportedReasoningEfforts.map(normalizeReasoningEffortOption)
      : [],
    defaultReasoningEffort: reasoningEffortValue(record.defaultReasoningEffort),
    additionalSpeedTiers: Array.isArray(record.additionalSpeedTiers)
      ? record.additionalSpeedTiers.map(String)
      : [],
    serviceTiers: Array.isArray(record.serviceTiers)
      ? record.serviceTiers.map(normalizeServiceTier)
      : [],
    isDefault: record.isDefault === true,
  };
}

function normalizeReasoningEffortOption(value: unknown): ModelListResult["models"][number]["supportedReasoningEfforts"][number] {
  const record = isRecord(value) ? value : {};
  return {
    reasoningEffort: reasoningEffortValue(record.reasoningEffort),
    description: stringValue(record.description),
  };
}

function normalizeServiceTier(value: unknown): ModelListResult["models"][number]["serviceTiers"][number] {
  const record = isRecord(value) ? value : {};
  return {
    id: stringValue(record.id),
    name: stringValue(record.name),
    description: stringValue(record.description),
  };
}

function reasoningEffortValue(value: unknown): ModelListResult["models"][number]["defaultReasoningEffort"] {
  return isReasoningEffort(value) ? value : "medium";
}

function isReasoningEffort(value: unknown): value is ModelListResult["models"][number]["defaultReasoningEffort"] {
  return value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
