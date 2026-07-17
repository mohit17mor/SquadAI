import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createDefaultClientFactory } from "./codexControlFactory.js";
import { GitWorkspaceManager } from "./gitWorkspace.js";
import { exportUserSkill, installUserSkill, isPortableUserSkill } from "./skillPackages.js";
import type {
  AgentDefinition,
  ApprovalRequest,
  ApprovalResponse,
  CodexControlClientFactory,
  CodexControlClientLike,
  CodexSessionLike,
  RunnerCommand,
  RunnerCommandCompletion,
  RunnerCommandEvent,
  RunnerRegistration,
} from "./types.js";

export type RunnerDaemonOptions = {
  controlUrl: string;
  token: string;
  id: string;
  name?: string;
  sshHost?: string;
  version?: string;
  clientFactory?: CodexControlClientFactory;
  fetch?: typeof fetch;
};

export class RunnerDaemon {
  private readonly instanceId = randomUUID();
  private readonly fetchImpl: typeof fetch;
  private readonly clientFactory: CodexControlClientFactory;
  private readonly workspaceManager = new GitWorkspaceManager();
  private readonly clients = new Map<string, CodexControlClientLike>();
  private readonly sessions = new Map<string, CodexSessionLike>();
  private readonly activeCommandByAgent = new Map<string, string>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollAbort: AbortController | null = null;
  private running = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: RunnerDaemonOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.clientFactory = options.clientFactory ?? createDefaultClientFactory();
  }

  get registration(): RunnerRegistration {
    return {
      id: this.options.id,
      instanceId: this.instanceId,
      name: this.options.name?.trim() || this.options.id,
      hostname: hostname(),
      ...(this.options.sshHost?.trim() ? { sshHost: this.options.sshHost.trim() } : {}),
      platform: process.platform,
      arch: process.arch,
      version: this.options.version ?? "0.1.0",
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.post("/api/runners/register", this.registration);
    this.heartbeatTimer = setInterval(() => {
      void this.post(`/api/runners/${encodeURIComponent(this.options.id)}/heartbeat`, {}).catch(() => {});
    }, 10_000);
    await this.pollLoop();
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();
    this.pollAbort = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;

    const activeSessions = Array.from(this.activeCommandByAgent.keys())
      .map((agentId) => this.sessions.get(agentId))
      .filter((session): session is CodexSessionLike => Boolean(session?.interrupt));
    await Promise.all(activeSessions.map((session) => withTimeout(
      session.interrupt!().catch(() => {}),
      2_000,
    )));
    await Promise.all(Array.from(this.clients.values()).map((client) => client.close().catch(() => {})));
    this.clients.clear();
    this.sessions.clear();
    this.activeCommandByAgent.clear();
    await this.post(`/api/runners/${encodeURIComponent(this.options.id)}/disconnect`, {}).catch(() => {});
  }

  private async pollLoop(): Promise<void> {
    let retryMs = 500;
    while (this.running) {
      try {
        this.pollAbort = new AbortController();
        const response = await this.post(
          `/api/runners/${encodeURIComponent(this.options.id)}/poll`,
          { timeoutMs: 25_000 },
          this.pollAbort.signal,
        ) as { command?: RunnerCommand | null };
        this.pollAbort = null;
        retryMs = 500;
        if (response.command) void this.runCommand(response.command);
      } catch (error) {
        if (!this.running) return;
        console.error(`Runner poll failed: ${error instanceof Error ? error.message : String(error)}`);
        await delay(retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
        await this.post("/api/runners/register", this.registration).catch(() => {});
      }
    }
  }

  private async runCommand(command: RunnerCommand): Promise<void> {
    let completion: RunnerCommandCompletion;
    try {
      const value = await this.execute(command);
      completion = { ok: true, value: value ?? null };
    } catch (error) {
      completion = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    await this.post(
      `/api/runners/${encodeURIComponent(this.options.id)}/commands/${encodeURIComponent(command.id)}/complete`,
      completion,
    ).catch((error) => {
      console.error(`Could not report command completion: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async execute(command: RunnerCommand): Promise<unknown> {
    const payload = command.payload;
    switch (command.type) {
      case "client.close": {
        const client = this.clients.get(command.agentId);
        if (client) await client.close();
        this.clients.delete(command.agentId);
        this.sessions.delete(command.agentId);
        return { closed: true };
      }
      case "models.list": {
        const client = this.client(command.agentId);
        return client.listModels ? client.listModels(asRecord(payload.options)) : { models: [] };
      }
      case "runtime.info": {
        const client = this.client(command.agentId);
        return client.getRuntimeInfo
          ? client.getRuntimeInfo()
          : { userAgent: "", platformFamily: process.platform, platformOs: process.platform, codexHome: "" };
      }
      case "skills.list": {
        const client = this.client(command.agentId);
        if (!client.listSkills) throw new Error("This runner does not support skill discovery.");
        const options = asRecord(payload.options);
        return client.listSkills({
          cwd: requiredString(options.cwd, "cwd"),
          ...(typeof options.forceReload === "boolean" ? { forceReload: options.forceReload } : {}),
        });
      }
      case "skills.listUser": {
        const client = this.client(command.agentId);
        if (!client.listSkills) throw new Error("This runner does not support skill discovery.");
        const catalog = await client.listSkills({ cwd: homedir(), forceReload: true });
        return { ...catalog, skills: catalog.skills.filter((skill) => skill.scope === "user" && isPortableUserSkill(skill)) };
      }
      case "skills.export":
        return exportUserSkill(
          requiredString(payload.path, "path"),
          {
            name: requiredString(payload.name, "name"),
            ...(typeof payload.description === "string" ? { description: payload.description } : {}),
          },
        );
      case "skills.install":
        return installUserSkill(payload.package);
      case "filesystem.listDirectories":
        return listDirectories(typeof payload.path === "string" ? payload.path : undefined);
      case "session.start": {
        const session = await this.client(command.agentId).startSession(asRecord(payload.options));
        this.setSession(command.agentId, session);
        return { threadId: session.threadId };
      }
      case "session.resume": {
        const session = await this.client(command.agentId).resumeSession(
          requiredString(payload.threadId, "threadId"),
          asRecord(payload.options),
        );
        this.setSession(command.agentId, session);
        return { threadId: session.threadId };
      }
      case "session.ask": {
        const session = this.requireSession(command.agentId);
        this.activeCommandByAgent.set(command.agentId, command.id);
        try {
          return await session.ask(requiredString(payload.input, "input"), asRecord(payload.options));
        } finally {
          this.activeCommandByAgent.delete(command.agentId);
        }
      }
      case "session.interrupt": {
        const session = this.requireSession(command.agentId);
        if (!session.interrupt) throw new Error(`Agent ${command.agentId} does not support interruption.`);
        const activeCommandId = this.activeCommandByAgent.get(command.agentId);
        const interruptSettled = await settleWithin(session.interrupt(), 2_000);
        if (activeCommandId) {
          await waitUntil(
            () => this.activeCommandByAgent.get(command.agentId) !== activeCommandId,
            1_500,
          );
        }
        const forced = !interruptSettled || Boolean(
          activeCommandId && this.activeCommandByAgent.get(command.agentId) === activeCommandId,
        );
        if (forced) {
          const client = this.clients.get(command.agentId);
          if (client) await client.close().catch(() => {});
          this.clients.delete(command.agentId);
          this.sessions.delete(command.agentId);
        }
        return { interrupted: true, forced };
      }
      case "workspace.prepareBase": {
        const definition = asDefinition(payload.definition);
        await assertDirectory(definition.cwd);
        return this.workspaceManager.prepareBase(definition);
      }
      case "workspace.prepareInstance": {
        const base = asDefinition(payload.base);
        const instance = asDefinition(payload.instance);
        await assertDirectory(base.cwd);
        return this.workspaceManager.prepareInstance(base, instance);
      }
      case "workspace.inspect":
        return this.workspaceManager.inspect(asDefinition(payload.definition));
      case "workspace.cleanup":
        return this.workspaceManager.cleanup(asDefinition(payload.definition));
    }
  }

  private client(agentId: string): CodexControlClientLike {
    let client = this.clients.get(agentId);
    if (!client) {
      client = this.clientFactory({
        agentId,
        approvalHandler: (request) => this.forwardApproval(agentId, request),
      });
      this.clients.set(agentId, client);
    }
    return client;
  }

  private setSession(agentId: string, session: CodexSessionLike): void {
    this.sessions.set(agentId, session);
    if (!session.on) return;
    for (const name of ["item.started", "item.completed", "turn.retrying", "thread.compacted"]) {
      session.on(name, (...args) => {
        const commandId = this.activeCommandByAgent.get(agentId);
        if (!commandId) return;
        void this.forwardEvent(commandId, { kind: "session", name, args }).catch(() => {});
      });
    }
  }

  private requireSession(agentId: string): CodexSessionLike {
    const session = this.sessions.get(agentId);
    if (!session) throw new Error(`Runner has no active session for agent ${agentId}.`);
    return session;
  }

  private async forwardApproval(agentId: string, request: ApprovalRequest): Promise<ApprovalResponse> {
    const commandId = this.activeCommandByAgent.get(agentId);
    if (!commandId) return { decision: "declined", reason: "No active control-plane command." };
    return await this.forwardEvent(commandId, { kind: "approval", request }) as ApprovalResponse;
  }

  private forwardEvent(commandId: string, event: RunnerCommandEvent): Promise<unknown> {
    return this.post(
      `/api/runners/${encodeURIComponent(this.options.id)}/commands/${encodeURIComponent(commandId)}/events`,
      event,
    );
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, ensureTrailingSlash(this.options.controlUrl)), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `HTTP ${response.status}`);
    return result;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  return settleWithin(promise, milliseconds).then(() => undefined);
}

function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    }, () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asDefinition(value: unknown): AgentDefinition {
  const record = asRecord(value);
  return record as AgentDefinition;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Runner command field ${name} is required.`);
  return value;
}

async function assertDirectory(path: string): Promise<void> {
  try {
    const details = await stat(path);
    if (!details.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Runner working directory does not exist or is not a directory: ${path} (${details})`);
  }
}

async function listDirectories(requestedPath?: string) {
  const homePath = await realpath(homedir());
  const candidate = requestedPath?.trim()
    ? expandHomePath(requestedPath.trim(), homePath)
    : homePath;
  const path = await realpath(resolve(candidate));
  await assertDirectory(path);
  const entries = await readdir(path, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  const parent = dirname(path);
  return {
    path,
    parentPath: parent === path ? null : parent,
    homePath,
    directories,
  };
}

export function expandHomePath(path: string, homePath: string): string {
  if (path === "~") return homePath;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homePath, path.slice(2));
  return path;
}
