import { EventEmitter } from "node:events";
import { randomUUID, timingSafeEqual } from "node:crypto";

import type {
  AgentDefinition,
  AgentModelCatalog,
  AgentSkillCatalog,
  AgentWorkspaceManager,
  AgentWorkspaceStatus,
  ApprovalHandler,
  CodexControlClientContext,
  CodexControlClientFactory,
  CodexControlClientLike,
  CodexRuntimeInfo,
  CodexSessionLike,
  RunnerCommand,
  RunnerCommandCompletion,
  RunnerCommandEvent,
  RunnerCommandType,
  RunnerRegistration,
  RunnerSnapshot,
} from "./types.js";

const RUNNER_OFFLINE_AFTER_MS = 30_000;
const COMMAND_TIMEOUT_MS = 1_900_000;

type RunnerRecord = RunnerRegistration & {
  connectedAt: string;
  lastSeenAt: string;
  queue: RunnerCommand[];
  waiter: ((command: RunnerCommand | null) => void) | null;
  activeCommands: Set<string>;
};

type PendingCommand = {
  runnerId: string;
  command: RunnerCommand;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  session?: RemoteSession;
  approvalHandler?: ApprovalHandler;
};

export class RunnerHub extends EventEmitter {
  private readonly runners = new Map<string, RunnerRecord>();
  private readonly pending = new Map<string, PendingCommand>();

  constructor(
    private readonly token: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    super();
  }

  authenticate(candidate: string | undefined): boolean {
    if (!this.token) return true;
    if (!candidate) return false;
    const expected = Buffer.from(this.token);
    const received = Buffer.from(candidate);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  register(input: RunnerRegistration): RunnerSnapshot {
    validateRunnerRegistration(input);
    const now = this.clock().toISOString();
    const existing = this.runners.get(input.id);
    const record: RunnerRecord = {
      ...input,
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
      queue: existing?.queue ?? [],
      waiter: existing?.waiter ?? null,
      activeCommands: existing?.activeCommands ?? new Set(),
    };
    this.runners.set(input.id, record);
    this.emit("changed", this.snapshot(record));
    return this.snapshot(record);
  }

  heartbeat(runnerId: string): RunnerSnapshot {
    const record = this.requireRunner(runnerId);
    record.lastSeenAt = this.clock().toISOString();
    this.emit("changed", this.snapshot(record));
    return this.snapshot(record);
  }

  listRunners(): RunnerSnapshot[] {
    return Array.from(this.runners.values()).map((record) => this.snapshot(record));
  }

  getRunner(runnerId: string): RunnerSnapshot {
    return this.snapshot(this.requireRunner(runnerId));
  }

  async poll(runnerId: string, timeoutMs = 25_000, signal?: AbortSignal): Promise<RunnerCommand | null> {
    const record = this.requireRunner(runnerId);
    if (signal?.aborted) return null;
    record.lastSeenAt = this.clock().toISOString();
    const queued = record.queue.shift();
    if (queued) {
      record.activeCommands.add(queued.id);
      this.emit("changed", this.snapshot(record));
      return queued;
    }
    if (record.waiter) {
      throw new Error(`Runner ${runnerId} already has an active poll.`);
    }
    return new Promise<RunnerCommand | null>((resolve) => {
      const timer = setTimeout(() => {
        if (record.waiter === finish) record.waiter = null;
        signal?.removeEventListener("abort", abort);
        resolve(null);
      }, Math.max(100, Math.min(timeoutMs, 30_000)));
      const finish = (command: RunnerCommand | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        record.waiter = null;
        if (command) record.activeCommands.add(command.id);
        this.emit("changed", this.snapshot(record));
        resolve(command);
      };
      const abort = () => finish(null);
      signal?.addEventListener("abort", abort, { once: true });
      record.waiter = finish;
    });
  }

  async reportEvent(
    runnerId: string,
    commandId: string,
    event: RunnerCommandEvent,
  ): Promise<unknown> {
    const pending = this.requirePending(runnerId, commandId);
    this.touch(runnerId);
    if (event.kind === "session") {
      pending.session?.emit(event.name, ...event.args);
      return { received: true };
    }
    if (!pending.approvalHandler) {
      return { decision: "declined", reason: "The control plane has no approval handler for this command." };
    }
    return pending.approvalHandler(event.request);
  }

  complete(runnerId: string, commandId: string, completion: RunnerCommandCompletion): void {
    const pending = this.requirePending(runnerId, commandId);
    this.pending.delete(commandId);
    clearTimeout(pending.timer);
    const runner = this.requireRunner(runnerId);
    runner.activeCommands.delete(commandId);
    runner.lastSeenAt = this.clock().toISOString();
    this.emit("changed", this.snapshot(runner));
    if (completion.ok) {
      pending.resolve(completion.value);
    } else {
      pending.reject(new Error(completion.error));
    }
  }

  createClientFactory(localFactory: CodexControlClientFactory): CodexControlClientFactory {
    return (context?: CodexControlClientContext) => {
      const runnerId = context?.runnerId;
      if (!runnerId || runnerId === "local") return localFactory(context);
      return new RemoteCodexClient(this, runnerId, context);
    };
  }

  async execute(
    runnerId: string,
    type: RunnerCommandType,
    agentId: string,
    payload: Record<string, unknown> = {},
    options: { session?: RemoteSession; approvalHandler?: ApprovalHandler; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const runner = this.requireOnlineRunner(runnerId);
    const command: RunnerCommand = {
      id: `command-${randomUUID()}`,
      type,
      agentId,
      payload,
      createdAt: this.clock().toISOString(),
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        runner.activeCommands.delete(command.id);
        const queuedIndex = runner.queue.findIndex((queued) => queued.id === command.id);
        if (queuedIndex >= 0) runner.queue.splice(queuedIndex, 1);
        this.emit("changed", this.snapshot(runner));
        reject(new Error(`Runner command timed out: ${type} on ${runnerId}`));
      }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
      this.pending.set(command.id, {
        runnerId,
        command,
        resolve,
        reject,
        timer,
        ...(options.session ? { session: options.session } : {}),
        ...(options.approvalHandler ? { approvalHandler: options.approvalHandler } : {}),
      });
      if (runner.waiter) {
        const waiter = runner.waiter;
        runner.waiter = null;
        waiter(command);
      } else {
        runner.queue.push(command);
      }
      this.emit("changed", this.snapshot(runner));
    });
  }

  private snapshot(record: RunnerRecord): RunnerSnapshot {
    const online = this.clock().getTime() - Date.parse(record.lastSeenAt) <= RUNNER_OFFLINE_AFTER_MS;
    return {
      id: record.id,
      name: record.name,
      status: online ? "online" : "offline",
      hostname: record.hostname,
      platform: record.platform,
      arch: record.arch,
      version: record.version,
      activeCommands: record.activeCommands.size,
      connectedAt: record.connectedAt,
      lastSeenAt: record.lastSeenAt,
    };
  }

  private touch(runnerId: string): void {
    this.requireRunner(runnerId).lastSeenAt = this.clock().toISOString();
  }

  private requireRunner(runnerId: string): RunnerRecord {
    const record = this.runners.get(runnerId);
    if (!record) throw new Error(`Unknown runner: ${runnerId}`);
    return record;
  }

  private requireOnlineRunner(runnerId: string): RunnerRecord {
    const record = this.requireRunner(runnerId);
    if (this.snapshot(record).status !== "online") throw new Error(`Runner ${runnerId} is offline.`);
    return record;
  }

  private requirePending(runnerId: string, commandId: string): PendingCommand {
    const pending = this.pending.get(commandId);
    if (!pending || pending.runnerId !== runnerId) {
      throw new Error(`Unknown runner command: ${commandId}`);
    }
    return pending;
  }
}

export class RunnerAwareWorkspaceManager implements AgentWorkspaceManager {
  constructor(
    private readonly hub: RunnerHub,
    private readonly local: AgentWorkspaceManager,
  ) {}

  prepareBase(definition: AgentDefinition): Promise<AgentDefinition> {
    return this.callDefinition(definition, "workspace.prepareBase", { definition }, () => this.local.prepareBase(definition));
  }

  prepareInstance(base: AgentDefinition, instance: AgentDefinition): Promise<AgentDefinition> {
    const runnerId = effectiveRunnerId(instance);
    if (runnerId === "local") return this.local.prepareInstance(base, instance);
    return this.hub.execute(runnerId, "workspace.prepareInstance", instance.id, { base, instance }) as Promise<AgentDefinition>;
  }

  inspect(definition: AgentDefinition): Promise<AgentWorkspaceStatus | null> {
    return this.callDefinition(definition, "workspace.inspect", { definition }, () => this.local.inspect(definition));
  }

  cleanup(definition: AgentDefinition): Promise<AgentDefinition> {
    return this.callDefinition(definition, "workspace.cleanup", { definition }, () => this.local.cleanup(definition));
  }

  private callDefinition<T>(
    definition: AgentDefinition,
    type: RunnerCommandType,
    payload: Record<string, unknown>,
    local: () => Promise<T>,
  ): Promise<T> {
    const runnerId = effectiveRunnerId(definition);
    if (runnerId === "local") return local();
    return this.hub.execute(runnerId, type, definition.id, payload) as Promise<T>;
  }
}

class RemoteCodexClient implements CodexControlClientLike {
  constructor(
    private readonly hub: RunnerHub,
    private readonly runnerId: string,
    private readonly context?: CodexControlClientContext,
  ) {}

  async startSession(options: Record<string, unknown>): Promise<CodexSessionLike> {
    const result = asRecord(await this.hub.execute(this.runnerId, "session.start", this.agentId, { options }));
    return new RemoteSession(this.hub, this.runnerId, this.agentId, String(result.threadId), this.context?.approvalHandler);
  }

  async resumeSession(threadId: string, options?: Record<string, unknown>): Promise<CodexSessionLike> {
    const result = asRecord(await this.hub.execute(this.runnerId, "session.resume", this.agentId, {
      threadId,
      options: options ?? {},
    }));
    return new RemoteSession(this.hub, this.runnerId, this.agentId, String(result.threadId), this.context?.approvalHandler);
  }

  async listModels(options?: { includeHidden?: boolean }): Promise<AgentModelCatalog> {
    return await this.hub.execute(this.runnerId, "models.list", this.agentId, { options: options ?? {} }) as AgentModelCatalog;
  }

  async listSkills(options: { cwd: string; forceReload?: boolean }): Promise<AgentSkillCatalog> {
    return await this.hub.execute(this.runnerId, "skills.list", this.agentId, { options }) as AgentSkillCatalog;
  }

  async getRuntimeInfo(): Promise<CodexRuntimeInfo> {
    return await this.hub.execute(this.runnerId, "runtime.info", this.agentId) as CodexRuntimeInfo;
  }

  async close(): Promise<void> {
    await this.hub.execute(this.runnerId, "client.close", this.agentId).catch(() => {});
  }

  private get agentId(): string {
    return this.context?.agentId ?? "runtime-catalog";
  }
}

export class RemoteSession extends EventEmitter implements CodexSessionLike {
  constructor(
    private readonly hub: RunnerHub,
    private readonly runnerId: string,
    private readonly agentId: string,
    readonly threadId: string,
    private readonly approvalHandler?: ApprovalHandler,
  ) {
    super();
  }

  async ask(input: string, options: Record<string, unknown>) {
    return await this.hub.execute(
      this.runnerId,
      "session.ask",
      this.agentId,
      { input, options },
      {
        session: this,
        ...(this.approvalHandler ? { approvalHandler: this.approvalHandler } : {}),
      },
    ) as { finalText: string; threadId: string; turn: Record<string, unknown> };
  }

  async interrupt(): Promise<void> {
    await this.hub.execute(this.runnerId, "session.interrupt", this.agentId, { threadId: this.threadId });
  }
}

function effectiveRunnerId(definition: AgentDefinition): string {
  return definition.runnerId?.trim() || "local";
}

function validateRunnerRegistration(input: RunnerRegistration): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(input.id)) throw new Error(`Invalid runner id: ${input.id}`);
  if (!input.name.trim()) throw new Error("Runner name is required.");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runner returned an invalid response.");
  }
  return value as Record<string, unknown>;
}
