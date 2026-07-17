import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import type { CodexAgentManager } from "./manager.js";
import type { SkillLibraryService } from "./skillLibrary.js";
import type { SqliteRunnerEnrollmentStore } from "./runnerEnrollment.js";
import type { RunnerHub } from "./runnerHub.js";
import type { TelegramAgentBindingService } from "./telegramBindings.js";
import type { TelegramMentionIntake } from "./telegramRequests.js";
import { TailscaleSetupError, type TailscalePrivateAccess } from "./tailscale.js";
import type {
  AgentDefinition,
  AgentDefinitionUpdate,
  AgentEvent,
  AgentSkillReference,
  ApprovalScope,
  AskOptions,
  CompatibilityApprovalResolution,
  ReasoningEffort,
  SensorEventInput,
  RunnerCommandCompletion,
  RunnerCommandEvent,
  RunnerDirectoryListing,
  RunnerRegistration,
  RunnerSnapshot,
} from "./types.js";

const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

const execFileAsync = promisify(execFile);

export type CommandCenterServerOptions = {
  manager: CodexAgentManager;
  runnerHub?: RunnerHub;
  runnerEnrollments?: SqliteRunnerEnrollmentStore;
  tailscale?: {
    ensurePrivateAccess(localPort: number): Promise<TailscalePrivateAccess>;
  };
  skillLibrary?: SkillLibraryService;
  telegramBindings?: TelegramAgentBindingService;
  telegramMentionIntake?: TelegramMentionIntake;
  title?: string;
  directoryPicker?: (initialPath: string) => Promise<string | null>;
  workspaceOpener?: (workspacePath: string) => Promise<void>;
  automation?: {
    enabled?: boolean;
    routerAgentId?: string;
  };
};

export class CommandCenterServer {
  private readonly server: http.Server;
  private readonly sseClients = new Set<ServerResponse>();
  private readonly title: string;
  private automationRunning = false;
  private automationQueued = false;
  private runnerSweepTimer: NodeJS.Timeout | null = null;
  private readonly runnerPollAborts = new Set<AbortController>();
  private readonly runnerChanged = (runner: RunnerSnapshot): void => {
    this.broadcast("runner-event", runner);
  };

  constructor(private readonly options: CommandCenterServerOptions) {
    this.title = options.title ?? "SquadAI";
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    options.manager.on("event", (event) => {
      this.broadcast("agent-event", event as AgentEvent);
      if (![
        "sensor_event_ingested",
        "work_item_created",
        "sensor_event_routed",
      ].includes((event as AgentEvent).type)) {
        this.kickAutomation();
      }
    });
    options.runnerHub?.on("changed", this.runnerChanged);
  }

  get port(): number {
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  async listen(port: number, host = "127.0.0.1"): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    if (this.options.runnerHub && !this.runnerSweepTimer) {
      this.runnerSweepTimer = setInterval(() => {
        this.options.runnerHub?.listRunners();
      }, 10_000);
      this.runnerSweepTimer.unref();
    }
  }

  async close(): Promise<void> {
    this.options.runnerHub?.off("changed", this.runnerChanged);
    if (this.runnerSweepTimer) clearInterval(this.runnerSweepTimer);
    this.runnerSweepTimer = null;
    for (const abort of this.runnerPollAborts) abort.abort();
    this.runnerPollAborts.clear();
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      this.server.closeAllConnections();
    });
  }

  address(): AddressInfo | string | null {
    return this.server.address();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        this.html(response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/assets/topology.js") {
        await this.javascript(response, new URL("./ui/topology.js", import.meta.url));
        return;
      }

      if (request.method === "GET" && url.pathname === "/vendor/three.module.js") {
        await this.javascript(
          response,
          new URL("../../node_modules/three/build/three.module.min.js", import.meta.url),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/vendor/three.core.min.js") {
        await this.javascript(
          response,
          new URL("../../node_modules/three/build/three.core.min.js", import.meta.url),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/agents") {
        this.json(response, { agents: this.options.manager.listAgents() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/runners") {
        this.json(response, { runners: this.options.runnerHub?.listRunners() ?? [] });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/runner-enrollments") {
        const body = asRecord(await readJson(request));
        const suppliedControlUrl = optionalString(body.controlUrl);
        const privateAccess = suppliedControlUrl
          ? null
          : await this.requireTailscale().ensurePrivateAccess(this.port);
        const enrollment = this.requireRunnerEnrollments().create(
          suppliedControlUrl ?? privateAccess!.controlUrl,
        );
        this.json(response, {
          ...enrollment,
          connection: suppliedControlUrl ? "manual" : "tailscale",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/runner-enrollments/exchange") {
        const body = asRecord(await readJson(request));
        const credential = this.requireRunnerEnrollments().exchange(
          requiredString(body.code, "code"),
          parseRunnerRegistration(body.runner),
        );
        this.json(response, credential);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/telegram/agent-bindings") {
        this.json(response, {
          bindings: this.requireTelegramBindings().listBindings(),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/telegram/requests") {
        this.json(response, {
          requests: this.requireTelegramMentionIntake().listRequests(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/telegram/agent-bindings") {
        const body = asRecord(await readJson(request));
        const binding = await this.requireTelegramBindings().bindAgent(
          requiredString(body.agentId, "agentId"),
          requiredString(body.token, "token"),
          optionalEnum(body.executionPolicy, ["reuse", "new"]) ?? "reuse",
        );
        this.json(response, { binding });
        return;
      }

      const telegramBindingMatch = url.pathname.match(/^\/api\/telegram\/agent-bindings\/([^/]+)$/);
      if (request.method === "PATCH" && telegramBindingMatch?.[1]) {
        const body = asRecord(await readJson(request));
        const binding = this.requireTelegramBindings().updateExecutionPolicy(
          decodeURIComponent(telegramBindingMatch[1]),
          requiredEnum(body.executionPolicy, ["reuse", "new"], "executionPolicy"),
        );
        this.json(response, { binding });
        return;
      }
      if (request.method === "DELETE" && telegramBindingMatch?.[1]) {
        const removed = await this.requireTelegramBindings().removeBinding(
          decodeURIComponent(telegramBindingMatch[1]),
        );
        this.json(response, { removed });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/runners/register") {
        const registration = parseRunnerRegistration(await readJson(request));
        const hub = this.requireRunnerHub(request, registration.id);
        const runner = hub.register(registration);
        this.json(response, { runner });
        return;
      }

      const runnerHeartbeatMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/heartbeat$/);
      if (request.method === "POST" && runnerHeartbeatMatch?.[1]) {
        const runnerId = decodeURIComponent(runnerHeartbeatMatch[1]);
        const hub = this.requireRunnerHub(request, runnerId);
        const runner = hub.heartbeat(runnerId);
        this.json(response, { runner });
        return;
      }

      const runnerDisconnectMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/disconnect$/);
      if (request.method === "POST" && runnerDisconnectMatch?.[1]) {
        const runnerId = decodeURIComponent(runnerDisconnectMatch[1]);
        const hub = this.requireRunnerHub(request, runnerId);
        const runner = hub.disconnect(runnerId);
        this.json(response, { runner });
        return;
      }

      const runnerPollMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/poll$/);
      if (request.method === "POST" && runnerPollMatch?.[1]) {
        const runnerId = decodeURIComponent(runnerPollMatch[1]);
        const hub = this.requireRunnerHub(request, runnerId);
        const body = asRecord(await readJson(request));
        const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : 25_000;
        const abort = new AbortController();
        this.runnerPollAborts.add(abort);
        request.once("aborted", () => abort.abort());
        try {
          const command = await hub.poll(runnerId, timeoutMs, abort.signal);
          this.json(response, { command });
        } finally {
          this.runnerPollAborts.delete(abort);
        }
        return;
      }

      const runnerCommandEventMatch = url.pathname.match(
        /^\/api\/runners\/([^/]+)\/commands\/([^/]+)\/events$/,
      );
      if (request.method === "POST" && runnerCommandEventMatch?.[1] && runnerCommandEventMatch[2]) {
        const runnerId = decodeURIComponent(runnerCommandEventMatch[1]);
        const hub = this.requireRunnerHub(request, runnerId);
        const result = await hub.reportEvent(
          runnerId,
          decodeURIComponent(runnerCommandEventMatch[2]),
          await readJson(request) as RunnerCommandEvent,
        );
        this.json(response, result);
        return;
      }

      const runnerCommandCompleteMatch = url.pathname.match(
        /^\/api\/runners\/([^/]+)\/commands\/([^/]+)\/complete$/,
      );
      if (request.method === "POST" && runnerCommandCompleteMatch?.[1] && runnerCommandCompleteMatch[2]) {
        const runnerId = decodeURIComponent(runnerCommandCompleteMatch[1]);
        const hub = this.requireRunnerHub(request, runnerId);
        hub.complete(
          runnerId,
          decodeURIComponent(runnerCommandCompleteMatch[2]),
          await readJson(request) as RunnerCommandCompletion,
        );
        this.json(response, { completed: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/model-options") {
        const includeHidden = url.searchParams.get("includeHidden") === "true";
        const runnerId = url.searchParams.get("runnerId")?.trim();
        this.json(response, await this.options.manager.listModelOptions({
          includeHidden,
          ...(runnerId ? { runnerId } : {}),
        }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/skill-options") {
        const cwd = url.searchParams.get("cwd")?.trim();
        if (!cwd) throw new Error("Query parameter cwd is required.");
        this.json(response, await this.options.manager.listSkillOptions(
          cwd,
          url.searchParams.get("forceReload") === "true",
          url.searchParams.get("runnerId")?.trim() || "local",
        ));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/directories/pick") {
        const body = asRecord(await readJson(request));
        const initialPath = optionalString(body.initialPath) ?? process.cwd();
        const selectedPath = await (this.options.directoryPicker ?? pickNativeDirectory)(initialPath);
        this.json(response, selectedPath ? { path: selectedPath } : { canceled: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/runner-directories") {
        const hub = this.options.runnerHub;
        if (!hub) throw new Error("Remote runners are not enabled on this control plane.");
        const runnerId = url.searchParams.get("runnerId")?.trim();
        if (!runnerId || runnerId === "local") throw new Error("A remote runnerId is required.");
        const path = url.searchParams.get("path")?.trim();
        const listing = await hub.execute(
          runnerId,
          "filesystem.listDirectories",
          "directory-browser",
          path ? { path } : {},
          { timeoutMs: 15_000 },
        ) as RunnerDirectoryListing;
        this.json(response, listing);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/agents") {
        const body = await readJson(request);
        const agent = await this.options.manager.createAgent(parseAgentDefinition(body));
        this.json(response, { agent });
        return;
      }

      const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch?.[1] && request.method === "PATCH") {
        const body = await readJson(request);
        const agent = await this.options.manager.updateAgent(
          decodeURIComponent(agentMatch[1]),
          parseAgentUpdate(body),
        );
        this.json(response, { agent });
        return;
      }

      if (agentMatch?.[1] && request.method === "DELETE") {
        const agent = await this.options.manager.deleteAgent(decodeURIComponent(agentMatch[1]));
        this.json(response, { agent });
        return;
      }

      const cancelMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch?.[1]) {
        const event = await this.options.manager.interruptAgentTurn(decodeURIComponent(cancelMatch[1]));
        this.json(response, { event });
        return;
      }

      const instanceResolveMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/instance\/resolve$/);
      if (request.method === "POST" && instanceResolveMatch?.[1]) {
        const body = asRecord(await readJson(request));
        const resolution = optionalEnum(body.resolution, ["done", "cancelled"]);
        if (!resolution) {
          throw new Error("Field resolution must be done or cancelled.");
        }
        const agent = await this.options.manager.resolveAgentInstance(
          decodeURIComponent(instanceResolveMatch[1]),
          resolution,
        );
        this.kickAutomation();
        this.json(response, { agent });
        return;
      }

      const workspaceMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/workspace$/);
      if (request.method === "GET" && workspaceMatch?.[1]) {
        const agentId = decodeURIComponent(workspaceMatch[1]);
        const workspace = await this.options.manager.inspectAgentWorkspace(agentId);
        this.json(response, { agentId, workspace });
        return;
      }
      if (request.method === "POST" && workspaceMatch?.[1]) {
        const agent = await this.options.manager.cleanupAgentWorkspace(
          decodeURIComponent(workspaceMatch[1]),
        );
        this.json(response, { agent });
        return;
      }

      const workspaceOpenMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/workspace\/open$/);
      if (request.method === "POST" && workspaceOpenMatch?.[1]) {
        const agentId = decodeURIComponent(workspaceOpenMatch[1]);
        const agent = this.options.manager.getAgent(agentId);
        const workspace = await this.options.manager.inspectAgentWorkspace(agentId);
        if (!workspace || workspace.removed) {
          throw new Error(`Agent ${agentId} does not have an available managed worktree.`);
        }
        const target = agent.runnerId === "local"
          ? workspace.worktreePath
          : remoteVisualStudioCodeUri(
              this.options.runnerHub?.getRunner(agent.runnerId).sshHost,
              workspace.worktreePath,
              agent.runnerId,
            );
        await (this.options.workspaceOpener ?? openWorkspaceInVisualStudioCode)(target);
        this.json(response, { agentId, workspace, target, opened: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/sensor-events") {
        this.json(response, { events: this.options.manager.listSensorEvents() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/routing") {
        this.json(response, { mode: this.options.manager.getRoutingMode() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sensor-events") {
        const body = await readJson(request);
        const event = await this.options.manager.ingestSensorEvent(parseSensorEvent(body));
        this.kickAutomation();
        this.json(response, { event });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/work-items") {
        this.json(response, { workItems: this.options.manager.listWorkItems() });
        return;
      }

      const sensorAssignMatch = url.pathname.match(/^\/api\/sensor-events\/([^/]+)\/assign$/);
      if (request.method === "POST" && sensorAssignMatch?.[1]) {
        const body = asRecord(await readJson(request));
        const result = await this.options.manager.assignSensorEvent(
          decodeURIComponent(sensorAssignMatch[1]),
          requiredString(body.targetAgentId, "targetAgentId"),
        );
        this.kickAutomation();
        this.json(response, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/notifications") {
        this.json(response, { notifications: this.options.manager.listNotifications() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/compatibility") {
        this.json(response, this.options.manager.getCompatibilityStatus());
        return;
      }

      const compatibilityMatch = url.pathname.match(/^\/api\/compatibility\/([^/]+)\/resolve$/);
      if (request.method === "POST" && compatibilityMatch?.[1]) {
        const body = await readJson(request);
        const approval = await this.options.manager.resolveCompatibilityApproval(
          decodeURIComponent(compatibilityMatch[1]),
          parseCompatibilityResolution(body),
        );
        this.kickAutomation();
        this.json(response, { approval });
        return;
      }

      const notificationDismissMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/dismiss$/);
      if (request.method === "POST" && notificationDismissMatch?.[1]) {
        const notification = await this.options.manager.dismissNotification(
          decodeURIComponent(notificationDismissMatch[1]),
        );
        this.json(response, { notification });
        return;
      }

      const workItemRetryMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)\/retry$/);
      if (request.method === "POST" && workItemRetryMatch?.[1]) {
        const workItem = await this.options.manager.retryWorkItem(
          decodeURIComponent(workItemRetryMatch[1]),
        );
        this.kickAutomation();
        this.json(response, { workItem });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/automation/tick") {
        const body = await readJson(request);
        const result = await this.options.manager.runAutomationCycle(parseRouterAgentId(body));
        this.json(response, { result });
        return;
      }

      const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
      if (request.method === "POST" && approvalMatch?.[1]) {
        const body = await readJson(request);
        const approval = await this.options.manager.resolveApproval(
          decodeURIComponent(approvalMatch[1]),
          ...parseApprovalResolution(body),
        );
        this.json(response, { approval });
        return;
      }

      const messageMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
      if (request.method === "POST" && messageMatch?.[1]) {
        const body = await readJson(request);
        const result = await this.options.manager.sendToAgent(
          decodeURIComponent(messageMatch[1]),
          parseMessage(body),
          parseAskOptions(body),
        );
        this.json(response, { result });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/events") {
        const agentId = url.searchParams.get("agentId") ?? undefined;
        const beforeIdValue = url.searchParams.get("beforeId");
        const limitValue = url.searchParams.get("limit");
        const beforeId = beforeIdValue ? Number(beforeIdValue) : undefined;
        const limit = limitValue ? Number(limitValue) : 500;
        this.json(response, this.options.manager.listEventPage({
          ...(agentId ? { agentId } : {}),
          ...(beforeId !== undefined && Number.isFinite(beforeId) ? { beforeId } : {}),
          limit: Number.isFinite(limit) ? limit : 500,
        }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/events/stream") {
        this.sse(response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/skill-library") {
        this.json(response, await this.requireSkillLibrary().snapshot());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/skill-library/import") {
        const body = asRecord(await readJson(request));
        const description = optionalString(body.description);
        const skill = await this.requireSkillLibrary().importSkill({
          runnerId: requiredString(body.runnerId, "runnerId"),
          name: requiredString(body.name, "name"),
          path: requiredString(body.path, "path"),
          ...(description ? { description } : {}),
        });
        this.json(response, { skill });
        return;
      }

      const skillInstallMatch = url.pathname.match(/^\/api\/skill-library\/([^/]+)\/install$/);
      if (request.method === "POST" && skillInstallMatch?.[1]) {
        const body = asRecord(await readJson(request));
        const installation = await this.requireSkillLibrary().installSkill(
          decodeURIComponent(skillInstallMatch[1]),
          requiredString(body.runnerId, "runnerId"),
        );
        this.json(response, { installation });
        return;
      }

      this.json(response, { error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof TailscaleSetupError) {
        this.json(response, {
          error: error.message,
          ...(error.approvalUrl ? { approvalUrl: error.approvalUrl } : {}),
        }, error.approvalUrl ? 409 : 400);
        return;
      }

      this.json(
        response,
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  }

  private html(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(renderHtml(this.title));
  }

  private requireRunnerHub(request: IncomingMessage, runnerId?: string): RunnerHub {
    const hub = this.options.runnerHub;
    if (!hub) throw new Error("Remote runners are not enabled on this control plane.");
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!hub.authenticate(token, runnerId)) throw new Error("Runner authentication failed.");
    return hub;
  }

  private requireRunnerEnrollments(): SqliteRunnerEnrollmentStore {
    const enrollments = this.options.runnerEnrollments;
    if (!enrollments) throw new Error("Runner enrollment is not configured.");
    return enrollments;
  }

  private requireTailscale(): {
    ensurePrivateAccess(localPort: number): Promise<TailscalePrivateAccess>;
  } {
    const tailscale = this.options.tailscale;
    if (!tailscale) throw new Error("Automatic Tailscale setup is not configured.");
    return tailscale;
  }

  private requireSkillLibrary(): SkillLibraryService {
    const library = this.options.skillLibrary;
    if (!library) throw new Error("The SquadAI skill library is not configured.");
    return library;
  }

  private requireTelegramBindings(): TelegramAgentBindingService {
    const bindings = this.options.telegramBindings;
    if (!bindings) throw new Error("Telegram agent bindings are not configured.");
    return bindings;
  }

  private requireTelegramMentionIntake(): TelegramMentionIntake {
    const intake = this.options.telegramMentionIntake;
    if (!intake) throw new Error("Telegram mention intake is not configured.");
    return intake;
  }

  private json(response: ServerResponse, body: unknown, status = 200): void {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(body));
  }

  private async javascript(response: ServerResponse, path: URL): Promise<void> {
    const source = await readFile(path, "utf8");
    response.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(source);
  }

  private sse(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    this.sseClients.add(response);
    response.on("close", () => {
      this.sseClients.delete(response);
    });
  }

  private broadcast(eventName: string, event: unknown): void {
    const data = `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      client.write(data);
    }
  }

  private kickAutomation(): void {
    if (this.options.automation?.enabled === false || this.automationRunning) {
      this.automationQueued = this.automationRunning;
      return;
    }
    this.automationRunning = true;
    void this.runAutomationLoop();
  }

  private async runAutomationLoop(): Promise<void> {
    try {
      do {
        this.automationQueued = false;
        await this.options.manager.runAutomationCycle(this.options.automation?.routerAgentId);
      } while (this.automationQueued);
    } catch {
      // Automation is opportunistic; explicit API calls expose errors to callers.
    } finally {
      this.automationRunning = false;
    }
  }
}

export function createCommandCenterServer(
  options: CommandCenterServerOptions,
): CommandCenterServer {
  return new CommandCenterServer(options);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseAgentDefinition(body: unknown): AgentDefinition {
  const value = asRecord(body);
  const name = requiredString(value.name, "name");
  const definition: AgentDefinition = {
    id: optionalString(value.id) ?? deriveAgentId(name),
    name,
    cwd: requiredString(value.cwd, "cwd"),
    instructions: requiredString(value.instructions, "instructions"),
  };
  const runnerId = optionalString(value.runnerId);
  if (runnerId) definition.runnerId = runnerId;
  const model = optionalString(value.model);
  const approvalPolicy = optionalEnum(value.approvalPolicy, [
    "untrusted",
    "on-failure",
    "on-request",
    "never",
  ]);
  const sandbox = optionalEnum(value.sandbox, [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]);
  const approvalsReviewer = optionalEnum(value.approvalsReviewer, ["user", "auto_review"]);
  const permissionMode = optionalEnum(value.permissionMode, ["ask", "auto-review", "full-access"]);
  const metadata = asOptionalRecord(value.metadata);
  const reasoningEffort = optionalEnum(value.reasoningEffort, REASONING_EFFORTS);
  const serviceTier = optionalString(value.serviceTier);
  const skillMode = optionalEnum(value.skillMode, ["all", "selected"]);
  const allowedSkills = parseSkillReferences(value.allowedSkills);
  if (model) {
    definition.model = model;
  }
  if (reasoningEffort) {
    definition.reasoningEffort = reasoningEffort;
  }
  if (serviceTier) {
    definition.serviceTier = serviceTier;
  }
  if (skillMode) definition.skillMode = skillMode;
  if (allowedSkills) definition.allowedSkills = allowedSkills;
  if (permissionMode) {
    Object.assign(definition, permissionSettingsForMode(permissionMode));
  } else if (approvalPolicy) {
    definition.approvalPolicy = approvalPolicy;
  }
  if (!permissionMode && approvalsReviewer) {
    definition.approvalsReviewer = approvalsReviewer;
  }
  if (!permissionMode && sandbox) {
    definition.sandbox = sandbox;
  }
  if (metadata) {
    definition.metadata = metadata;
  }
  return definition;
}

function parseCompatibilityResolution(body: unknown): CompatibilityApprovalResolution {
  const value = asRecord(body);
  const decision = optionalEnum(value.decision, ["approved", "declined"]);
  if (!decision) {
    throw new Error("Field decision must be approved or declined.");
  }
  if (decision === "declined") return { decision };
  const model = requiredString(value.model, "model");
  const reasoningEffort = optionalEnum(value.reasoningEffort, REASONING_EFFORTS);
  const serviceTier = optionalString(value.serviceTier);
  return {
    decision,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

function parseAgentUpdate(body: unknown): AgentDefinitionUpdate {
  const value = asRecord(body);
  const update: AgentDefinitionUpdate = {};
  const name = optionalString(value.name);
  const cwd = optionalString(value.cwd);
  const instructions = optionalString(value.instructions);
  const model = optionalString(value.model);
  const approvalPolicy = optionalEnum(value.approvalPolicy, [
    "untrusted",
    "on-failure",
    "on-request",
    "never",
  ]);
  const sandbox = optionalEnum(value.sandbox, [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]);
  const approvalsReviewer = optionalEnum(value.approvalsReviewer, ["user", "auto_review"]);
  const permissionMode = optionalEnum(value.permissionMode, ["ask", "auto-review", "full-access"]);
  const metadata = asOptionalRecord(value.metadata);
  const reasoningEffort = optionalEnum(value.reasoningEffort, REASONING_EFFORTS);
  const serviceTier = optionalString(value.serviceTier);
  const skillMode = optionalEnum(value.skillMode, ["all", "selected"]);
  const allowedSkills = parseSkillReferences(value.allowedSkills);
  const runnerId = optionalString(value.runnerId);
  if (name) {
    update.name = name;
  }
  if (cwd) {
    update.cwd = cwd;
  }
  if (instructions) {
    update.instructions = instructions;
  }
  if ("runnerId" in value) update.runnerId = runnerId;
  if ("model" in value) {
    update.model = model;
  }
  if ("reasoningEffort" in value) {
    update.reasoningEffort = reasoningEffort;
  }
  if ("serviceTier" in value) {
    update.serviceTier = serviceTier;
  }
  if ("skillMode" in value) update.skillMode = skillMode;
  if ("allowedSkills" in value) update.allowedSkills = allowedSkills ?? [];
  if (permissionMode) {
    Object.assign(update, permissionSettingsForMode(permissionMode));
  } else if (approvalPolicy) {
    update.approvalPolicy = approvalPolicy;
  }
  if (!permissionMode && approvalsReviewer) {
    update.approvalsReviewer = approvalsReviewer;
  }
  if (!permissionMode && sandbox) {
    update.sandbox = sandbox;
  }
  if (metadata) {
    update.metadata = metadata;
  }
  return update;
}

function parseRunnerRegistration(body: unknown): RunnerRegistration {
  const value = asRecord(body);
  const registration: RunnerRegistration = {
    id: requiredString(value.id, "id"),
    name: requiredString(value.name, "name"),
    hostname: requiredString(value.hostname, "hostname"),
    platform: requiredString(value.platform, "platform"),
    arch: requiredString(value.arch, "arch"),
    version: requiredString(value.version, "version"),
  };
  const instanceId = optionalString(value.instanceId);
  if (instanceId) registration.instanceId = instanceId;
  const sshHost = optionalString(value.sshHost);
  if (sshHost) registration.sshHost = sshHost;
  return registration;
}

function permissionSettingsForMode(mode: "ask" | "auto-review" | "full-access"): Pick<AgentDefinition, "approvalPolicy" | "approvalsReviewer" | "sandbox"> {
  if (mode === "full-access") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    };
  }
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: mode === "auto-review" ? "auto_review" : "user",
    sandbox: "workspace-write",
  };
}

function parseSkillReferences(value: unknown): AgentSkillReference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Field allowedSkills must be an array.");
  const seen = new Set<string>();
  return value.map((item) => {
    const record = asRecord(item);
    const name = requiredString(record.name, "allowedSkills.name");
    const scope = optionalEnum(record.scope, ["user", "repo", "system", "admin"]);
    if (!scope) throw new Error("Field allowedSkills.scope is invalid.");
    const key = `${scope}\u0000${name}`;
    if (seen.has(key)) throw new Error(`Duplicate skill selection ${scope}:${name}.`);
    seen.add(key);
    return { name, scope };
  });
}

function deriveAgentId(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!id) {
    throw new Error("Agent name must contain at least one letter or number.");
  }
  return id;
}

function parseMessage(body: unknown): string {
  const value = asRecord(body);
  return requiredString(value.message, "message");
}

function parseAskOptions(body: unknown): AskOptions {
  const value = asRecord(body);
  const options = asOptionalRecord(value.options) ?? {};
  const parsed: AskOptions = {};
  const timeoutMs = optionalNumber(options.timeoutMs);
  const externalWrites = optionalEnum(options.externalWrites, ["deny", "allow"]);
  const shellCommands = optionalEnum(options.shellCommands, ["deny", "allow"]);
  const fileWrites = optionalEnum(options.fileWrites, ["deny", "allow"]);
  const network = optionalEnum(options.network, ["deny", "allow"]);
  if (timeoutMs !== undefined) {
    parsed.timeoutMs = timeoutMs;
  }
  if (externalWrites) {
    parsed.externalWrites = externalWrites;
  }
  if (shellCommands) {
    parsed.shellCommands = shellCommands;
  }
  if (fileWrites) {
    parsed.fileWrites = fileWrites;
  }
  if (network) {
    parsed.network = network;
  }
  return parsed;
}

function parseApprovalResolution(
  body: unknown,
): ["approved" | "declined", string | undefined, ApprovalScope | undefined] {
  const value = asRecord(body);
  const decision = optionalEnum(value.decision, ["approved", "declined"]);
  if (!decision) {
    throw new Error("Field decision must be approved or declined.");
  }
  const scope = optionalEnum(value.scope, ["once", "session"]);
  return [decision, optionalString(value.reason), scope];
}

function parseSensorEvent(body: unknown): SensorEventInput {
  const value = asRecord(body);
  const event: SensorEventInput = {
    source: requiredString(value.source, "source"),
    type: requiredString(value.type, "type"),
    body: requiredString(value.body, "body"),
  };
  const title = optionalString(value.title);
  const url = optionalString(value.url);
  const dedupeKey = optionalString(value.dedupeKey);
  const targetAgentId = optionalString(value.targetAgentId);
  const executionPolicy = optionalEnum(value.executionPolicy, ["reuse", "new"]);
  const priority = optionalEnum(value.priority, ["low", "normal", "high"]);
  const metadata = asOptionalRecord(value.metadata);
  if (title) {
    event.title = title;
  }
  if (url) {
    event.url = url;
  }
  if (dedupeKey) {
    event.dedupeKey = dedupeKey;
  }
  if (targetAgentId) {
    event.targetAgentId = targetAgentId;
  }
  if (executionPolicy) {
    event.executionPolicy = executionPolicy;
  }
  if (priority) {
    event.priority = priority;
  }
  if (metadata) {
    event.metadata = metadata;
  }
  return event;
}

function parseRouterAgentId(body: unknown): string | undefined {
  const value = asRecord(body);
  return optionalString(value.routerAgentId);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asRecord(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Field ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Numeric option must be a finite number.");
  }
  return value;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Invalid enum value: ${String(value)}`);
  }
  return value as T;
}

function requiredEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const parsed = optionalEnum(value, allowed);
  if (!parsed) throw new Error(`Field ${field} is required.`);
  return parsed;
}

async function pickNativeDirectory(initialPath: string): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new Error("The native folder picker is currently available on macOS only.");
  }
  const requestedPath = isAbsolute(initialPath) ? initialPath : resolve(process.cwd(), initialPath);
  let defaultPath: string;
  try {
    defaultPath = await realpath(requestedPath);
  } catch {
    defaultPath = await realpath(process.cwd());
  }
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e", "on run argv",
      "-e", "set startPath to item 1 of argv",
      "-e", "set chosenFolder to choose folder with prompt \"Choose agent workspace\" default location (POSIX file startPath)",
      "-e", "return POSIX path of chosenFolder",
      "-e", "end run",
      defaultPath,
    ], { encoding: "utf8", timeout: 300_000 });
    const selectedPath = stdout.trim();
    return selectedPath ? resolve(selectedPath) : null;
  } catch (error) {
    const details = error instanceof Error
      ? `${error.message} ${String((error as Error & { stderr?: unknown }).stderr ?? "")}`
      : String(error);
    if (/user canceled|-128/i.test(details)) return null;
    throw new Error(`Could not open the native folder picker: ${details}`, { cause: error });
  }
}

async function openWorkspaceInVisualStudioCode(workspaceTarget: string): Promise<void> {
  const target = workspaceTarget.startsWith("vscode://")
    ? workspaceTarget
    : await realpath(workspaceTarget);
  try {
    if (process.platform === "darwin") {
      await execFileAsync("open", ["-a", "Visual Studio Code", target], {
        encoding: "utf8",
        timeout: 30_000,
      });
      return;
    }
    await execFileAsync("code", target.startsWith("vscode://")
      ? ["--new-window", "--folder-uri", target]
      : ["--new-window", target], {
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open the workspace in Visual Studio Code: ${details}`, { cause: error });
  }
}

function remoteVisualStudioCodeUri(sshHost: string | undefined, workspacePath: string, runnerId: string): string {
  if (!sshHost) {
    throw new Error(`Runner ${runnerId} is missing its SSH host. Restart it with --ssh-host <mac-ssh-host>.`);
  }
  const encodedPath = workspacePath.split("/").map(encodeURIComponent).join("/");
  return `vscode://vscode-remote/ssh-remote+${encodeURIComponent(sshHost)}${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}`;
}

function renderHtml(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${css()}</style>
</head>
<body>
  <main id="shell" class="shell topology-mode">
    <nav class="command-rail">
      <div class="brand">
        <div><h1>${escapeHtml(title)}</h1><span>Agent control plane</span></div>
      </div>
      <div class="rail-nav" aria-label="Command center sections">
        <span class="rail-section-label">Workspace</span>
        <button type="button" class="rail-item active" data-panel="topology">Topology</button>
        <button type="button" class="rail-item" data-panel="jarvis">Jarvis</button>
        <button type="button" class="rail-item" data-panel="agents">Agents <span id="agent-count">0</span></button>
        <div id="rail-agents" class="rail-agents" aria-label="Agent conversations"></div>
        <button type="button" class="rail-item rail-create" data-panel="create">New agent <span aria-hidden="true">+</span></button>
        <button type="button" class="rail-item" data-panel="runners">Runners <span id="runner-count">1</span></button>
        <button type="button" class="rail-item" data-panel="skills">Skills</button>
        <span class="rail-section-label rail-section-activity">Activity</span>
        <button type="button" class="rail-item" data-panel="notifications">Notifications <span id="notification-count">0</span></button>
        <button type="button" class="rail-item" data-panel="events">Event Inbox <span id="event-count">0</span></button>
        <button type="button" class="rail-item" data-panel="work">Work Queue <span id="work-count">0</span></button>
      </div>
      <div class="rail-footer">
        <span id="connection-dot" class="dot"></span>
        <span id="connection">Connecting</span>
      </div>
    </nav>
    <section id="topology-workspace" class="topology-workspace" aria-label="Live agent topology">
      <header class="topology-toolbar">
        <div class="topology-toolbar-group" role="toolbar" aria-label="Topology tools">
          <button type="button" class="topology-tool active">Select</button>
          <button type="button" class="topology-tool" title="Connection editing is coming next" disabled>Connect</button>
          <button id="topology-add-agent" type="button" class="topology-tool primary">Add agent</button>
          <button id="topology-add-runner" type="button" class="topology-tool">Add runner</button>
          <button type="button" class="topology-tool" title="Event source editing is coming next" disabled>Add event source</button>
          <button id="topology-fit" type="button" class="topology-tool">Fit view</button>
        </div>
        <label class="topology-search-label">
          <span>Search topology</span>
          <input id="topology-search" type="search" placeholder="Search agents" autocomplete="off">
        </label>
        <div class="topology-health">
          <span><i class="status-dot idle"></i>System live</span>
          <span id="compatibility-health" title="Codex compatibility catalog">Catalog pending</span>
          <button id="topology-motion-toggle" type="button" class="topology-tool" aria-pressed="true">Motion on</button>
        </div>
      </header>
      <div class="topology-stage">
        <canvas id="topology-canvas" aria-label="Interactive 3D map of agents and event routes"></canvas>
        <div id="topology-agent-list" class="topology-agent-list" aria-label="Agents in topology"></div>
        <div id="topology-fallback" class="topology-fallback" hidden></div>
        <div class="topology-legend" aria-label="Topology legend">
          <span><i class="legend-signal event"></i>Event</span>
          <span><i class="legend-signal route"></i>Routing</span>
          <span><i class="legend-signal approval"></i>Approval</span>
        </div>
        <div class="topology-view-controls">
          <button id="topology-zoom-out" type="button" aria-label="Zoom out">−</button>
          <button id="topology-fit-secondary" type="button">Fit</button>
          <button type="button" class="active">3D</button>
        </div>
      </div>
      <aside id="topology-inspector" class="topology-inspector" aria-live="polite">
        <div class="topology-inspector-empty"><strong>No agent selected</strong><span>Add or select an agent to inspect it.</span></div>
      </aside>
      <footer class="topology-timeline" aria-label="Live topology timeline">
        <span class="topology-live"><i></i>Live</span>
        <div class="timeline-track"><i></i><span></span><span></span><span></span><span></span><span></span></div>
        <time>Now</time>
      </footer>
    </section>
    <aside class="side-panel">
      <header class="panel-header">
        <div>
          <h2 id="panel-title">Agents</h2>
          <p id="panel-subtitle">Manage live Codex sessions.</p>
        </div>
        <button id="refresh" type="button" class="secondary">Refresh</button>
      </header>
      <section id="panel-create" class="panel-view">
        <form id="agent-form" class="agent-setup-form">
          <section class="setup-card">
            <header><span>01</span><div><h3>Identity</h3><p>Name the agent and choose where it runs.</p></div></header>
            <div class="setup-grid two-column">
              <label>Name<input id="agent-name" name="name" autocomplete="off" placeholder="Maintenance debugger"></label>
              <label>ID (optional)<input id="agent-id" name="id" autocomplete="off" placeholder="Generated from name"></label>
              <div id="agent-id-hint" class="field-hint field-span">Used by API routes and event targets.</div>
              <label>Role<select name="role"><option value="">Worker</option><option value="router">Router</option><option value="jarvis">Jarvis</option></select></label>
              <label>Runner<select name="runnerId" data-runner-select><option value="local">This machine</option></select></label>
              <div class="field-group field-span"><label for="create-agent-cwd">Working directory</label><div class="path-field"><input id="create-agent-cwd" name="cwd" autocomplete="off" value="${escapeHtml(process.cwd())}"><button type="button" class="secondary" data-browse-cwd>Browse</button></div></div>
              <label class="field-span">Routing description <span class="label-optional">Optional</span><textarea name="routingDescription" rows="2" placeholder="What work should be routed to this agent?"></textarea></label>
            </div>
          </section>
          <section class="setup-card">
            <header><span>02</span><div><h3>Runtime</h3><p>Choose the model, permissions, and capabilities.</p></div></header>
            <div class="setup-grid two-column">
              <label>Model<select name="model" data-model-select><option value="">Default Codex model</option></select></label>
              <label>Thinking<select name="reasoningEffort" data-reasoning-select><option value="">Default</option></select></label>
              <label>Speed<select name="serviceTier" data-service-tier-select><option value="">Default</option></select></label>
              <label>Permissions<select name="permissionMode"><option value="ask">Ask for approval</option><option value="auto-review">Approve for me</option><option value="full-access">Full access</option></select></label>
              <div class="field-hint field-span">Permission policy controls sandbox access and escalation review.</div>
              <label class="field-span">Skills<select name="skillMode"><option value="all">All available skills</option><option value="selected">Selected skills only</option></select></label>
              <div class="skill-picker field-span" data-skill-picker hidden>
                <input type="search" data-skill-search placeholder="Search skills">
                <div class="skill-options" data-skill-options><span>Choose a working directory to load skills.</span></div>
                <div class="field-hint">Only selected skills are exposed to this agent. Plugin and MCP settings stay unchanged.</div>
              </div>
            </div>
          </section>
          <section class="setup-card setup-card-instructions">
            <header><span>03</span><div><h3>Instructions</h3><p>Define the agent's responsibility and operating boundaries.</p></div></header>
            <label>Developer instructions<textarea name="instructions" rows="10" placeholder="You specialize in..."></textarea></label>
          </section>
          <footer class="setup-actions"><button type="button" class="secondary" data-panel="topology">Cancel</button><button id="create-agent-button" type="submit">Create agent</button></footer>
        </form>
      </section>
      <section id="panel-agents" class="panel-view active"></section>
    </aside>
    <div id="agent-settings-modal" class="settings-modal agent-settings-page" hidden>
      <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-settings-title">
        <header>
          <div><span class="settings-kicker">Agent configuration</span><h2 id="agent-settings-title">Edit agent</h2><p>Update runtime, workspace, skills, and instructions.</p></div>
          <button id="close-agent-settings" type="button" class="secondary">Done</button>
        </header>
        <div class="settings-dialog-body">
          <form id="edit-agent-form" class="agent-editor-form">
            <section class="setup-card"><header><span>01</span><div><h3>Identity</h3><p id="edit-agent-status">Select an agent</p></div></header><div class="setup-grid two-column">
              <label>Name<input name="name" autocomplete="off"></label>
              <label>Role<select name="role"><option value="">Worker</option><option value="router">Router</option><option value="jarvis">Jarvis</option></select></label>
              <label>Runner<select name="runnerId" data-runner-select><option value="local">This machine</option></select></label>
              <div class="field-group"><label for="edit-agent-cwd">Working directory</label><div class="path-field"><input id="edit-agent-cwd" name="cwd" autocomplete="off"><button type="button" class="secondary" data-browse-cwd>Browse</button></div></div>
              <label class="field-span">Routing description<textarea name="routingDescription" rows="2"></textarea></label>
            </div></section>
            <section class="setup-card"><header><span>02</span><div><h3>Runtime</h3><p>Changes apply to the next turn.</p></div></header><div class="setup-grid two-column">
              <label>Model<select name="model" data-model-select><option value="">Default Codex model</option></select></label>
              <label>Thinking<select name="reasoningEffort" data-reasoning-select><option value="">Default</option></select></label>
              <label>Speed<select name="serviceTier" data-service-tier-select><option value="">Default</option></select></label>
              <label>Permissions<select name="permissionMode"><option value="ask">Ask for approval</option><option value="auto-review">Approve for me</option><option value="full-access">Full access</option></select></label>
              <div class="field-hint field-span">Permission changes apply on the next turn without replacing this thread.</div>
              <label class="field-span">Skills<select name="skillMode"><option value="all">All available skills</option><option value="selected">Selected skills only</option></select></label>
              <div class="skill-picker field-span" data-skill-picker hidden><input type="search" data-skill-search placeholder="Search skills"><div class="skill-options" data-skill-options></div><div class="field-hint">Changing skill access starts a fresh session on the next turn.</div></div>
            </div></section>
            <section class="setup-card setup-card-instructions"><header><span>03</span><div><h3>Instructions</h3><p>Saving these starts a fresh Codex session on the next turn.</p></div></header><label>Developer instructions<textarea name="instructions" rows="10"></textarea></label></section>
            <div class="agent-actions setup-actions">
              <button type="submit">Save Changes</button>
              <button id="delete-agent-button" type="button" class="danger">Delete</button>
            </div>
          </form>
        </div>
      </section>
    </div>
    <div id="runner-enrollment-modal" class="settings-modal" hidden>
      <section class="settings-dialog runner-enrollment-dialog" role="dialog" aria-modal="true" aria-labelledby="runner-enrollment-title">
        <header>
          <div><span class="settings-kicker">Remote runner</span><h2 id="runner-enrollment-title">Add a machine</h2><p>Generate one command that enrolls and starts SquadAI on another machine.</p></div>
          <button id="runner-enrollment-close" type="button" class="secondary">Close</button>
        </header>
        <div class="settings-dialog-body runner-enrollment-body">
          <ol class="runner-enrollment-steps">
            <li>Install Tailscale, Node.js, Codex, and the SquadAI CLI on the new machine.</li>
            <li>Make sure both machines are connected to the same Tailscale network.</li>
            <li>Click below. SquadAI will create a private Tailscale address automatically.</li>
            <li>Run the generated command on the new machine.</li>
          </ol>
          <button id="runner-enrollment-generate" type="button">Generate enrollment command</button>
          <div id="runner-enrollment-status" class="field-hint"></div>
          <a id="runner-enrollment-approval" class="secondary runner-enrollment-approval" target="_blank" rel="noopener" hidden>Approve Tailscale setup</a>
          <div id="runner-enrollment-result" class="runner-enrollment-result" hidden>
            <label>Run this on the new machine
              <textarea id="runner-enrollment-command" rows="4" readonly></textarea>
            </label>
            <div class="runner-enrollment-actions">
              <span id="runner-enrollment-expiry" class="field-hint"></span>
              <button id="runner-enrollment-copy" type="button" class="secondary">Copy command</button>
            </div>
          </div>
        </div>
      </section>
    </div>
    <div id="remote-directory-modal" class="settings-modal" hidden>
      <section class="settings-dialog remote-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-directory-title">
        <header>
          <div><span class="settings-kicker">Remote runner</span><h2 id="remote-directory-title">Choose working directory</h2><p id="remote-directory-runner"></p></div>
          <button id="remote-directory-close" type="button" class="secondary">Close</button>
        </header>
        <div class="settings-dialog-body remote-directory-body">
          <div class="remote-directory-nav">
            <button id="remote-directory-home" type="button" class="secondary">Home</button>
            <button id="remote-directory-up" type="button" class="secondary">Up</button>
          </div>
          <form id="remote-directory-path-form" class="path-field">
            <input id="remote-directory-path" autocomplete="off" aria-label="Remote directory path">
            <button type="submit" class="secondary">Go</button>
          </form>
          <div id="remote-directory-status" class="field-hint"></div>
          <div id="remote-directory-list" class="remote-directory-list"></div>
          <div class="remote-directory-actions">
            <button id="remote-directory-cancel" type="button" class="secondary">Cancel</button>
            <button id="remote-directory-select" type="button">Select this folder</button>
          </div>
        </div>
      </section>
    </div>
    <section class="workspace chat-stream">
      <header class="topbar">
        <div>
          <h2 id="selected-title">No agent selected</h2>
          <p id="selected-meta">Create or select an agent to begin.</p>
        </div>
        <div class="topbar-actions">
          <button id="workspace-open-button" type="button" class="secondary" hidden>Open in VS Code</button>
          <button id="instance-done-button" type="button" class="secondary" hidden>Mark done</button>
          <button id="instance-cancel-button" type="button" class="danger" hidden>Cancel task</button>
          <button id="workspace-cleanup-button" type="button" class="secondary" hidden>Clean up</button>
          <button id="cancel-agent-button" type="button" class="danger" hidden>Stop turn</button>
        </div>
      </header>
      <section class="message-list" id="messages"></section>
      <form id="message-form" class="composer">
        <textarea id="message" rows="1" placeholder="Message the selected agent"></textarea>
        <div class="composer-row">
          <div class="composer-left">
            <label class="network-toggle"><input id="allow-network" type="checkbox" checked> Network</label>
          </div>
          <div class="composer-settings" aria-label="Turn settings">
            <label class="composer-select permission"><span>Permissions</span><select id="composer-permission" aria-label="Approval policy"><option value="ask">Ask for approval</option><option value="auto-review">Approve for me</option><option value="full-access">Full access</option></select></label>
            <div class="composer-runtime">
              <button id="composer-runtime-toggle" class="composer-runtime-toggle" type="button" aria-haspopup="menu" aria-expanded="false"><span id="composer-runtime-label">Default · Default</span></button>
              <div id="composer-runtime-menu" class="composer-runtime-menu" role="menu" hidden>
                <div id="composer-reasoning-view">
                  <span class="runtime-menu-heading">Reasoning</span>
                  <div id="composer-reasoning-options" class="runtime-menu-options"></div>
                  <button id="composer-model-view-button" class="runtime-model-row" type="button"><span>Model</span><strong id="composer-current-model">Default</strong></button>
                </div>
                <div id="composer-model-view" hidden>
                  <button id="composer-runtime-back" class="runtime-menu-back" type="button">Reasoning</button>
                  <span class="runtime-menu-heading">Model</span>
                  <div id="composer-model-options" class="runtime-menu-options"></div>
                </div>
              </div>
            </div>
            <button class="composer-send" type="submit" aria-label="Send message">Send</button>
          </div>
        </div>
      </form>
    </section>
    <section id="ops-workspace" class="ops-workspace" aria-live="polite">
      <header class="ops-header">
        <div>
          <h2 id="ops-title">System Activity</h2>
          <p id="ops-subtitle">Operational records from the command center.</p>
        </div>
        <div class="ops-controls">
          <span id="ops-count">0 items</span>
          <button id="ops-refresh" type="button" class="secondary">Refresh</button>
        </div>
      </header>
      <div class="ops-body">
        <div id="notifications-list" class="ops-log"></div>
        <div id="sensor-events" class="ops-log"></div>
        <div id="work-items" class="ops-log"></div>
        <div id="runners-list" class="ops-log"></div>
        <div id="skill-library" class="ops-log"></div>
      </div>
    </section>
    <div id="toasts" class="toasts"></div>
  </main>
  <script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>
  <script type="module" src="/assets/topology.js"></script>
  <script>${js()}</script>
</body>
</html>`;
}

function css(): string {
  return `
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #e6edf3; background: #0d1117; overflow: hidden; }
button, input, textarea, select { font: inherit; }
button { border: 1px solid #30363d; background: #1f6feb; color: #fff; border-radius: 8px; padding: 9px 13px; cursor: pointer; font-weight: 600; transition: background .15s, border-color .15s, opacity .15s; }
button:hover { background: #388bfd; }
button:disabled { opacity: .5; cursor: not-allowed; }
button.secondary { background: #161b22; color: #e6edf3; }
button.secondary:hover { border-color: #58a6ff; background: #1c2128; }
button.danger { background: #21262d; color: #f85149; }
button.danger:hover { border-color: #f85149; background: #2d1517; }
.shell { display: grid; grid-template-columns: 220px 360px minmax(0, 1fr); height: 100vh; }
.shell.jarvis-mode, .shell.agents-mode, .shell.ops-mode, .shell.topology-mode { grid-template-columns: 220px minmax(0, 1fr); }
.shell.jarvis-mode .side-panel, .shell.agents-mode .side-panel, .shell.ops-mode .side-panel, .shell.ops-mode .workspace, .shell.topology-mode .side-panel, .shell.topology-mode .workspace, .shell.topology-mode .ops-workspace { display: none; }
.shell.jarvis-mode .workspace, .shell.agents-mode .workspace, .shell.ops-mode .ops-workspace { display: grid; grid-column: 2; }
.shell.topology-mode .topology-workspace { display: grid; grid-column: 2; }
.topology-workspace { display: none; position: relative; grid-template-columns: minmax(0, 1fr) 330px; grid-template-rows: 68px minmax(0, 1fr) 64px; min-width: 0; min-height: 0; overflow: hidden; background: #070a12; }
.topology-toolbar { grid-column: 1 / -1; display: flex; align-items: center; gap: 14px; min-width: 0; padding: 10px 16px; background: #0c101b; border-bottom: 1px solid #202638; z-index: 4; }
.topology-toolbar-group { display: flex; gap: 7px; }
.topology-tool { background: #111728; color: #aeb8d2; border-color: #293149; border-radius: 7px; padding: 8px 11px; font-size: 12px; font-weight: 600; }
.topology-tool:hover, .topology-tool.active { background: #182039; color: #f4f7ff; border-color: #586dba; }
.topology-tool.primary { background: #6477ed; color: white; border-color: #7888f6; }
.topology-tool:disabled { color: #596277; border-color: #202638; cursor: not-allowed; opacity: .7; }
.topology-search-label { flex: 1; max-width: 340px; margin: 0; display: block; }
.topology-search-label span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.topology-search-label input { height: 36px; background: #090d17; border-color: #252c40; color: #dfe5f7; }
.topology-health { margin-left: auto; display: flex; align-items: center; gap: 12px; color: #99a4bf; font-size: 12px; white-space: nowrap; }
.topology-health > span { display: flex; align-items: center; gap: 7px; }
.topology-stage { position: relative; min-width: 0; min-height: 0; overflow: hidden; background: #070a12; }
#topology-canvas { display: block; width: 100%; height: 100%; cursor: grab; outline: none; touch-action: none; }
#topology-canvas:active { cursor: grabbing; }
#topology-canvas.over-agent { cursor: move; }
#topology-canvas.dragging-node, #topology-canvas.panning-view { cursor: grabbing; }
.topology-agent-list { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.topology-label { position: absolute; left: 0; top: 0; min-width: 108px; display: grid; gap: 2px; padding: 7px 10px; pointer-events: none; color: #e8edff; background: rgba(10,14,25,.88); border: 1px solid rgba(116,132,183,.36); border-radius: 8px; box-shadow: 0 10px 22px rgba(0,0,0,.22); transition: border-color .16s, background .16s, opacity .16s; }
.topology-label:hover, .topology-label.selected { background: rgba(20,27,48,.96); border-color: #7589f6; }
.topology-label strong { font-size: 12px; font-weight: 700; white-space: nowrap; }
.topology-label span { color: #8994ae; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
.topology-label.status-running span, .topology-label.status-starting span { color: #54e59a; }
.topology-label.status-failed span { color: #ff687c; }
.topology-label.status-blocked span { color: #f5aa42; }
.topology-source-label { pointer-events: none; border-color: rgba(75,220,244,.35); background: rgba(7,24,34,.86); }
.topology-source-label span { color: #56cfe7; }
.topology-source-label.route-selected { color: #f2fbff; border-color: rgba(103,216,255,.95); background: rgba(8,37,52,.96); box-shadow: 0 0 0 1px rgba(103,216,255,.18), 0 10px 28px rgba(20,181,226,.18); }
.topology-source-label.route-muted { opacity: .38 !important; }
.topology-legend { position: absolute; left: 18px; top: 18px; display: flex; gap: 13px; padding: 7px 9px; color: #7f8aa4; background: rgba(7,10,18,.76); border: 1px solid #20273a; border-radius: 7px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
.topology-legend span { display: flex; align-items: center; gap: 5px; }
.legend-signal { width: 7px; height: 7px; border-radius: 999px; background: #6879ed; }
.legend-signal.event { background: #67d8ff; }
.legend-signal.approval { background: #f5aa42; }
.topology-view-controls { position: absolute; left: 18px; bottom: 18px; display: flex; gap: 4px; padding: 4px; background: rgba(11,15,26,.9); border: 1px solid #252d42; border-radius: 8px; }
.topology-view-controls button { min-width: 36px; padding: 6px 9px; color: #8e99b4; background: transparent; border: 0; border-radius: 5px; font-size: 11px; }
.topology-view-controls button:hover, .topology-view-controls button.active { color: white; background: #202a49; }
.topology-inspector { grid-column: 2; grid-row: 2 / 4; min-width: 0; overflow-y: auto; background: #0c101b; border-left: 1px solid #202638; color: #dfe5f7; z-index: 3; }
.topology-inspector header { display: flex; justify-content: space-between; gap: 12px; padding: 22px 20px 18px; border-bottom: 1px solid #202638; }
.topology-inspector header h2 { margin: 3px 0 6px; color: #f3f6ff; font-size: 20px; letter-spacing: -.02em; text-transform: none; }
.topology-inspector header p { display: flex; align-items: center; gap: 7px; margin: 0; color: #8f9ab3; font-size: 12px; text-transform: capitalize; }
.topology-inspector header button { align-self: start; padding: 1px 7px; color: #8490aa; background: transparent; border: 0; font-size: 22px; }
.topology-kicker { color: #6879ed; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; }
.topology-inspector section { padding: 18px 20px; border-bottom: 1px solid #202638; }
.topology-inspector h3 { margin: 0 0 12px; color: #8390ac; font-size: 10px; text-transform: uppercase; letter-spacing: .1em; }
.topology-inspector dl { display: grid; gap: 9px; margin: 0; }
.topology-inspector dl div { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 10px; }
.topology-inspector dt { color: #73809d; font-size: 11px; }
.topology-inspector dd { margin: 0; color: #d8def0; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topology-runtime { display: grid; gap: 7px; color: #aab4cd; font-size: 11px; }
.topology-runtime > div { height: 4px; overflow: hidden; background: #1c2335; border-radius: 999px; }
.topology-runtime > div i { display: block; height: 100%; background: #6879ed; border-radius: inherit; }
.topology-runtime small { color: #697590; }
.topology-permissions { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; color: #aab4cd; font-size: 11px; }
.topology-permissions li::before { content: ""; display: inline-block; width: 6px; height: 6px; margin: 0 9px 1px 1px; border-radius: 50%; background: #54e59a; box-shadow: 0 0 8px rgba(84,229,154,.45); }
.topology-telegram { display: grid; gap: 11px; }
.topology-telegram p { margin: 0; color: #8994ae; font-size: 11px; line-height: 1.5; }
.topology-telegram form { display: grid; gap: 9px; }
.topology-telegram label { display: grid; gap: 6px; color: #8994ae; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
.topology-telegram input, .topology-telegram select { width: 100%; padding: 9px 10px; color: #e8edff; background: #090d17; border: 1px solid #293149; border-radius: 7px; }
.topology-telegram button { width: 100%; }
.telegram-connected { display: flex; align-items: center; gap: 10px; padding: 10px; background: #111728; border: 1px solid #293149; border-radius: 8px; }
.telegram-connected > div { display: grid; gap: 2px; min-width: 0; }
.telegram-connected strong { overflow: hidden; color: #eef2ff; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.telegram-connected small { overflow: hidden; color: #7f8aa4; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.telegram-avatar { width: 30px; height: 30px; display: grid; place-items: center; flex: 0 0 auto; color: white; background: #2aabee; border-radius: 50%; font-size: 12px; font-weight: 800; }
.telegram-feedback { min-height: 16px; color: #f5aa42; font-size: 10px; line-height: 1.4; }
.topology-inspector footer { display: grid; gap: 8px; padding: 18px 20px 24px; }
.topology-inspector footer button { width: 100%; }
.topology-inspector-empty { height: 100%; display: grid; place-content: center; gap: 6px; padding: 24px; text-align: center; color: #76819a; }
.topology-inspector-empty strong { color: #d8deef; }
.topology-fallback { position: absolute; inset: 0; padding: 28px; overflow-y: auto; background: #070a12; }
.topology-fallback button { width: 100%; display: flex; justify-content: space-between; margin-bottom: 8px; background: #111728; border-color: #293149; }
.topology-timeline { grid-column: 1; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 13px 18px; background: #0c101b; border-top: 1px solid #202638; color: #737e96; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
.topology-live { display: flex; align-items: center; gap: 7px; color: #54e59a; }
.topology-live i { width: 7px; height: 7px; border-radius: 999px; background: #54e59a; box-shadow: 0 0 10px rgba(84,229,154,.5); }
.timeline-track { position: relative; height: 2px; background: #2a334d; }
.timeline-track i { position: absolute; right: 18%; top: -4px; width: 10px; height: 10px; border-radius: 999px; background: #7182f4; box-shadow: 0 0 12px rgba(113,130,244,.75); }
.timeline-track span { position: absolute; top: -2px; width: 6px; height: 6px; border-radius: 999px; background: #6576d9; }
.timeline-track span:nth-of-type(1) { left: 12%; }
.timeline-track span:nth-of-type(2) { left: 28%; background: #67d8ff; }
.timeline-track span:nth-of-type(3) { left: 45%; }
.timeline-track span:nth-of-type(4) { left: 62%; background: #f5aa42; }
.timeline-track span:nth-of-type(5) { left: 76%; }
.status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 999px; background: #7180a4; }
.status-dot.idle, .status-dot.running, .status-dot.starting { background: #54e59a; }
.status-dot.failed { background: #ff5d72; }
.status-dot.blocked { background: #f5aa42; }
.command-rail { background: #161b22; border-right: 1px solid #30363d; display: flex; flex-direction: column; min-height: 0; }
.brand { padding: 20px; border-bottom: 1px solid #30363d; }
h1 { margin: 0; font-size: 18px; letter-spacing: -.2px; }
h2 { margin: 0; font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: .08em; }
.rail-nav { flex: 1; padding: 12px 8px; display: flex; flex-direction: column; gap: 3px; }
.rail-item { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-radius: 6px; border: 0; background: transparent; color: #8b949e; text-align: left; font-size: 14px; font-weight: 500; }
.rail-item:hover { background: #1c2128; color: #e6edf3; }
.rail-item.active { background: rgba(88,166,255,.12); color: #58a6ff; font-weight: 700; }
.rail-item span { min-width: 22px; border-radius: 999px; padding: 1px 7px; background: #0d1117; color: #8b949e; text-align: center; font-size: 11px; }
.rail-agents { display: grid; gap: 2px; margin: -1px 0 7px; padding: 0 5px 6px 13px; border-bottom: 1px solid rgba(48,54,61,.65); }
.rail-agent { width: 100%; display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; justify-content: start; gap: 8px; padding: 7px 9px; border: 0; border-radius: 6px; background: transparent; color: #8b949e; text-align: left; font-size: 12px; font-weight: 550; }
.rail-agent:hover { background: #1c2128; color: #e6edf3; }
.rail-agent.active { background: rgba(88,166,255,.12); color: #e6edf3; }
.rail-agent strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-agent .status-dot { width: 6px; height: 6px; }
.rail-agent-state { color: #d29922; font-size: 10px; font-weight: 700; white-space: nowrap; }
.rail-agent-state.terminal { color: #6e7681; }
.rail-footer { padding: 14px 18px; border-top: 1px solid #30363d; display: flex; align-items: center; gap: 7px; color: #8b949e; font-size: 12px; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 999px; background: #f85149; display: inline-block; }
.dot.connected { background: #3fb950; }
.side-panel { background: #0d1117; border-right: 1px solid #30363d; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.panel-header { padding: 16px 18px; border-bottom: 1px solid #30363d; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; background: #161b22; }
.panel-header h2 { color: #e6edf3; font-size: 16px; text-transform: none; letter-spacing: 0; }
.panel-header p { margin: 4px 0 0; color: #8b949e; font-size: 12px; line-height: 1.4; }
.panel-view { display: none; padding: 16px 18px; overflow-y: auto; min-height: 0; }
.panel-view.active { display: block; }
.section-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; }
.section-head span { color: #8b949e; font-size: 12px; }
label { display: grid; gap: 6px; margin-bottom: 10px; color: #8b949e; font-size: 12px; }
input, textarea, select { width: 100%; border: 1px solid #30363d; border-radius: 8px; padding: 9px 11px; background: #0d1117; color: #e6edf3; outline: none; }
input:focus, textarea:focus, select:focus { border-color: #58a6ff; }
textarea { resize: vertical; }
.field-hint { margin: -3px 0 10px; color: #6e7681; font-size: 11px; line-height: 1.4; }
.field-group { margin-bottom: 10px; }
.field-group > label { margin-bottom: 6px; }
.path-field { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
.path-field button { min-width: 72px; }
.skill-picker { margin: -2px 0 12px; padding: 10px; border: 1px solid #30363d; border-radius: 8px; background: #0d1117; }
.skill-picker input[type="search"] { margin-bottom: 8px; }
.skill-options { display: grid; gap: 5px; max-height: 210px; overflow-y: auto; }
.skill-option { display: grid; grid-template-columns: auto minmax(0,1fr) auto; gap: 8px; align-items: start; margin: 0; padding: 7px; border-radius: 6px; }
.skill-option:hover { background: #161b22; }
.skill-option input { width: auto; margin-top: 2px; accent-color: #58a6ff; }
.skill-option strong { display: block; color: #c9d1d9; font-size: 12px; }
.skill-option small, .skill-options > span { color: #8b949e; font-size: 11px; line-height: 1.35; }
.skill-scope { color: #6e7681; font-size: 10px; text-transform: uppercase; }
.settings-modal { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 22px; background: rgba(1,4,9,.72); backdrop-filter: blur(5px); }
.settings-modal[hidden] { display: none; }
.settings-dialog { width: min(680px, 94vw); max-height: min(820px, 92vh); display: grid; grid-template-rows: auto minmax(0,1fr); overflow: hidden; background: #161b22; border: 1px solid #3d444d; border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,.55); }
.settings-dialog > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 18px 20px; border-bottom: 1px solid #30363d; }
.settings-dialog > header h2 { margin: 3px 0 2px; color: #e6edf3; font-size: 18px; text-transform: none; letter-spacing: 0; }
.settings-dialog > header p { margin: 0; color: #8b949e; font-size: 12px; }
.settings-kicker { color: #58a6ff; font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.settings-dialog-body { min-height: 0; overflow-y: auto; padding: 18px 20px 22px; }
.runner-enrollment-body { display: grid; gap: 16px; }
.runner-enrollment-steps { margin: 0; padding-left: 22px; color: #c9d1d9; line-height: 1.65; }
.runner-enrollment-steps li + li { margin-top: 5px; }
.runner-enrollment-result { display: grid; gap: 10px; padding: 14px; border: 1px solid #30363d; border-radius: 10px; background: #0d1117; }
.runner-enrollment-result[hidden] { display: none; }
.runner-enrollment-result textarea { width: 100%; resize: none; font-family: ui-monospace,SFMono-Regular,Consolas,monospace; font-size: 12px; line-height: 1.5; }
.runner-enrollment-actions { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.runner-enrollment-approval { width: fit-content; text-decoration: none; }
.runner-enrollment-approval[hidden] { display: none; }
.agent-editor-form { padding: 0; }
.agent-editor-form.disabled { opacity: .55; pointer-events: none; }
.agent-actions { display: flex; gap: 8px; justify-content: space-between; }
.agent-actions button { flex: 1; }
.remote-directory-dialog { width: min(720px, 94vw); }
.remote-directory-body { display: grid; gap: 12px; }
.remote-directory-nav { display: flex; gap: 8px; }
.remote-directory-nav button { padding: 7px 11px; }
.remote-directory-list { min-height: 220px; max-height: 410px; overflow-y: auto; border: 1px solid #30363d; border-radius: 9px; background: #0d1117; }
.remote-directory-entry { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; color: #c9d1d9; background: transparent; border: 0; border-bottom: 1px solid rgba(48,54,61,.68); border-radius: 0; text-align: left; }
.remote-directory-entry:last-child { border-bottom: 0; }
.remote-directory-entry:hover { background: rgba(88,166,255,.09); color: #f0f6fc; }
.remote-directory-entry::before { content: "›"; color: #58a6ff; font-size: 17px; }
.remote-directory-empty { padding: 28px 18px; color: #8b949e; text-align: center; }
.remote-directory-actions { display: flex; justify-content: flex-end; gap: 8px; }
.remote-directory-actions button { min-width: 130px; }
.empty { color: #8b949e; font-size: 13px; padding: 12px; border: 1px dashed #30363d; border-radius: 10px; }
.queue-list { display: grid; gap: 7px; }
.queue-item { border-bottom: 1px solid rgba(48,54,61,.72); padding: 9px 0; background: transparent; display: grid; grid-template-columns: 90px 160px minmax(0, 1fr); gap: 10px; align-items: baseline; }
.queue-item[role="button"] { cursor: pointer; text-align: left; }
.queue-item[role="button"]:hover { background: rgba(88,166,255,.06); }
.queue-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; color: #8b949e; font-size: 11px; }
.queue-actions button { padding: 5px 8px; border-radius: 6px; font-size: 11px; }
.queue-item strong { color: #e6edf3; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue-item .sub { color: #8b949e; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue-message { grid-column: 3 / -1; }
.queue-actions { grid-column: 3 / -1; }
.queue-time { color: #6e7681; font-variant-numeric: tabular-nums; }
.queue-state { color: #58a6ff; font-weight: 700; }
.ops-workspace { display: none; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; background: #0d1117; }
.ops-header { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 18px 28px; background: #161b22; border-bottom: 1px solid #30363d; }
.ops-header h2 { text-transform: none; letter-spacing: 0; color: #e6edf3; font-size: 18px; margin: 0; }
.ops-header p { margin: 4px 0 0; color: #8b949e; font-size: 13px; }
.ops-controls { display: flex; align-items: center; gap: 12px; color: #8b949e; font-size: 12px; white-space: nowrap; }
.ops-body { min-height: 0; overflow-y: auto; padding: 14px 28px 28px; font-family: "SF Mono", Monaco, Consolas, "Courier New", monospace; font-size: 12px; line-height: 1.7; }
.ops-body::-webkit-scrollbar { width: 6px; }
.ops-body::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
.ops-log { display: none; }
.ops-log.active { display: block; }
.log-row { border-bottom: 1px solid rgba(48,54,61,.72); }
.log-summary { display: grid; grid-template-columns: 88px 150px 150px minmax(0, 1fr); gap: 12px; align-items: baseline; padding: 7px 0; cursor: pointer; list-style: none; }
.log-summary::-webkit-details-marker { display: none; }
.log-summary:hover { background: rgba(88,166,255,.05); }
.log-time { color: #6e7681; font-variant-numeric: tabular-nums; }
.log-source { color: #58a6ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-status { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-status.queued, .log-status.pending, .log-status.routing, .log-status.running, .log-status.waiting { color: #d29922; }
.log-status.completed, .log-status.routed { color: #3fb950; }
.log-status.failed { color: #f85149; }
.log-status.cancelled { color: #6e7681; }
.log-message { color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-detail { margin: 0 0 8px 250px; padding: 8px 10px; border-left: 2px solid #30363d; color: #8b949e; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(22,27,34,.65); border-radius: 0 6px 6px 0; }
.log-detail strong { color: #c9d1d9; }
.log-actions { margin: 0 0 10px 250px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.log-actions select { min-width: 180px; padding: 7px 9px; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 7px; }
.log-actions button { padding: 7px 11px; }
.log-empty { display: grid; place-items: center; min-height: 280px; color: #8b949e; border: 1px dashed #30363d; border-radius: 8px; }
.skill-section { margin-bottom: 28px; }
.skill-section h3 { margin: 0 0 4px; color: #e6edf3; font: 600 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.skill-section > p { margin: 0 0 12px; color: #8b949e; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.skill-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 12px; }
.skill-card { display: grid; gap: 10px; padding: 14px; border: 1px solid #30363d; border-radius: 9px; background: #161b22; }
.skill-card header { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
.skill-card h4 { margin: 0; color: #e6edf3; font-size: 13px; overflow-wrap: anywhere; }
.skill-card p { margin: 0; color: #8b949e; min-height: 38px; overflow-wrap: anywhere; }
.skill-card-meta { color: #8b949e; overflow-wrap: anywhere; }
.skill-machine-name { display: inline-block; color: #e6edf3; font-size: 14px; font-weight: 800; }
.skill-card-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.skill-card-actions button { padding: 7px 10px; }
.skill-installed { color: #3fb950; font-weight: 700; }
.skill-error { margin-bottom: 10px; padding: 9px 11px; border: 1px solid rgba(248,81,73,.35); border-radius: 7px; color: #ff7b72; }
.runner-overview { display: grid; gap: 18px; }
.runner-overview-header { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.runner-overview-header p { margin: 0; color: #8b949e; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.runner-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.runner-card { display: grid; gap: 14px; padding: 16px; border: 1px solid #30363d; border-radius: 10px; background: #161b22; }
.runner-card header { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
.runner-card h3 { margin: 0 0 3px; color: #e6edf3; font: 650 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.runner-card header p { margin: 0; color: #8b949e; }
.runner-card dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; margin: 0; }
.runner-card dl div { min-width: 0; }
.runner-card dt { color: #6e7681; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
.runner-card dd { margin: 3px 0 0; color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.runner-state { display: inline-flex; align-items: center; gap: 6px; color: #8b949e; font-weight: 700; }
.runner-state::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #6e7681; }
.runner-state.online { color: #3fb950; }
.runner-state.online::before { background: #3fb950; box-shadow: 0 0 0 3px rgba(63,185,80,.12); }
.runner-state.offline { color: #f85149; }
.runner-state.offline::before { background: #f85149; }
.status-pill { align-self: start; justify-self: end; border-radius: 999px; padding: 2px 8px; background: #1c2128; color: #8b949e; font-size: 11px; font-weight: 700; }
.status-pill.running, .status-pill.starting { background: rgba(210,153,34,.15); color: #d29922; }
.status-pill.idle { background: rgba(63,185,80,.12); color: #3fb950; }
.status-pill.failed { background: rgba(248,81,73,.14); color: #f85149; }
.workspace { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; min-height: 0; }
.ops-workspace { display: none; }
.topbar { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 22px; background: #161b22; border-bottom: 1px solid #30363d; }
.topbar h2 { text-transform: none; letter-spacing: 0; color: #e6edf3; font-size: 18px; margin: 0; }
.topbar p { margin: 4px 0 0; color: #8b949e; font-size: 13px; overflow-wrap: anywhere; }
.topbar-actions { display: flex; align-items: center; gap: 8px; }
.message-list { overflow-y: auto; padding: 22px; display: flex; flex-direction: column; gap: 13px; }
.message-list::-webkit-scrollbar { width: 6px; }
.message-list::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
.load-older-events { align-self: center; padding: 7px 12px; border: 1px solid #30363d; border-radius: 999px; background: #161b22; color: #8b949e; font-size: 12px; }
.load-older-events:hover { color: #e6edf3; border-color: #58a6ff; }
.load-older-events:disabled { cursor: wait; opacity: .65; }
.message-row { display: flex; flex-direction: column; max-width: 78%; gap: 4px; }
.message-row.user { align-self: flex-end; align-items: flex-end; }
.message-row.agent, .message-row.system { align-self: flex-start; align-items: flex-start; }
.message-row.status { align-self: center; align-items: center; max-width: 90%; }
.message-meta { color: #8b949e; font-size: 11px; }
.message-bubble { padding: 10px 14px; border-radius: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.message-bubble.user { background: #1f6feb; color: #fff; border-bottom-right-radius: 4px; }
.message-bubble.agent { background: #1c2128; border: 1px solid #30363d; border-bottom-left-radius: 4px; }
.message-bubble.system { background: transparent; color: #d29922; padding: 3px 8px; font-size: 12px; }
.approval-card { background: #1c2128; border: 1px solid #d29922; border-radius: 8px; padding: 12px; display: grid; gap: 9px; min-width: min(520px, 80vw); box-shadow: 0 10px 24px rgba(0,0,0,.22); }
.approval-title { color: #f0f6fc; font-weight: 700; }
.approval-detail { color: #c9d1d9; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.approval-actions { display: flex; gap: 8px; justify-content: flex-end; }
.approval-actions button { padding: 7px 10px; border-radius: 7px; }
.approval-actions button[data-approval-action="declined"] { background: #21262d; color: #f85149; }
.approval-actions button[data-approval-action="declined"]:hover { border-color: #f85149; }
.compatibility-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.compatibility-actions select { min-width: 170px; padding: 7px 9px; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 7px; }
.compatibility-actions button { padding: 7px 10px; }
.activity-sequence { background: transparent; border: 1px solid #30363d; border-radius: 8px; max-width: min(560px, 80vw); color: #8b949e; }
.activity-sequence[open] { background: #0d1117; }
.activity-sequence.failed { border-color: rgba(248,81,73,.5); }
.activity-sequence.running { border-color: rgba(210,153,34,.45); }
.activity-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 10px; cursor: pointer; list-style: none; font-size: 12px; }
.activity-toggle::-webkit-details-marker { display: none; }
.activity-toggle strong { color: #c9d1d9; font-weight: 600; }
.activity-count { color: #8b949e; font-size: 11px; }
.activity-detail-list { border-top: 1px solid #30363d; padding: 8px 10px 10px; display: grid; gap: 6px; max-height: 260px; overflow-y: auto; }
.activity-detail-list::-webkit-scrollbar { width: 6px; }
.activity-detail-list::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
.activity-row { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; align-items: start; font-size: 12px; }
.activity-row strong { color: #58a6ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-row span { color: #c9d1d9; overflow-wrap: anywhere; }
.activity-muted { color: #8b949e; font-size: 11px; }
.pending-message { color: #8b949e; font-size: 13px; padding: 4px 10px; }
.pending-message::after { content: ""; animation: dots 1.2s steps(4,end) infinite; }
@keyframes dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }
.composer { margin: 0 18px 16px; padding: 12px 13px 10px; background: #161b22; border: 1px solid #30363d; border-radius: 18px; box-shadow: 0 12px 30px rgba(0,0,0,.2); }
.composer textarea { min-height: 46px; max-height: 150px; resize: none; border: 0; background: transparent; padding: 4px 7px 8px; box-shadow: none; font-size: 14px; line-height: 1.5; }
.composer textarea:focus { border-color: transparent; box-shadow: none; }
.composer-row { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; gap: 12px; }
.composer-left, .composer-settings { display: flex; align-items: center; gap: 7px; min-width: 0; }
.composer-row label { display: flex; grid-template-columns: none; align-items: center; gap: 7px; margin: 0; font-size: 12px; }
.composer-row input { width: auto; accent-color: #58a6ff; }
.network-toggle { color: #8b949e; padding: 6px 7px; }
.composer-select { position: relative; color: #8b949e; }
.composer-select > span { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.composer-select select { min-width: 0; width: auto; max-width: 190px; height: 32px; padding: 5px 25px 5px 9px; border: 1px solid transparent; border-radius: 9px; background-color: transparent; color: #c9d1d9; font-size: 12px; font-weight: 600; box-shadow: none; cursor: pointer; }
.composer-select select:hover, .composer-select select:focus { background-color: #21262d; border-color: #3d444d; }
.composer-select.permission select { color: #58a6ff; max-width: 145px; }
.composer-select select:disabled { opacity: .45; cursor: not-allowed; }
.composer.updating .composer-select, .composer.updating .composer-runtime { opacity: .55; }
.composer-runtime { position: relative; }
.composer-runtime-toggle { height: 32px; max-width: 230px; padding: 5px 9px; overflow: hidden; border: 1px solid transparent; border-radius: 9px; background: transparent; color: #c9d1d9; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.composer-runtime-toggle:hover, .composer-runtime-toggle[aria-expanded="true"] { background: #21262d; border-color: #3d444d; }
.composer-runtime-menu { position: absolute; right: 0; bottom: calc(100% + 9px); z-index: 20; width: 250px; max-height: min(410px, 70vh); overflow-y: auto; padding: 8px; background: #f6f7f9; border: 1px solid #d0d4da; border-radius: 14px; box-shadow: 0 18px 45px rgba(0,0,0,.38); color: #1f2328; }
.composer-runtime-menu[hidden] { display: none; }
.runtime-menu-heading { display: block; padding: 6px 10px 5px; color: #7d8590; font-size: 12px; font-weight: 500; }
.runtime-menu-options { display: grid; gap: 2px; }
.runtime-menu-option, .runtime-model-row, .runtime-menu-back { width: 100%; min-height: 36px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 10px; border: 0; border-radius: 8px; background: transparent; color: #1f2328; text-align: left; font-size: 13px; font-weight: 500; }
.runtime-menu-option:hover, .runtime-model-row:hover, .runtime-menu-back:hover { background: #e9ecf1; color: #111418; }
.runtime-menu-option.selected { background: #e4e8ef; font-weight: 700; }
.runtime-menu-option small { color: #6e7781; font-size: 11px; }
.runtime-model-row { margin-top: 6px; padding-top: 10px; border-top: 1px solid #d8dce2; border-radius: 0 0 8px 8px; }
.runtime-model-row strong { overflow: hidden; color: #3f4751; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.runtime-menu-back { justify-content: flex-start; color: #57606a; font-size: 12px; }
.composer-runtime-toggle:disabled { opacity: .45; cursor: not-allowed; }
.composer-send { min-width: 54px; height: 34px; padding: 6px 12px; border-radius: 10px; background: #f0f6fc; color: #0d1117; font-weight: 700; }
.composer-send:hover { background: #fff; border-color: #fff; }
@media (max-width: 860px) {
  .composer { margin: 0 10px 10px; }
  .composer-row { align-items: flex-end; }
  .composer-settings { flex-wrap: wrap; justify-content: flex-end; }
  .composer-runtime-toggle { max-width: 190px; }
  .composer-runtime-menu { width: min(250px, calc(100vw - 28px)); }
}
.toasts { position: fixed; right: 18px; bottom: 18px; display: grid; gap: 8px; z-index: 10; }
.toast { background: #1c2128; border: 1px solid #30363d; border-left: 3px solid #58a6ff; color: #e6edf3; border-radius: 8px; padding: 10px 12px; min-width: 220px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
.toast.error { border-left-color: #f85149; }

/* Commentary extends the original dark command-center theme. */
.message-row.commentary { align-self: flex-start; align-items: flex-start; max-width: min(720px, 88%); }
.commentary-live { display: grid; gap: 6px; padding: 7px 2px 7px 13px; border-left: 2px solid #3d4857; color: #b8c1cc; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.commentary-sequence { width: min(660px, 82vw); max-width: 100%; border: 1px solid #30363d; border-radius: 8px; background: transparent; color: #8b949e; }
.commentary-sequence[open] { background: #0d1117; }
.commentary-sequence.failed { border-color: rgba(248,81,73,.5); }
.commentary-sequence.running { border-color: rgba(210,153,34,.45); }
.commentary-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 11px; cursor: pointer; list-style: none; font-size: 12px; }
.commentary-toggle::-webkit-details-marker { display: none; }
.commentary-toggle strong { color: #c9d1d9; font-weight: 600; }
.commentary-count { color: #8b949e; font-size: 11px; }
.commentary-detail-list { padding: 4px 12px 12px; display: grid; gap: 0; max-height: 300px; overflow-y: auto; }
.commentary-detail-list { border-top: 1px solid #30363d; }
.commentary-detail-list::-webkit-scrollbar { width: 6px; }
.commentary-detail-list::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
.commentary-entry { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 10px; padding: 9px 0; border-top: 1px solid rgba(48,54,61,.72); }
.commentary-entry:first-child { border-top: 0; }
.commentary-entry time { color: #6e7681; font-size: 11px; font-variant-numeric: tabular-nums; }
.commentary-entry span { color: #c9d1d9; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.message-row.live-activity { align-self: flex-start; align-items: stretch; width: min(760px, 90%); max-width: min(760px, 90%); gap: 0; }
.live-activity-line { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 11px; align-items: baseline; padding: 5px 2px; color: #9aa4b0; font-size: 13px; line-height: 1.45; }
.live-activity-kind { color: #6e7681; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.live-activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-activity-line.running .live-activity-text { color: #c9d1d9; }
.live-activity-line.running .live-activity-text::after { content: ""; animation: dots 1.2s steps(4,end) infinite; }
.live-activity-line.failed .live-activity-text { color: #f85149; }
.live-activity-batch { color: #8b949e; }
.live-activity-batch .live-activity-text { font-weight: 500; }
@media (max-width: 980px) { body { overflow: auto; } .shell, .shell.jarvis-mode, .shell.agents-mode, .shell.ops-mode, .shell.topology-mode { grid-template-columns: 1fr; height: auto; min-height: 100vh; } .shell.jarvis-mode .workspace, .shell.agents-mode .workspace, .shell.ops-mode .ops-workspace, .shell.topology-mode .topology-workspace { grid-column: 1; } .command-rail { min-height: auto; } .rail-nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } .rail-agents { grid-column: 1 / -1; grid-template-columns: repeat(2,minmax(0,1fr)); padding-left: 5px; } .side-panel { min-height: 420px; border-right: 0; border-bottom: 1px solid #30363d; } .workspace { min-height: 78vh; } .ops-workspace { min-height: 70vh; } .topology-workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 68vh auto auto; } .topology-toolbar { flex-wrap: wrap; } .topology-toolbar-group { overflow-x: auto; } .topology-health { margin-left: 0; } .topology-inspector { grid-column: 1; grid-row: 3; max-height: none; border-left: 0; border-top: 1px solid #202638; } .topology-timeline { grid-row: 4; } .message-row { max-width: 92%; } .queue-item { grid-template-columns: 76px minmax(0, 1fr); } .queue-item .queue-message, .queue-actions { grid-column: 1 / -1; } }

/* SquadAI product shell */
:root {
  color-scheme: dark;
  --bg: #090a0c;
  --sidebar: #0d0e11;
  --surface: #111216;
  --surface-raised: #17181d;
  --surface-hover: #1b1d23;
  --line: #24262d;
  --line-strong: #31343d;
  --text: #f2f3f5;
  --text-secondary: #a1a6b0;
  --text-muted: #696f7c;
  --accent: #6d7df7;
  --accent-soft: rgba(109,125,247,.12);
  --success: #45cf8c;
  --warning: #e4a853;
  --danger: #f46b72;
}
body { font-size: 13px; color: var(--text); background: var(--bg); }
button { min-height: 36px; padding: 8px 13px; border-color: var(--line); border-radius: 9px; background: var(--accent); box-shadow: none; font-size: 12px; }
button:hover { background: #7b89fa; }
button.secondary { color: var(--text-secondary); background: transparent; border-color: var(--line); }
button.secondary:hover { color: var(--text); border-color: var(--line-strong); background: var(--surface-hover); }
button.danger { color: var(--danger); background: transparent; border-color: var(--line); }
button.danger:hover { color: #ff858b; border-color: rgba(244,107,114,.45); background: rgba(244,107,114,.08); }
.shell, .shell.jarvis-mode, .shell.agents-mode, .shell.ops-mode, .shell.topology-mode, .shell.create-mode { grid-template-columns: 236px minmax(0,1fr); background: var(--bg); }
.command-rail { background: var(--sidebar); border-color: var(--line); }
.brand { min-height: 70px; display: flex; align-items: center; gap: 11px; padding: 15px 17px; border-color: var(--line); }
.brand h1 { color: var(--text); font-size: 14px; font-weight: 680; letter-spacing: -.01em; }
.brand div > span { color: var(--text-muted); font-size: 10px; }
.rail-nav { gap: 2px; padding: 14px 10px; }
.rail-section-label { margin: 8px 10px 5px; color: #565c68; font-size: 9px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.rail-section-label:first-child { margin-top: 0; }
.rail-section-activity { margin-top: 13px; }
.rail-item { min-height: 34px; padding: 7px 10px; border-radius: 7px; color: #858b96; font-size: 12px; font-weight: 520; }
.rail-item:hover { color: var(--text); background: #15171b; }
.rail-item.active { color: var(--text); background: #1a1c22; font-weight: 600; }
.rail-item span { min-width: 19px; padding: 0 6px; color: #727986; background: #17191e; font-size: 10px; }
.rail-create { margin-top: 3px; color: #a9aeb8; border: 1px dashed #282b33; }
.rail-create span { color: #9ba2af; background: transparent; font-size: 15px; }
.rail-agents { gap: 1px; margin: 1px 0 4px; padding: 0 0 7px 8px; border-color: rgba(36,38,45,.7); }
.rail-agent { min-height: 30px; padding: 6px 8px; border-radius: 6px; color: #747b87; font-size: 11px; }
.rail-agent:hover, .rail-agent.active { color: #d8dbe1; background: #15171b; }
.rail-agent.active { box-shadow: inset 2px 0 var(--accent); }
.rail-footer { min-height: 48px; padding: 12px 17px; border-color: var(--line); color: var(--text-muted); font-size: 11px; }
.dot { width: 6px; height: 6px; }

.shell.create-mode .topology-workspace, .shell.create-mode .workspace, .shell.create-mode .ops-workspace { display: none; }
.shell.create-mode .side-panel { display: grid; grid-column: 2; grid-template-rows: auto minmax(0,1fr); min-width: 0; background: var(--bg); border: 0; }
.shell.create-mode #panel-agents { display: none; }
.shell.create-mode .panel-header { min-height: 92px; align-items: center; padding: 20px clamp(28px,5vw,72px); background: var(--bg); border-color: var(--line); }
.shell.create-mode .panel-header h2 { color: var(--text); font-size: 22px; font-weight: 650; letter-spacing: -.03em; }
.shell.create-mode .panel-header p { margin-top: 5px; color: var(--text-secondary); font-size: 12px; }
.shell.create-mode .panel-header #refresh { display: none; }
.shell.create-mode #panel-create { min-height: 0; padding: 30px clamp(28px,5vw,72px) 56px; overflow-y: auto; }
.agent-setup-form { width: min(1040px,100%); display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 18px; margin: 0 auto; }
.setup-card { min-width: 0; padding: 22px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.setup-card > header { display: flex; gap: 12px; margin-bottom: 22px; }
.setup-card > header > span { width: 25px; height: 25px; display: grid; place-items: center; flex: 0 0 auto; color: #9ca6ff; background: var(--accent-soft); border-radius: 7px; font-size: 9px; font-weight: 750; }
.setup-card h3 { margin: 1px 0 3px; color: var(--text); font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
.setup-card header p { margin: 0; color: var(--text-muted); font-size: 11px; }
.setup-card-instructions { grid-column: 1 / -1; }
.setup-grid { display: grid; gap: 13px 14px; }
.setup-grid.two-column { grid-template-columns: repeat(2,minmax(0,1fr)); }
.field-span { grid-column: 1 / -1; }
.label-optional { margin-left: 4px; color: var(--text-muted); font-size: 10px; font-weight: 450; }
.setup-card label { margin: 0; color: #949aa5; font-size: 11px; font-weight: 560; }
.setup-card input, .setup-card textarea, .setup-card select { border-color: var(--line); border-radius: 9px; background: #0c0d10; color: var(--text); }
.setup-card input, .setup-card select { min-height: 40px; }
.setup-card textarea { line-height: 1.55; }
.setup-card input:focus, .setup-card textarea:focus, .setup-card select:focus { border-color: #5968ce; box-shadow: 0 0 0 3px rgba(109,125,247,.1); }
.setup-card .field-hint { margin: -7px 0 0; color: var(--text-muted); }
.setup-card .field-group { margin: 0; }
.setup-card .skill-picker { margin: 0; border-color: var(--line); background: #0c0d10; }
.setup-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 9px; padding-top: 2px; }
.setup-actions button { min-width: 112px; }

.agent-settings-page { padding: 0; background: var(--bg); backdrop-filter: none; }
.agent-settings-page .settings-dialog { width: 100%; height: 100%; max-height: none; grid-template-rows: 82px minmax(0,1fr); border: 0; border-radius: 0; background: var(--bg); box-shadow: none; }
.agent-settings-page .settings-dialog > header { align-items: center; padding: 16px clamp(28px,5vw,72px); border-color: var(--line); }
.agent-settings-page .settings-dialog > header h2 { margin: 2px 0 1px; color: var(--text); font-size: 21px; font-weight: 650; letter-spacing: -.03em; }
.agent-settings-page .settings-dialog > header p { color: var(--text-muted); }
.agent-settings-page .settings-dialog-body { padding: 30px clamp(28px,5vw,72px) 56px; }
.agent-editor-form { width: min(1040px,100%); display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 18px; margin: 0 auto; }
.agent-editor-form .setup-card-instructions, .agent-editor-form .setup-actions { grid-column: 1 / -1; }
.agent-editor-form .agent-actions { justify-content: flex-end; }
.agent-editor-form .agent-actions button { flex: 0 0 auto; min-width: 120px; }

.topology-workspace { grid-template-columns: minmax(0,1fr) 316px; grid-template-rows: 62px minmax(0,1fr) 46px; background: var(--bg); }
.topology-toolbar { gap: 10px; padding: 10px 15px; background: rgba(13,14,17,.96); border-color: var(--line); }
.topology-toolbar-group { gap: 5px; }
.topology-tool { min-height: 32px; padding: 6px 10px; color: #858c99; background: transparent; border-color: transparent; border-radius: 7px; font-size: 11px; }
.topology-tool:hover, .topology-tool.active { color: var(--text); background: var(--surface-hover); border-color: var(--line); }
.topology-tool.primary { color: #fff; background: var(--accent); border-color: transparent; }
.topology-tool:disabled { color: #444953; border-color: transparent; opacity: 1; }
.topology-search-label { max-width: 310px; }
.topology-search-label input { height: 34px; border-color: var(--line); border-radius: 8px; background: #0a0b0e; }
.topology-health { gap: 10px; color: var(--text-muted); font-size: 10px; }
.topology-stage { background: radial-gradient(circle at 50% 44%,#0f121a 0,#090a0e 55%,#07080a 100%); }
.topology-inspector { color: var(--text); background: #0d0e11; border-color: var(--line); }
.topology-inspector header { padding: 21px 20px 17px; border-color: var(--line); }
.topology-inspector header h2 { font-size: 18px; font-weight: 650; }
.topology-inspector section { padding: 17px 20px; border-color: var(--line); }
.topology-inspector footer { padding: 17px 20px 22px; }
.topology-label { padding: 7px 10px; color: #e9ebf0; background: rgba(12,13,17,.9); border-color: rgba(74,79,93,.58); border-radius: 8px; box-shadow: 0 9px 24px rgba(0,0,0,.28); }
.topology-label:hover, .topology-label.selected { background: rgba(20,21,27,.96); border-color: rgba(109,125,247,.9); }
.topology-legend { color: #656c79; background: rgba(10,11,14,.72); border-color: var(--line); }
.topology-view-controls { background: rgba(13,14,17,.9); border-color: var(--line); }
.topology-timeline { padding: 10px 17px; color: #5f6673; background: #0d0e11; border-color: var(--line); }

.workspace { background: var(--bg); }
.topbar { min-height: 70px; padding: 13px 22px; background: rgba(13,14,17,.96); border-color: var(--line); }
.topbar h2 { color: var(--text); font-size: 16px; font-weight: 630; }
.topbar p { max-width: min(760px,62vw); color: var(--text-muted); font-size: 10px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.topbar-actions { gap: 6px; }
.message-list { padding: 30px clamp(24px,7vw,96px); gap: 16px; }
.message-row { max-width: min(760px,76%); }
.message-meta { color: var(--text-muted); font-size: 10px; }
.message-bubble { padding: 11px 14px; border-radius: 12px; line-height: 1.6; }
.message-bubble.user { color: #e9ebf0; background: #1a1c22; border: 1px solid #2a2d35; border-bottom-right-radius: 5px; }
.message-bubble.agent { color: #e2e4e9; background: #131519; border: 1px solid var(--line); border-bottom-left-radius: 5px; }
.composer { width: min(880px,calc(100% - 40px)); margin: 0 auto 20px; border-color: var(--line-strong); border-radius: 15px; background: var(--surface); box-shadow: 0 18px 50px rgba(0,0,0,.22); }
.composer:focus-within { border-color: #4e5bb3; box-shadow: 0 18px 50px rgba(0,0,0,.25),0 0 0 3px rgba(109,125,247,.08); }
.composer textarea { background: transparent; }
.composer-send { color: #fff; background: var(--accent); }
.composer-send:hover { color: #fff; background: #7b89fa; border-color: transparent; }
.ops-workspace { background: var(--bg); }
.ops-header { min-height: 78px; padding: 17px 28px; background: #0d0e11; border-color: var(--line); }
.ops-header h2 { color: var(--text); font-size: 18px; font-weight: 650; }
.ops-body { padding: 22px 32px 40px; }

@media (max-width: 980px) {
  body { overflow: auto; }
  .shell, .shell.jarvis-mode, .shell.agents-mode, .shell.ops-mode, .shell.topology-mode, .shell.create-mode { grid-template-columns: 1fr; height: auto; min-height: 100vh; }
  .command-rail { min-height: auto; }
  .brand { min-height: 58px; }
  .rail-section-label { display: none; }
  .shell.create-mode .side-panel, .shell.jarvis-mode .workspace, .shell.agents-mode .workspace, .shell.ops-mode .ops-workspace, .shell.topology-mode .topology-workspace { grid-column: 1; }
  .agent-setup-form, .agent-editor-form { grid-template-columns: 1fr; }
  .agent-setup-form .setup-card, .agent-editor-form .setup-card, .agent-editor-form .setup-actions { grid-column: 1; }
  .setup-grid.two-column { grid-template-columns: 1fr; }
  .field-span { grid-column: 1; }
  .topology-workspace { grid-template-columns: 1fr; }
  .message-list { padding: 24px 16px; }
}
`;
}

function js(): string {
  return `
let agents = [];
let runners = [];
let selectedAgentId = null;
let events = [];
let eventHasMore = false;
let eventNextBeforeId = null;
let eventLoadingOlder = false;
let sensorEvents = [];
let workItems = [];
let notifications = [];
let compatibilityApprovals = [];
let compatibilitySnapshot = null;
let skillLibrarySnapshot = { library: [], discovered: [], runners: [], errors: [] };
let skillLibraryLoading = false;
const modelCatalogs = new Map();
const modelCatalogRequests = new Map();
const skillCatalogs = new Map();
let pendingMessages = [];
let sendInFlight = false;
let cancelInFlight = false;
let instanceResolutionInFlight = false;
let workspaceCleanupInFlight = false;
let workspaceOpenInFlight = false;
let selectedWorkspaceStatus = null;
let activePanel = "topology";
const previewParams = new URLSearchParams(window.location.search);
const requestedPanel = previewParams.get("panel");
const requestedAgentId = previewParams.get("agent");
const validPanels = ["topology", "jarvis", "agents", "create", "runners", "skills", "notifications", "events", "work"];
if (validPanels.includes(requestedPanel)) activePanel = requestedPanel;
let requestedAgentApplied = false;
let lastAgentListHtml = "";
let lastMessagesHtml = "";
const activityOpenState = new Map();
const activityScrollState = new Map();
let activityInteractionPauseUntil = 0;
const defaultRouterInstructions = [
  "You are the router agent for the multi-agent Codex command center.",
  "Your job is to inspect incoming sensor events and choose the best worker agent.",
  "Do not solve the work yourself.",
  "Do not assign work to yourself.",
  "Use the worker roster provided by the manager as the source of truth for available agents and their capabilities.",
  "Return only a JSON object with targetAgentId, prompt, and reason.",
  "The prompt should be clear, self-contained, and include any important event details the worker needs.",
  "If no worker is a good fit, choose the closest safe worker and explain the uncertainty in reason.",
].join("\\n");

const defaultJarvisInstructions = [
  "You are Jarvis, the human-facing agent for the multi-agent Codex command center.",
  "Your job is to keep the human calmly aware of important agent activity.",
  "When the manager sends command center notifications, summarize them in concise plain English.",
  "Do not investigate the underlying tasks yourself.",
  "Do not approve, decline, route, assign, or execute work unless the human explicitly asks you to.",
  "Tell the human which source agent needs attention so they can open that agent's chat.",
  "If several notifications arrive together, group them into a short status update.",
].join("\\n");

const shell = document.getElementById("shell");
const agentList = document.getElementById("rail-agents");
const messages = document.getElementById("messages");
const selectedTitle = document.getElementById("selected-title");
const selectedMeta = document.getElementById("selected-meta");
const cancelAgentButton = document.getElementById("cancel-agent-button");
const instanceDoneButton = document.getElementById("instance-done-button");
const instanceCancelButton = document.getElementById("instance-cancel-button");
const workspaceCleanupButton = document.getElementById("workspace-cleanup-button");
const workspaceOpenButton = document.getElementById("workspace-open-button");
const connection = document.getElementById("connection");
const connectionDot = document.getElementById("connection-dot");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message");
const composerPermission = document.getElementById("composer-permission");
const composerRuntimeToggle = document.getElementById("composer-runtime-toggle");
const composerRuntimeLabel = document.getElementById("composer-runtime-label");
const composerRuntimeMenu = document.getElementById("composer-runtime-menu");
const composerReasoningView = document.getElementById("composer-reasoning-view");
const composerReasoningOptions = document.getElementById("composer-reasoning-options");
const composerModelViewButton = document.getElementById("composer-model-view-button");
const composerCurrentModel = document.getElementById("composer-current-model");
const composerModelView = document.getElementById("composer-model-view");
const composerModelOptions = document.getElementById("composer-model-options");
const composerRuntimeBack = document.getElementById("composer-runtime-back");
const agentCount = document.getElementById("agent-count");
const runnerCount = document.getElementById("runner-count");
const notificationCount = document.getElementById("notification-count");
const eventCount = document.getElementById("event-count");
const workCount = document.getElementById("work-count");
const notificationPanelCount = document.getElementById("notification-panel-count");
const eventPanelCount = document.getElementById("event-panel-count");
const workPanelCount = document.getElementById("work-panel-count");
const compatibilityHealth = document.getElementById("compatibility-health");
const notificationList = document.getElementById("notifications-list");
const sensorEventList = document.getElementById("sensor-events");
const workItemList = document.getElementById("work-items");
const runnersList = document.getElementById("runners-list");
const skillLibrary = document.getElementById("skill-library");
const toasts = document.getElementById("toasts");
const agentNameInput = document.getElementById("agent-name");
const agentIdInput = document.getElementById("agent-id");
const agentIdHint = document.getElementById("agent-id-hint");
const editAgentForm = document.getElementById("edit-agent-form");
const editAgentStatus = document.getElementById("edit-agent-status");
const deleteAgentButton = document.getElementById("delete-agent-button");
const agentSettingsModal = document.getElementById("agent-settings-modal");
const agentSettingsTitle = document.getElementById("agent-settings-title");
const closeAgentSettingsButton = document.getElementById("close-agent-settings");
const runnerEnrollmentModal = document.getElementById("runner-enrollment-modal");
const runnerEnrollmentStatus = document.getElementById("runner-enrollment-status");
const runnerEnrollmentApproval = document.getElementById("runner-enrollment-approval");
const runnerEnrollmentResult = document.getElementById("runner-enrollment-result");
const runnerEnrollmentCommand = document.getElementById("runner-enrollment-command");
const runnerEnrollmentExpiry = document.getElementById("runner-enrollment-expiry");
const remoteDirectoryModal = document.getElementById("remote-directory-modal");
const remoteDirectoryRunner = document.getElementById("remote-directory-runner");
const remoteDirectoryPathForm = document.getElementById("remote-directory-path-form");
const remoteDirectoryPath = document.getElementById("remote-directory-path");
const remoteDirectoryStatus = document.getElementById("remote-directory-status");
const remoteDirectoryList = document.getElementById("remote-directory-list");
const remoteDirectoryHome = document.getElementById("remote-directory-home");
const remoteDirectoryUp = document.getElementById("remote-directory-up");
const remoteDirectorySelect = document.getElementById("remote-directory-select");
const panelTitle = document.getElementById("panel-title");
const panelSubtitle = document.getElementById("panel-subtitle");
const opsTitle = document.getElementById("ops-title");
const opsSubtitle = document.getElementById("ops-subtitle");
const opsCount = document.getElementById("ops-count");
const opsRefresh = document.getElementById("ops-refresh");
let agentIdTouched = false;
let createInstructionsTouched = false;
let editAgentLoadedId = null;
let editAgentDirty = false;
let composerAgentId = null;
let forceLatestMessage = true;
let remoteDirectoryTargetForm = null;
let remoteDirectoryRunnerId = null;
let remoteDirectoryListing = null;

document.getElementById("refresh").addEventListener("click", refresh);
opsRefresh.addEventListener("click", () => activePanel === "skills" ? refreshSkillLibrary() : refresh());
function openRunnerEnrollment() {
  runnerEnrollmentResult.hidden = true;
  runnerEnrollmentApproval.hidden = true;
  runnerEnrollmentStatus.textContent = "";
  runnerEnrollmentModal.hidden = false;
}
document.getElementById("topology-add-runner").addEventListener("click", openRunnerEnrollment);
document.getElementById("runner-enrollment-close").addEventListener("click", () => {
  runnerEnrollmentModal.hidden = true;
});
runnerEnrollmentModal.addEventListener("click", (event) => {
  if (event.target === runnerEnrollmentModal) runnerEnrollmentModal.hidden = true;
});
document.getElementById("runner-enrollment-generate").addEventListener("click", async () => {
  const button = document.getElementById("runner-enrollment-generate");
  try {
    button.disabled = true;
    runnerEnrollmentApproval.hidden = true;
    runnerEnrollmentStatus.textContent = "Checking Tailscale and creating a private connection…";
    const response = await fetch("/api/runner-enrollments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    if (!response.ok) {
      if (body.approvalUrl) {
        runnerEnrollmentApproval.href = body.approvalUrl;
        runnerEnrollmentApproval.hidden = false;
        window.open(body.approvalUrl, "_blank", "noopener");
      }
      throw new Error(body.error || "Could not create runner enrollment");
    }
    runnerEnrollmentCommand.value = body.command;
    runnerEnrollmentExpiry.textContent = "One-time command · expires " + new Date(body.expiresAt).toLocaleTimeString();
    runnerEnrollmentStatus.textContent = "Private connection ready at " + body.controlUrl;
    runnerEnrollmentResult.hidden = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runnerEnrollmentStatus.textContent = message;
    toast(message, "error");
  } finally {
    button.disabled = false;
  }
});
document.getElementById("runner-enrollment-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(runnerEnrollmentCommand.value);
    toast("Runner command copied");
  } catch {
    runnerEnrollmentCommand.focus();
    runnerEnrollmentCommand.select();
    toast("Select and copy the runner command");
  }
});
for (const button of document.querySelectorAll("[data-panel]")) {
  button.addEventListener("click", () => {
    const previousPanel = activePanel;
    activePanel = button.dataset.panel || "agents";
    if (previousPanel !== activePanel) {
      lastMessagesHtml = "";
      if (activePanel === "agents" || activePanel === "jarvis") forceLatestMessage = true;
    }
    render();
    if (activePanel === "agents" || activePanel === "jarvis") void refreshEvents().then(render);
    if (activePanel === "skills") void refreshSkillLibrary();
  });
}
window.addEventListener("topology:open-agent", (event) => {
  const agentId = event.detail && event.detail.agentId;
  if (!agentId) return;
  selectedAgentId = agentId;
  activePanel = "agents";
  lastMessagesHtml = "";
  forceLatestMessage = true;
  editAgentDirty = false;
  render();
  void refreshEvents().then(render);
});
window.addEventListener("topology:edit-agent", (event) => {
  const agentId = event.detail && event.detail.agentId;
  const selected = agents.find((agent) => agent.id === agentId);
  if (!selected) return;
  selectedAgentId = agentId;
  editAgentDirty = false;
  editAgentLoadedId = null;
  renderAgentEditor(selected);
  agentSettingsModal.hidden = false;
});
window.addEventListener("topology:refresh-main", () => {
  void refresh();
});
const agentForm = document.getElementById("agent-form");
const createRoleSelect = agentForm.elements.role;
const createInstructionsInput = agentForm.elements.instructions;
const createModelInput = agentForm.elements.model;
agentForm.addEventListener("submit", createAgent);
agentForm.addEventListener("input", (event) => {
  if (event.target === createInstructionsInput) {
    createInstructionsTouched = true;
  }
});
createRoleSelect.addEventListener("change", applyCreateRoleDefaults);
createModelInput.addEventListener("change", renderModelControls);
for (const select of document.querySelectorAll("[data-runner-select]")) {
  select.addEventListener("change", () => {
    void refreshModelOptions(select.value || "local");
    const form = select.closest("form");
    if (form?.elements.skillMode?.value === "selected") void loadSkillOptions(form, [], true);
  });
}
setupSkillPicker(agentForm);
setupSkillPicker(editAgentForm);
setupDirectoryBrowse(agentForm);
setupDirectoryBrowse(editAgentForm);
editAgentForm.addEventListener("submit", updateSelectedAgent);
editAgentForm.addEventListener("input", () => {
  editAgentDirty = true;
});
editAgentForm.elements.model.addEventListener("change", renderModelControls);
deleteAgentButton.addEventListener("click", deleteSelectedAgent);
closeAgentSettingsButton.addEventListener("click", closeAgentSettings);
document.getElementById("remote-directory-close").addEventListener("click", closeRemoteDirectoryPicker);
document.getElementById("remote-directory-cancel").addEventListener("click", closeRemoteDirectoryPicker);
remoteDirectoryModal.addEventListener("click", (event) => {
  if (event.target === remoteDirectoryModal) closeRemoteDirectoryPicker();
});
remoteDirectoryPathForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void navigateRemoteDirectory(remoteDirectoryPath.value);
});
remoteDirectoryHome.addEventListener("click", () => {
  if (remoteDirectoryListing?.homePath) void navigateRemoteDirectory(remoteDirectoryListing.homePath);
});
remoteDirectoryUp.addEventListener("click", () => {
  if (remoteDirectoryListing?.parentPath) void navigateRemoteDirectory(remoteDirectoryListing.parentPath);
});
remoteDirectorySelect.addEventListener("click", selectRemoteDirectory);
agentSettingsModal.addEventListener("click", (event) => {
  if (event.target === agentSettingsModal) closeAgentSettings();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !agentSettingsModal.hidden) closeAgentSettings();
  if (event.key === "Escape" && !composerRuntimeMenu.hidden) closeComposerRuntimeMenu();
});
cancelAgentButton.addEventListener("click", cancelSelectedAgent);
instanceDoneButton.addEventListener("click", () => resolveSelectedInstance("done"));
instanceCancelButton.addEventListener("click", () => resolveSelectedInstance("cancelled"));
workspaceCleanupButton.addEventListener("click", cleanupSelectedWorkspace);
workspaceOpenButton.addEventListener("click", openSelectedWorkspace);
messageForm.addEventListener("submit", sendMessage);
composerPermission.addEventListener("change", () => void updatePermissionFromComposer());
composerRuntimeToggle.addEventListener("click", toggleComposerRuntimeMenu);
composerModelViewButton.addEventListener("click", () => setComposerRuntimeView("model"));
composerRuntimeBack.addEventListener("click", () => setComposerRuntimeView("reasoning"));
document.addEventListener("pointerdown", (event) => {
  if (!composerRuntimeMenu.hidden && !event.target.closest(".composer-runtime")) closeComposerRuntimeMenu();
});
agentNameInput.addEventListener("input", updateDerivedAgentId);
agentIdInput.addEventListener("input", () => {
  agentIdTouched = true;
  updateDerivedAgentId();
});
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    messageForm.requestSubmit();
  }
});
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + "px";
});
window.addEventListener("pageshow", () => {
  activePanel = validPanels.includes(requestedPanel) ? requestedPanel : "topology";
  lastMessagesHtml = "";
  render();
}, { once: true });

const stream = new EventSource("/api/events/stream");
stream.onopen = () => {
  connection.textContent = "Live";
  connectionDot.classList.add("connected");
};
stream.onerror = () => {
  connection.textContent = "Reconnecting";
  connectionDot.classList.remove("connected");
};
stream.addEventListener("agent-event", (message) => {
  const event = JSON.parse(message.data);
  if (!selectedAgentId || event.agentId === selectedAgentId) events.push(event);
  void refreshAgents();
  void refreshQueues();
  void refreshNotifications();
  render();
});
stream.addEventListener("runner-event", (message) => {
  const runner = JSON.parse(message.data);
  const previous = runners.find((item) => item.id === runner.id);
  runners = [...runners.filter((item) => item.id !== runner.id), runner]
    .sort((left, right) => left.name.localeCompare(right.name));
  renderRunnerOptions();
  renderRunners();
  if (!previous && runner.status === "online") {
    toast(runner.name + " connected");
  } else if (previous && previous.status !== runner.status) {
    toast(runner.name + (runner.status === "online" ? " reconnected" : " went offline"), runner.status === "online" ? "info" : "error");
  }
  render();
});

async function refresh() {
  await Promise.all([refreshAgents(), refreshRunners()]);
  const selectedRunnerId = agents.find((agent) => agent.id === selectedAgentId)?.runnerId || "local";
  const runnerCatalogs = new Set(["local", selectedRunnerId]);
  await Promise.all([
    refreshEvents(),
    refreshQueues(),
    refreshNotifications(),
    ...Array.from(runnerCatalogs, (runnerId) => refreshModelOptions(runnerId)),
    ...(activePanel === "skills" ? [refreshSkillLibrary(false)] : []),
  ]);
  render();
}

async function refreshRunners() {
  const response = await fetch("/api/runners");
  if (!response.ok) return;
  const body = await response.json();
  runners = Array.isArray(body.runners) ? body.runners : [];
  renderRunnerOptions();
  renderRunners();
}

function renderRunnerOptions() {
  for (const select of document.querySelectorAll("[data-runner-select]")) {
    const current = select.value || "local";
    select.innerHTML = '<option value="local">This machine</option>' + runners.map((runner) =>
      '<option value="' + escapeAttr(runner.id) + '">' + escapeHtml(runner.name)
      + ' · ' + escapeHtml(runner.status) + ' · ' + escapeHtml(runner.hostname) + '</option>'
    ).join("");
    select.value = Array.from(select.options).some((option) => option.value === current) ? current : "local";
  }
}

function renderRunners() {
  if (!runnersList) return;
  if (runnerCount) runnerCount.textContent = String(runners.length + 1);
  const localAgentCount = agents.filter((agent) => !agent.runnerId || agent.runnerId === "local").length;
  const localCard = renderRunnerCard({
    id: "local",
    name: "This machine",
    status: "online",
    hostname: "Control plane host",
    platform: "local",
    arch: "current",
    version: "0.1.0",
    activeCommands: agents.filter((agent) => (!agent.runnerId || agent.runnerId === "local") && agent.status === "running").length,
    lastSeenAt: new Date().toISOString(),
  }, localAgentCount, true);
  const remoteCards = runners.map((runner) => {
    const assigned = agents.filter((agent) => agent.runnerId === runner.id).length;
    return renderRunnerCard(runner, assigned, false);
  }).join("");
  runnersList.innerHTML = '<section class="runner-overview">'
    + '<div class="runner-overview-header"><p>Machines available to run SquadAI agents.</p><button type="button" data-runner-add>Add runner</button></div>'
    + '<div class="runner-grid">' + localCard + remoteCards + '</div>'
    + '</section>';
  runnersList.querySelector("[data-runner-add]")?.addEventListener("click", openRunnerEnrollment);
  if (activePanel === "runners") updateOpsCount();
}

function renderRunnerCard(runner, assignedAgents, local) {
  const platform = local ? "Control plane" : runnerPlatformLabel(runner.platform) + " · " + (runner.arch || "unknown");
  const lastSeen = local ? "Now" : formatShortTime(runner.lastSeenAt) || "Unknown";
  return '<article class="runner-card">'
    + '<header><div><h3>' + escapeHtml(runner.name) + '</h3><p>' + escapeHtml(runner.hostname || runner.id) + '</p></div>'
    + '<span class="runner-state ' + escapeAttr(runner.status) + '">' + escapeHtml(runner.status) + '</span></header>'
    + '<dl>'
    + '<div><dt>Agents</dt><dd>' + escapeHtml(String(assignedAgents)) + '</dd></div>'
    + '<div><dt>Active work</dt><dd>' + escapeHtml(String(runner.activeCommands || 0)) + '</dd></div>'
    + '<div><dt>System</dt><dd title="' + escapeAttr(platform) + '">' + escapeHtml(platform) + '</dd></div>'
    + '<div><dt>Last seen</dt><dd>' + escapeHtml(lastSeen) + '</dd></div>'
    + '<div><dt>Runner ID</dt><dd title="' + escapeAttr(runner.id) + '">' + escapeHtml(runner.id) + '</dd></div>'
    + '<div><dt>Version</dt><dd>' + escapeHtml(runner.version || "unknown") + '</dd></div>'
    + '</dl></article>';
}

function runnerPlatformLabel(platform) {
  return ({ win32: "Windows", darwin: "macOS", linux: "Linux" })[platform] || platform || "Unknown";
}

async function refreshModelOptions(runnerId = "local") {
  const key = runnerId || "local";
  if (modelCatalogRequests.has(key)) return modelCatalogRequests.get(key);
  const request = (async () => {
    const response = await fetch("/api/model-options?runnerId=" + encodeURIComponent(key));
    if (!response.ok) return;
    const body = await response.json();
    modelCatalogs.set(key, Array.isArray(body.models) ? body.models : []);
    renderModelControls();
  })();
  modelCatalogRequests.set(key, request);
  try {
    await request;
  } finally {
    modelCatalogRequests.delete(key);
  }
}

async function refreshAgents() {
  const response = await fetch("/api/agents");
  const body = await response.json();
  agents = body.agents;
  if (!requestedAgentApplied && requestedAgentId && agents.some((agent) => agent.id === requestedAgentId)) {
    selectedAgentId = requestedAgentId;
    requestedAgentApplied = true;
    forceLatestMessage = true;
  } else if (activePanel === "jarvis") {
    selectedAgentId = jarvisAgent()?.id || null;
  } else if (!selectedAgentId && agents.length) {
    selectedAgentId = agents[0].id;
    forceLatestMessage = true;
  }
  agentCount.textContent = String(agents.length);
}

function jarvisAgent() {
  return agents.find((agent) => agent.metadata?.role === "jarvis")
    || agents.find((agent) => agent.id.toLowerCase() === "jarvis")
    || agents.find((agent) => agent.name.toLowerCase() === "jarvis")
    || null;
}

function upsertAgent(agent) {
  const index = agents.findIndex((item) => item.id === agent.id);
  if (index >= 0) {
    agents[index] = agent;
  } else {
    agents = [...agents, agent];
  }
  lastAgentListHtml = "";
  agentCount.textContent = String(agents.length);
}

function renderModelControls() {
  updateModelSelect(agentForm);
  updateModelSelect(editAgentForm);
  updateModelDependentSelects(agentForm);
  updateModelDependentSelects(editAgentForm);
  syncComposerControls(agents.find((agent) => agent.id === selectedAgentId) || null, true);
}

function modelOptionsForRunner(runnerId) {
  return modelCatalogs.get(runnerId || "local") || [];
}

function modelOptionsForForm(form) {
  return modelOptionsForRunner(String(form.elements.runnerId?.value || "local"));
}

function updateModelSelect(form) {
  const select = form.elements.model;
  const modelOptions = modelOptionsForForm(form);
  const current = select.value;
  select.innerHTML = '<option value="">Default Codex model</option>' + modelOptions.map((model) => {
    const value = model.model || model.id || "";
    const label = model.displayName || value;
    return \`<option value="\${escapeAttr(value)}">\${escapeHtml(label)}</option>\`;
  }).join("");
  select.value = modelOptions.some((model) => model.model === current || model.id === current) ? current : "";
}

function updateModelDependentSelects(form) {
  const selectedModel = selectedModelForForm(form);
  updateReasoningSelect(form.elements.reasoningEffort, selectedModel);
  updateServiceTierSelect(form.elements.serviceTier, selectedModel);
}

function selectedModelForForm(form) {
  const modelOptions = modelOptionsForForm(form);
  const requested = String(form.elements.model.value || "").trim();
  if (!requested) {
    return modelOptions.find((model) => model.isDefault) || null;
  }
  return modelOptions.find((model) => model.model === requested || model.id === requested) || null;
}

function updateReasoningSelect(select, model) {
  const current = select.value;
  const efforts = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
    : [];
  select.innerHTML = '<option value="">Default</option>' + efforts.map((effort) => {
    const value = effort.reasoningEffort || "";
    const description = effort.description ? " - " + effort.description : "";
    return \`<option value="\${escapeAttr(value)}">\${escapeHtml(value + description)}</option>\`;
  }).join("");
  select.value = efforts.some((effort) => effort.reasoningEffort === current) ? current : "";
}

function updateServiceTierSelect(select, model) {
  const current = select.value;
  const serviceTiers = serviceTierOptions(model);
  select.innerHTML = '<option value="">Default</option>' + serviceTiers.map((tier) => {
    const label = tier.description ? \`\${tier.name || tier.id} - \${tier.description}\` : (tier.name || tier.id);
    return \`<option value="\${escapeAttr(tier.id)}">\${escapeHtml(label)}</option>\`;
  }).join("");
  select.value = serviceTiers.some((tier) => tier.id === current) ? current : "";
}

function serviceTierOptions(model) {
  if (!model) return [];
  if (Array.isArray(model.serviceTiers) && model.serviceTiers.length) {
    return model.serviceTiers;
  }
  if (Array.isArray(model.additionalSpeedTiers)) {
    return model.additionalSpeedTiers.map((tier) => ({
      id: String(tier),
      name: String(tier),
      description: "",
    }));
  }
  return [];
}

async function refreshEvents() {
  const params = new URLSearchParams({ limit: "500" });
  if (selectedAgentId) params.set("agentId", selectedAgentId);
  const selectedAtRequest = selectedAgentId;
  const [response, workspaceResponse] = await Promise.all([
    fetch("/api/events?" + params.toString()),
    selectedAtRequest
      ? fetch("/api/agents/" + encodeURIComponent(selectedAtRequest) + "/workspace")
      : Promise.resolve(null),
  ]);
  const body = await response.json();
  events = Array.isArray(body.events) ? body.events : [];
  eventHasMore = Boolean(body.hasMore);
  eventNextBeforeId = body.nextBeforeId ?? null;
  if (workspaceResponse && selectedAgentId === selectedAtRequest) {
    const workspaceBody = await workspaceResponse.json();
    selectedWorkspaceStatus = workspaceResponse.ok
      ? { agentId: selectedAtRequest, workspace: workspaceBody.workspace }
      : null;
  } else if (!selectedAtRequest) {
    selectedWorkspaceStatus = null;
  }
}

async function loadOlderEvents() {
  if (eventLoadingOlder || !eventHasMore || eventNextBeforeId === null) return;
  const requestedAgentId = selectedAgentId;
  eventLoadingOlder = true;
  render();
  const previousHeight = messages.scrollHeight;
  try {
    const params = new URLSearchParams({
      limit: "500",
      beforeId: String(eventNextBeforeId),
    });
    if (requestedAgentId) params.set("agentId", requestedAgentId);
    const response = await fetch("/api/events?" + params.toString());
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load older history");
    if (selectedAgentId !== requestedAgentId) {
      eventLoadingOlder = false;
      return;
    }
    const olderEvents = Array.isArray(body.events) ? body.events : [];
    events = [...olderEvents, ...events];
    eventHasMore = Boolean(body.hasMore);
    eventNextBeforeId = body.nextBeforeId ?? null;
    eventLoadingOlder = false;
    render();
    requestAnimationFrame(() => {
      messages.scrollTop += messages.scrollHeight - previousHeight;
    });
  } catch (error) {
    if (selectedAgentId !== requestedAgentId) {
      eventLoadingOlder = false;
      return;
    }
    eventLoadingOlder = false;
    render();
    toast(error instanceof Error ? error.message : String(error), "error");
  }
}

async function refreshQueues() {
  const [sensorResponse, workResponse] = await Promise.all([
    fetch("/api/sensor-events"),
    fetch("/api/work-items"),
  ]);
  const sensorBody = await sensorResponse.json();
  const workBody = await workResponse.json();
  sensorEvents = sensorBody.events;
  workItems = workBody.workItems;
  workCount.textContent = String(workItems.length);
  if (workPanelCount) workPanelCount.textContent = String(workItems.length);
  renderQueues();
}

async function refreshNotifications() {
  const [response, compatibilityResponse] = await Promise.all([
    fetch("/api/notifications"),
    fetch("/api/compatibility"),
  ]);
  const body = await response.json();
  const compatibilityBody = await compatibilityResponse.json();
  notifications = body.notifications;
  compatibilityApprovals = Array.isArray(compatibilityBody.approvals) ? compatibilityBody.approvals : [];
  compatibilitySnapshot = compatibilityBody.snapshot || null;
  if (compatibilityHealth) {
    const defaultModel = compatibilitySnapshot?.catalog?.models?.find((model) => model.isDefault);
    compatibilityHealth.textContent = compatibilitySnapshot
      ? "Default: " + (defaultModel?.displayName || defaultModel?.model || "Codex")
      : "Catalog checks on demand";
    compatibilityHealth.title = compatibilitySnapshot?.codexVersion
      ? compatibilitySnapshot.codexVersion
        + (compatibilitySnapshot.binaryPath ? " · " + compatibilitySnapshot.binaryPath : "")
        + " · checked " + compatibilitySnapshot.fetchedAt
      : "Codex compatibility catalog refreshes before pinned agents start";
  }
  renderNotifications();
}

async function createAgent(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  applySkillSelection(body, event.currentTarget);
  applyRoleMetadata(body);
  if (!confirmFullAccess(body)) return;
  const button = document.getElementById("create-agent-button");
  button.disabled = true;
  button.textContent = "Creating";
  const response = await fetch("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  button.disabled = false;
  button.textContent = "Create Agent";
  if (!response.ok) {
    toast(result.error || "Failed to create agent", "error");
    return;
  }
  upsertAgent(result.agent);
  selectedAgentId = result.agent.id;
  lastMessagesHtml = "";
  forceLatestMessage = true;
  activePanel = result.agent.metadata?.role === "jarvis" ? "jarvis" : "agents";
  editAgentDirty = false;
  editAgentLoadedId = null;
  event.currentTarget.reset();
  agentIdTouched = false;
  createInstructionsTouched = false;
  updateDerivedAgentId();
  applyCreateRoleDefaults();
  renderModelControls();
  updateSkillPickerVisibility(agentForm);
  await refreshAgents();
  await refreshEvents();
  render();
  toast("Agent created");
}

function applyCreateRoleDefaults() {
  const defaultInstructions = defaultInstructionsForRole(createRoleSelect.value);
  if (defaultInstructions) {
    if (!createInstructionsTouched || !createInstructionsInput.value.trim()) {
      createInstructionsInput.value = defaultInstructions;
      createInstructionsTouched = false;
    }
    return;
  }
  if (
    !createInstructionsTouched &&
    (createInstructionsInput.value === defaultRouterInstructions || createInstructionsInput.value === defaultJarvisInstructions)
  ) {
    createInstructionsInput.value = "";
  }
}

function defaultInstructionsForRole(role) {
  if (role === "router") return defaultRouterInstructions;
  if (role === "jarvis") return defaultJarvisInstructions;
  return "";
}

function applyRoleMetadata(body, existingMetadata = {}, forceMetadata = false) {
  const metadata = { ...existingMetadata };
  delete metadata.role;
  delete metadata.routingDescription;
  if (body.role) {
    metadata.role = body.role;
  }
  if (body.routingDescription) {
    metadata.routingDescription = body.routingDescription;
  }
  if (Object.keys(metadata).length || forceMetadata) {
    body.metadata = metadata;
  }
  delete body.role;
  delete body.routingDescription;
}

function applySkillSelection(body, form) {
  body.skillMode = form.elements.skillMode.value || "all";
  body.allowedSkills = body.skillMode === "selected"
    ? Array.from(form.querySelectorAll("[data-skill-checkbox]:checked")).map((input) => ({
        name: input.dataset.skillName,
        scope: input.dataset.skillScope,
      }))
    : [];
}

function confirmFullAccess(body, currentAgent = null) {
  if (body.permissionMode !== "full-access" || permissionModeForAgent(currentAgent || {}) === "full-access") {
    return true;
  }
  return window.confirm("Enable full access? This agent can edit any file and run commands with network access without approval.");
}

async function updateSelectedAgent(event) {
  event.preventDefault();
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  if (!selected) return;
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  applySkillSelection(body, event.currentTarget);
  applyRoleMetadata(body, selected.metadata || {}, true);
  if (!confirmFullAccess(body, selected)) return;
  const response = await fetch("/api/agents/" + encodeURIComponent(selected.id), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    toast(result.error || "Failed to update agent", "error");
    return;
  }
  upsertAgent(result.agent);
  editAgentDirty = false;
  editAgentLoadedId = null;
  await refreshAgents();
  await refreshEvents();
  render();
  closeAgentSettings();
  toast(result.agent.threadId ? "Agent updated" : "Agent updated; next turn starts fresh");
}

async function deleteSelectedAgent() {
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  if (!selected) return;
  if (!window.confirm("Delete agent " + selected.name + "? Completed history stays in events, but the agent will be removed.")) {
    return;
  }
  const response = await fetch("/api/agents/" + encodeURIComponent(selected.id), {
    method: "DELETE",
  });
  const result = await response.json();
  if (!response.ok) {
    toast(result.error || "Failed to delete agent", "error");
    return;
  }
  agents = agents.filter((agent) => agent.id !== selected.id);
  selectedAgentId = agents[0]?.id || null;
  closeAgentSettings();
  forceLatestMessage = true;
  lastAgentListHtml = "";
  lastMessagesHtml = "";
  editAgentDirty = false;
  editAgentLoadedId = null;
  await refreshAgents();
  await refreshEvents();
  render();
  toast("Agent deleted");
}

async function cancelSelectedAgent() {
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  if (!selected || selected.status !== "running" || cancelInFlight) return;
  cancelInFlight = true;
  render();
  try {
    const response = await fetch("/api/agents/" + encodeURIComponent(selected.id) + "/cancel", {
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok) {
      toast(result.error || "Cancel failed", "error");
      return;
    }
    toast("Interrupt requested");
    await refresh();
  } finally {
    cancelInFlight = false;
    render();
  }
}

async function resolveSelectedInstance(resolution) {
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  if (!selected || typeof selected.metadata?.instanceOfAgentId !== "string" || instanceResolutionInFlight) return;
  instanceResolutionInFlight = true;
  render();
  try {
    const response = await fetch("/api/agents/" + encodeURIComponent(selected.id) + "/instance/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution }),
    });
    const result = await response.json();
    if (!response.ok) {
      toast(result.error || "Could not resolve task instance", "error");
      return;
    }
    toast(resolution === "done" ? "Task marked done" : "Task cancelled");
    await refresh();
  } finally {
    instanceResolutionInFlight = false;
    render();
  }
}

async function cleanupSelectedWorkspace() {
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  if (!selected || workspaceCleanupInFlight) return;
  const confirmed = window.confirm(
    "Remove this clean worktree? The Git branch will be preserved. Dirty worktrees are never removed.",
  );
  if (!confirmed) return;
  workspaceCleanupInFlight = true;
  render();
  try {
    const response = await fetch("/api/agents/" + encodeURIComponent(selected.id) + "/workspace", {
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok) {
      toast(result.error || "Could not clean up worktree", "error");
      return;
    }
    toast("Worktree removed; branch preserved");
    await refresh();
  } finally {
    workspaceCleanupInFlight = false;
    render();
  }
}

async function openSelectedWorkspace() {
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  if (!selected || workspaceOpenInFlight) return;
  workspaceOpenInFlight = true;
  render();
  try {
    const response = await fetch("/api/agents/" + encodeURIComponent(selected.id) + "/workspace/open", {
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok) {
      toast(result.error || "Could not open worktree", "error");
      return;
    }
    toast("Opened worktree in VS Code");
  } finally {
    workspaceOpenInFlight = false;
    render();
  }
}

function deriveAgentId(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function updateDerivedAgentId() {
  const derived = deriveAgentId(agentNameInput.value);
  if (!agentIdTouched) {
    agentIdInput.value = derived;
  }
  agentIdHint.textContent = derived
    ? "Stable ID: " + (agentIdInput.value.trim() || derived)
    : "Used in API paths and state. Leave empty to derive from name.";
}

async function sendMessage(event) {
  event.preventDefault();
  if (!selectedAgentId) return;
  const textarea = messageInput;
  const message = textarea.value.trim();
  if (!message) return;
  textarea.value = "";
  textarea.style.height = "auto";
  const pending = {
    id: String(Date.now()) + "-" + Math.random().toString(16).slice(2),
    agentId: selectedAgentId,
    text: message,
    createdAt: Date.now(),
  };
  pendingMessages.push(pending);
  sendInFlight = true;
  render();
  scrollDown();
  toast("Message sent");
  const allowNetwork = document.getElementById("allow-network").checked;
  const response = await fetch("/api/agents/" + encodeURIComponent(selectedAgentId) + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, options: { network: allowNetwork ? "allow" : "deny" } }),
  });
  const result = await response.json();
  pendingMessages = pendingMessages.filter((item) => item.id !== pending.id);
  sendInFlight = false;
  if (!response.ok) {
    toast(result.error || "Send failed", "error");
  }
  await refresh();
}

async function updatePermissionFromComposer() {
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  if (!selected) return;
  const body = { permissionMode: composerPermission.value };
  if (!confirmFullAccess(body, selected)) {
    syncComposerControls(selected, true);
    return;
  }
  await updateAgentFromComposer(body);
}

async function updateModelFromComposer(modelValue) {
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  if (!selected) return;
  const modelOptions = modelOptionsForRunner(selected.runnerId);
  const selectedModel = modelOptions.find((model) => model.model === modelValue || model.id === modelValue)
    || modelOptions.find((model) => model.isDefault)
    || null;
  const supported = Array.isArray(selectedModel?.supportedReasoningEfforts)
    ? selectedModel.supportedReasoningEfforts.map((effort) => effort.reasoningEffort)
    : [];
  const reasoningEffort = supported.includes(selected.reasoningEffort)
    ? selected.reasoningEffort
    : (selectedModel?.defaultReasoningEffort || "");
  closeComposerRuntimeMenu();
  await updateAgentFromComposer({
    model: modelValue,
    reasoningEffort,
  });
}

async function updateReasoningFromComposer(reasoningEffort) {
  closeComposerRuntimeMenu();
  await updateAgentFromComposer({ reasoningEffort });
}

async function updateAgentFromComposer(body) {
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  if (!selected || selected.status === "running" || selected.status === "starting") {
    syncComposerControls(selected || null, true);
    return;
  }
  messageForm.classList.add("updating");
  setComposerDisabled(true);
  const response = await fetch("/api/agents/" + encodeURIComponent(selected.id), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  messageForm.classList.remove("updating");
  if (!response.ok) {
    toast(result.error || "Could not update agent settings", "error");
    syncComposerControls(selected, true);
    return;
  }
  upsertAgent(result.agent);
  editAgentDirty = false;
  composerAgentId = null;
  render();
  toast("Agent settings updated");
}

function setComposerDisabled(disabled) {
  composerPermission.disabled = disabled;
  composerRuntimeToggle.disabled = disabled;
  if (disabled) closeComposerRuntimeMenu();
}

function syncComposerControls(selected, force = false) {
  const unavailable = !selected || selected.status === "running" || selected.status === "starting";
  setComposerDisabled(unavailable);
  if (!selected) {
    composerAgentId = null;
    composerPermission.value = "ask";
    composerRuntimeLabel.textContent = "Default · Default";
    composerReasoningOptions.innerHTML = "";
    composerModelOptions.innerHTML = "";
    return;
  }
  const runnerId = selected.runnerId || "local";
  if (!modelCatalogs.has(runnerId) && !modelCatalogRequests.has(runnerId)) {
    void refreshModelOptions(runnerId);
  }
  if (!force && composerAgentId === selected.id) return;
  composerAgentId = selected.id;
  composerPermission.value = permissionModeForAgent(selected);
  renderComposerRuntimeMenu(selected);
}

function toggleComposerRuntimeMenu() {
  if (composerRuntimeToggle.disabled) return;
  const opening = composerRuntimeMenu.hidden;
  if (opening) {
    const selected = agents.find((agent) => agent.id === selectedAgentId);
    if (!selected) return;
    renderComposerRuntimeMenu(selected);
    setComposerRuntimeView("reasoning");
  }
  composerRuntimeMenu.hidden = !opening;
  composerRuntimeToggle.setAttribute("aria-expanded", String(opening));
}

function closeComposerRuntimeMenu() {
  composerRuntimeMenu.hidden = true;
  composerRuntimeToggle.setAttribute("aria-expanded", "false");
  setComposerRuntimeView("reasoning");
}

function setComposerRuntimeView(view) {
  composerReasoningView.hidden = view === "model";
  composerModelView.hidden = view !== "model";
}

function renderComposerRuntimeMenu(selected) {
  const modelOptions = modelOptionsForRunner(selected.runnerId);
  const selectedModel = modelOptions.find((model) => model.model === selected.model || model.id === selected.model)
    || modelOptions.find((model) => model.isDefault)
    || null;
  const modelName = modelDisplayName(selectedModel) || selected.model || "Default";
  const reasoningEffort = selected.reasoningEffort || selectedModel?.defaultReasoningEffort || "";
  composerRuntimeLabel.textContent = modelName + " · " + reasoningDisplayName(reasoningEffort || "default");
  composerCurrentModel.textContent = modelName;

  const efforts = Array.isArray(selectedModel?.supportedReasoningEfforts) && selectedModel.supportedReasoningEfforts.length
    ? selectedModel.supportedReasoningEfforts
    : ["low", "medium", "high", "xhigh"].map((value) => ({ reasoningEffort: value }));
  composerReasoningOptions.innerHTML = efforts.map((effort) => {
    const value = effort.reasoningEffort || "";
    const selectedClass = value === reasoningEffort ? " selected" : "";
    return \`<button type="button" class="runtime-menu-option\${selectedClass}" data-runtime-reasoning="\${escapeAttr(value)}" role="menuitemradio" aria-checked="\${value === reasoningEffort}"><span>\${escapeHtml(reasoningDisplayName(value))}</span></button>\`;
  }).join("");
  for (const button of composerReasoningOptions.querySelectorAll("[data-runtime-reasoning]")) {
    button.addEventListener("click", () => void updateReasoningFromComposer(button.dataset.runtimeReasoning));
  }

  composerModelOptions.innerHTML = modelOptions.map((model) => {
    const value = model.model || model.id || "";
    const isSelected = selected.model ? value === selected.model : Boolean(model.isDefault);
    return \`<button type="button" class="runtime-menu-option\${isSelected ? " selected" : ""}" data-runtime-model="\${escapeAttr(value)}" role="menuitemradio" aria-checked="\${isSelected}"><span>\${escapeHtml(modelDisplayName(model))}</span>\${model.isDefault ? '<small>Default</small>' : ""}</button>\`;
  }).join("") || '<span class="runtime-menu-heading">No models available</span>';
  for (const button of composerModelOptions.querySelectorAll("[data-runtime-model]")) {
    button.addEventListener("click", () => void updateModelFromComposer(button.dataset.runtimeModel));
  }
}

function modelDisplayName(model) {
  return model?.displayName || model?.model || model?.id || "";
}

function reasoningDisplayName(value) {
  const labels = { low: "Light", medium: "Medium", high: "High", xhigh: "Extra high", minimal: "Minimal", none: "None", default: "Default" };
  return labels[value] || String(value || "Default").replace(/(^|[-_])([a-z])/g, (_, prefix, letter) => (prefix ? " " : "") + letter.toUpperCase());
}

function instanceLifecycleText(agent) {
  const lifecycle = agent?.metadata?.instanceLifecycle
    || (typeof agent?.metadata?.instanceOfAgentId === "string" ? "active" : undefined);
  const labels = { active: "active task", needs_attention: "needs you", done: "done", cancelled: "cancelled" };
  return labels[lifecycle] || agent?.status || "idle";
}

function instanceLifecycleBadge(agent) {
  if (typeof agent?.metadata?.instanceOfAgentId !== "string") return "";
  const lifecycle = agent.metadata.instanceLifecycle || "active";
  const terminal = lifecycle === "done" || lifecycle === "cancelled";
  return '<span class="rail-agent-state' + (terminal ? ' terminal' : '') + '">' + escapeHtml(instanceLifecycleText(agent)) + '</span>';
}

function render() {
  renderPanel();
  if (activePanel === "jarvis") {
    const jarvis = jarvisAgent();
    if (selectedAgentId !== jarvis?.id) {
      selectedAgentId = jarvis?.id || null;
      lastMessagesHtml = "";
      forceLatestMessage = true;
    }
  } else if (activePanel === "agents" && !agents.some((agent) => agent.id === selectedAgentId)) {
    selectedAgentId = agents[0]?.id || null;
    lastMessagesHtml = "";
    forceLatestMessage = true;
  }
  const agentListHtml = agents.map((agent) => \`
    <button class="rail-agent \${agent.id === selectedAgentId && activePanel === "agents" ? "active" : ""}" data-agent-id="\${escapeAttr(agent.id)}" title="Open \${escapeAttr(agent.name)} conversation">
      <i class="status-dot \${escapeAttr(agent.status)}"></i>
      <strong>\${escapeHtml(agent.name)}</strong>
      \${instanceLifecycleBadge(agent)}
    </button>
  \`).join("") || '<span class="rail-agent-empty">No agents yet</span>';
  if (agentListHtml !== lastAgentListHtml) {
    agentList.innerHTML = agentListHtml;
    lastAgentListHtml = agentListHtml;
    for (const button of agentList.querySelectorAll(".rail-agent")) {
      button.addEventListener("click", () => {
        selectedAgentId = button.dataset.agentId;
        activePanel = "agents";
        lastMessagesHtml = "";
        forceLatestMessage = true;
        editAgentDirty = false;
        render();
        void refreshEvents().then(render);
      });
    }
  }
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  const currentWorkspace = selectedWorkspaceStatus?.agentId === selected?.id
    ? selectedWorkspaceStatus.workspace
    : null;
  const configuredWorkspace = selected?.metadata?.commandCenterWorkspace;
  const workspaceLabel = currentWorkspace
    ? currentWorkspace.branch + (currentWorkspace.dirty ? " · modified" : " · clean")
    : configuredWorkspace?.branch || "";
  selectedTitle.textContent = selected ? selected.name : "No agent selected";
  selectedMeta.textContent = selected ? \`\${selected.id} - \${instanceLifecycleText(selected)} - \${selected.runnerId || "local"} - \${selected.cwd}\${workspaceLabel ? " - " + workspaceLabel : ""} - \${skillSummary(selected)} - \${permissionSummary(selected)}\` : "Create or select an agent to begin.";
  messageInput.placeholder = selected ? "Message " + selected.name : "Create or select an agent to begin";
  syncComposerControls(selected || null);
  cancelAgentButton.hidden = !(selected && selected.status === "running");
  cancelAgentButton.disabled = cancelInFlight;
  cancelAgentButton.textContent = cancelInFlight ? "Stopping" : "Stop turn";
  const instanceLifecycle = selected?.metadata?.instanceLifecycle
    || (typeof selected?.metadata?.instanceOfAgentId === "string" ? "active" : undefined);
  const isInstance = typeof selected?.metadata?.instanceOfAgentId === "string";
  const isTerminalInstance = instanceLifecycle === "done" || instanceLifecycle === "cancelled";
  instanceDoneButton.hidden = !isInstance || isTerminalInstance || instanceLifecycle !== "needs_attention";
  instanceCancelButton.hidden = !isInstance || isTerminalInstance;
  instanceDoneButton.disabled = instanceResolutionInFlight || selected?.status === "running";
  instanceCancelButton.disabled = instanceResolutionInFlight;
  workspaceCleanupButton.hidden = !isTerminalInstance || !currentWorkspace || currentWorkspace.removed;
  workspaceCleanupButton.disabled = workspaceCleanupInFlight;
  workspaceCleanupButton.textContent = workspaceCleanupInFlight ? "Cleaning up" : "Clean up";
  workspaceOpenButton.hidden = !currentWorkspace || currentWorkspace.removed;
  workspaceOpenButton.disabled = workspaceOpenInFlight;
  workspaceOpenButton.textContent = workspaceOpenInFlight ? "Opening" : "Open in VS Code";
  messageInput.disabled = isTerminalInstance;
  messageForm.querySelector(".composer-send").disabled = isTerminalInstance;
  if (isTerminalInstance) messageInput.placeholder = "This task instance is " + instanceLifecycle + ".";
  renderAgentEditor(selected);
  const visibleEvents = selected
    ? events.filter((item) => item.agentId === selected.id && eventBelongsToAgentInstance(item, selected))
    : [];
  dedupePendingMessages(visibleEvents);
  const hasCompletion = visibleEvents.some((event) => event.type === "turn_completed" || event.type === "turn_failed");
  const hasTurnStarted = visibleEvents.some((event) => event.type === "turn_started");
  const activeTurnPending = hasActiveTurnPending(visibleEvents);
  const resolvedApprovals = approvalResolutionMap(visibleEvents);
  const workSummaries = summarizeWorkEvents(visibleEvents);
  const workEventIds = new Set(workSummaries.flatMap((summary) => summary.eventIds));
  const commentarySummaries = summarizeCommentaryEvents(visibleEvents);
  const commentaryEventIds = new Set(commentarySummaries.flatMap((summary) => summary.eventIds));
  const activitySummaries = summarizeActivityEvents(visibleEvents, resolvedApprovals);
  const activityEventIds = new Set(activitySummaries.flatMap((summary) => summary.eventIds));
  const liveTurnMessages = activeTurnPending ? liveTurnToTimelineMessages(visibleEvents) : [];
  const timelineMessages = [
    ...workSummaries.map(workSummaryToTimelineMessage).filter(shouldShowTimelineInChat),
    ...commentarySummaries.filter((summary) => summary.status !== "running").flatMap(commentarySummaryToTimelineMessages),
    ...activitySummaries.filter((summary) => summary.status !== "running").map(activitySummaryToTimelineMessage),
    ...liveTurnMessages,
  ].filter(Boolean);
  const persistedMessages = visibleEvents
    .filter((event) => !workEventIds.has(event.id))
    .filter((event) => !commentaryEventIds.has(event.id))
    .filter((event) => !activityEventIds.has(event.id))
    .flatMap((event) => eventToMessages(event, {
    hasCompletion,
    hasTurnStarted,
    resolvedApprovals,
  }));
  const localMessages = (selectedAgentId ? pendingMessages : [])
    .filter((item) => !selectedAgentId || item.agentId === selectedAgentId)
    .flatMap((item) => [
      { kind: "user", meta: "You", text: item.text },
      { kind: "status", meta: "", text: "Agent is working", pending: true },
    ]);
  const workingMessage = activeTurnPending && !localMessages.some((item) => item.pending)
    && !liveTurnMessages.length
    ? [{ kind: "status", meta: "", text: "Agent is working", pending: true }]
    : [];
  const rendered = [
    ...persistedMessages,
    ...timelineMessages,
    ...localMessages,
    ...workingMessage,
  ].sort((left, right) => {
    return Date.parse(left.time || "") - Date.parse(right.time || "");
  });
  const historyControl = eventHasMore
    ? '<button type="button" class="load-older-events" data-load-older' + (eventLoadingOlder ? ' disabled' : '') + '>' + (eventLoadingOlder ? 'Loading older history...' : 'Load older history') + '</button>'
    : '';
  renderMessagesIfChanged(historyControl + (rendered.map(renderMessage).join("") || '<div class="empty">Create or select an agent to begin.</div>'));
  renderQueues();
}

function renderAgentEditor(selected) {
  editAgentForm.classList.toggle("disabled", !selected);
  if (!selected) {
    editAgentStatus.textContent = "select one";
    editAgentForm.reset();
    editAgentLoadedId = null;
    editAgentDirty = false;
    return;
  }
  editAgentStatus.textContent = selected.status;
  agentSettingsTitle.textContent = "Edit " + selected.name;
  if (editAgentDirty && editAgentLoadedId === selected.id) {
    return;
  }
  editAgentLoadedId = selected.id;
  editAgentDirty = false;
  editAgentForm.elements.name.value = selected.name || "";
  editAgentForm.elements.runnerId.value = selected.runnerId || "local";
  editAgentForm.elements.role.value = selected.metadata?.role === "router" || selected.metadata?.role === "jarvis"
    ? selected.metadata.role
    : "";
  editAgentForm.elements.model.value = selected.model || "";
  editAgentForm.elements.reasoningEffort.value = selected.reasoningEffort || "";
  editAgentForm.elements.serviceTier.value = selected.serviceTier || "";
  editAgentForm.elements.permissionMode.value = permissionModeForAgent(selected);
  editAgentForm.elements.cwd.value = selected.cwd || "";
  editAgentForm.elements.skillMode.value = selected.skillMode || "all";
  editAgentForm.elements.routingDescription.value = selected.metadata?.routingDescription || "";
  editAgentForm.elements.instructions.value = selected.instructions || "";
  if (!modelCatalogs.has(selected.runnerId || "local")) {
    void refreshModelOptions(selected.runnerId || "local");
  }
  renderModelControls();
  updateSkillPickerVisibility(editAgentForm);
  if ((selected.skillMode || "all") === "selected") {
    void loadSkillOptions(editAgentForm, selected.allowedSkills || []);
  }
}

function skillSummary(agent) {
  if ((agent.skillMode || "all") === "all") return "All skills";
  const count = Array.isArray(agent.allowedSkills) ? agent.allowedSkills.length : 0;
  return count + (count === 1 ? " skill" : " skills");
}

function permissionModeForAgent(agent) {
  if (agent.sandbox === "danger-full-access" || agent.approvalPolicy === "never") return "full-access";
  if (agent.approvalsReviewer === "auto_review") return "auto-review";
  return "ask";
}

function permissionSummary(agent) {
  const mode = permissionModeForAgent(agent);
  if (mode === "auto-review") return "Approve for me";
  if (mode === "full-access") return "Full access";
  return "Ask for approval";
}

function setupSkillPicker(form) {
  const mode = form.elements.skillMode;
  const cwd = form.elements.cwd;
  const search = form.querySelector("[data-skill-search]");
  mode.addEventListener("change", () => {
    updateSkillPickerVisibility(form);
    if (mode.value === "selected") void loadSkillOptions(form);
  });
  cwd.addEventListener("change", () => {
    if (mode.value === "selected") void loadSkillOptions(form, [], true);
  });
  search.addEventListener("input", () => filterSkillOptions(form));
  updateSkillPickerVisibility(form);
}

function setupDirectoryBrowse(form) {
  const button = form.querySelector("[data-browse-cwd]");
  const cwd = form.elements.cwd;
  button.addEventListener("click", async () => {
    if (String(form.elements.runnerId?.value || "local") !== "local") {
      try {
        await openRemoteDirectoryPicker(form);
      } catch (error) {
        closeRemoteDirectoryPicker();
        toast(error.message || String(error), "error");
      }
      return;
    }
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Opening…";
    try {
      const response = await fetch("/api/directories/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initialPath: cwd.value }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not open the folder picker");
      if (!body.path) return;
      cwd.value = body.path;
      cwd.dispatchEvent(new Event("input", { bubbles: true }));
      cwd.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (error) {
      toast(error.message || String(error), "error");
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });
}

async function openRemoteDirectoryPicker(form) {
  const runnerId = String(form.elements.runnerId?.value || "");
  const runner = runners.find((item) => item.id === runnerId);
  remoteDirectoryTargetForm = form;
  remoteDirectoryRunnerId = runnerId;
  remoteDirectoryListing = null;
  remoteDirectoryRunner.textContent = runner
    ? runner.name + " · " + runner.hostname + " · " + runner.status
    : runnerId;
  remoteDirectoryModal.hidden = false;
  try {
    await loadRemoteDirectory(String(form.elements.cwd.value || "").trim());
  } catch (error) {
    if (!String(form.elements.cwd.value || "").trim()) throw error;
    toast("The current path is not available on this runner; showing its home directory.");
    await loadRemoteDirectory("");
  }
}

async function loadRemoteDirectory(path) {
  if (!remoteDirectoryRunnerId) return;
  remoteDirectoryStatus.textContent = "Loading directories…";
  remoteDirectoryList.innerHTML = "";
  remoteDirectorySelect.disabled = true;
  const query = new URLSearchParams({ runnerId: remoteDirectoryRunnerId });
  if (String(path || "").trim()) query.set("path", String(path).trim());
  const response = await fetch("/api/runner-directories?" + query.toString());
  const body = await response.json();
  if (!response.ok) {
    remoteDirectoryStatus.textContent = body.error || "Could not browse this runner";
    throw new Error(remoteDirectoryStatus.textContent);
  }
  remoteDirectoryListing = body;
  remoteDirectoryPath.value = body.path;
  remoteDirectoryStatus.textContent = body.directories.length
    ? body.directories.length + " folders"
    : "This folder has no child directories";
  remoteDirectoryUp.disabled = !body.parentPath;
  remoteDirectoryHome.disabled = body.path === body.homePath;
  remoteDirectorySelect.disabled = false;
  remoteDirectoryList.innerHTML = body.directories.length
    ? body.directories.map((directory) => '<button type="button" class="remote-directory-entry" data-remote-path="' + escapeAttr(directory.path) + '">' + escapeHtml(directory.name) + '</button>').join("")
    : '<div class="remote-directory-empty">No folders here</div>';
  for (const entry of remoteDirectoryList.querySelectorAll("[data-remote-path]")) {
    entry.addEventListener("click", () => void navigateRemoteDirectory(entry.dataset.remotePath));
  }
}

async function navigateRemoteDirectory(path) {
  try {
    await loadRemoteDirectory(path);
  } catch (error) {
    toast(error.message || String(error), "error");
  }
}

function selectRemoteDirectory() {
  if (!remoteDirectoryTargetForm || !remoteDirectoryListing?.path) return;
  const cwd = remoteDirectoryTargetForm.elements.cwd;
  cwd.value = remoteDirectoryListing.path;
  cwd.dispatchEvent(new Event("input", { bubbles: true }));
  cwd.dispatchEvent(new Event("change", { bubbles: true }));
  closeRemoteDirectoryPicker();
}

function closeRemoteDirectoryPicker() {
  remoteDirectoryModal.hidden = true;
  remoteDirectoryTargetForm = null;
  remoteDirectoryRunnerId = null;
  remoteDirectoryListing = null;
}

function updateSkillPickerVisibility(form) {
  form.querySelector("[data-skill-picker]").hidden = form.elements.skillMode.value !== "selected";
}

async function loadSkillOptions(form, desiredSkills, forceReload = false) {
  const cwd = String(form.elements.cwd.value || "").trim();
  const runnerId = String(form.elements.runnerId?.value || "local");
  const container = form.querySelector("[data-skill-options]");
  if (!cwd) {
    container.innerHTML = "<span>Enter a working directory to load skills.</span>";
    return;
  }
  const existing = desiredSkills || Array.from(form.querySelectorAll("[data-skill-checkbox]:checked")).map((input) => ({
    name: input.dataset.skillName,
    scope: input.dataset.skillScope,
  }));
  const selected = new Set(existing.map((skill) => skill.scope + "\\u0000" + skill.name));
  container.innerHTML = "<span>Loading skills…</span>";
  try {
    const catalogKey = runnerId + "\u0000" + cwd;
    let catalog = !forceReload && skillCatalogs.get(catalogKey);
    if (!catalog) {
      const response = await fetch("/api/skill-options?cwd=" + encodeURIComponent(cwd) + "&runnerId=" + encodeURIComponent(runnerId) + (forceReload ? "&forceReload=true" : ""));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load skills");
      catalog = body;
      skillCatalogs.set(catalogKey, catalog);
    }
    const skills = Array.isArray(catalog.skills) ? catalog.skills : [];
    const identityCounts = new Map();
    for (const skill of skills) {
      const key = skill.scope + "\\u0000" + skill.name;
      identityCounts.set(key, (identityCounts.get(key) || 0) + 1);
    }
    container.innerHTML = skills.map((skill) => {
      const key = skill.scope + "\\u0000" + skill.name;
      const description = skill.shortDescription || skill.description || "";
      const ambiguous = identityCounts.get(key) > 1;
      const selectable = skill.enabled && !ambiguous;
      return \`<label class="skill-option" data-skill-row data-search="\${escapeAttr((skill.name + " " + description + " " + skill.scope).toLowerCase())}">
        <input type="checkbox" data-skill-checkbox data-skill-name="\${escapeAttr(skill.name)}" data-skill-scope="\${escapeAttr(skill.scope)}" \${selected.has(key) && selectable ? "checked" : ""} \${selectable ? "" : "disabled"}>
        <span><strong>\${escapeHtml(skill.name)}</strong><small>\${escapeHtml(description)}</small></span>
        <span class="skill-scope">\${escapeHtml(skill.scope)}\${ambiguous ? " · duplicate" : (skill.enabled ? "" : " · off")}</span>
      </label>\`;
    }).join("") || "<span>No skills discovered for this working directory.</span>";
    filterSkillOptions(form);
  } catch (error) {
    container.innerHTML = '<span class="error">' + escapeHtml(error.message || String(error)) + "</span>";
  }
}

function filterSkillOptions(form) {
  const query = String(form.querySelector("[data-skill-search]").value || "").trim().toLowerCase();
  for (const row of form.querySelectorAll("[data-skill-row]")) {
    row.hidden = Boolean(query) && !row.dataset.search.includes(query);
  }
}

function renderPanel() {
  const titles = {
    topology: ["Topology", "Live agent, event, and work relationships."],
    jarvis: ["Jarvis", "Talk to the command center as a whole."],
    agents: ["Agents", "Select an agent and watch its conversation on the right."],
    create: ["Create Agent", "Add a specialized Codex session to the command center."],
    runners: ["Runners", "Machines connected to this SquadAI control plane."],
    skills: ["Skills", "Copy user skills between connected machines without starting an agent."],
    notifications: ["Notifications", "Human-attention items from active agents."],
    events: ["Event Inbox", "Sensor events assigned directly, waiting for assignment, or already routed."],
    work: ["Work Queue", "Durable work assigned to worker agents."],
  };
  const [title, subtitle] = titles[activePanel] || titles.agents;
  const opsMode = activePanel === "notifications" || activePanel === "events" || activePanel === "work" || activePanel === "runners" || activePanel === "skills";
  const topologyMode = activePanel === "topology";
  const createMode = activePanel === "create";
  shell.classList.toggle("jarvis-mode", activePanel === "jarvis");
  shell.classList.toggle("agents-mode", activePanel === "agents");
  shell.classList.toggle("ops-mode", opsMode);
  shell.classList.toggle("topology-mode", topologyMode);
  shell.classList.toggle("create-mode", createMode);
  if (opsMode) {
    opsTitle.textContent = title;
    opsSubtitle.textContent = subtitle;
  } else {
    panelTitle.textContent = title;
    panelSubtitle.textContent = subtitle;
  }
  for (const button of document.querySelectorAll("[data-panel]")) {
    button.classList.toggle("active", button.dataset.panel === activePanel);
  }
  for (const view of document.querySelectorAll(".panel-view")) {
    view.classList.toggle("active", view.id === "panel-" + activePanel);
  }
  for (const log of document.querySelectorAll(".ops-log")) {
    log.classList.toggle("active", (
      (activePanel === "notifications" && log.id === "notifications-list") ||
      (activePanel === "events" && log.id === "sensor-events") ||
      (activePanel === "work" && log.id === "work-items") ||
      (activePanel === "runners" && log.id === "runners-list") ||
      (activePanel === "skills" && log.id === "skill-library")
    ));
  }
  if (activePanel === "runners") renderRunners();
  if (activePanel === "skills") renderSkillLibrary();
}

async function refreshSkillLibrary(renderAfter = true) {
  if (skillLibraryLoading) return;
  skillLibraryLoading = true;
  if (renderAfter) renderSkillLibrary();
  try {
    const response = await fetch("/api/skill-library");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load skills");
    skillLibrarySnapshot = body;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    skillLibraryLoading = false;
    if (renderAfter) {
      renderSkillLibrary();
      updateOpsCount();
    }
  }
}

function renderSkillLibrary() {
  if (!skillLibrary) return;
  const snapshot = skillLibrarySnapshot || { library: [], discovered: [], runners: [], errors: [] };
  const onlineRunners = snapshot.runners.filter((runner) => runner.status === "online");
  const runnerName = (runnerId) => snapshot.runners.find((runner) => runner.id === runnerId)?.name || runnerId;
  const errorsHtml = snapshot.errors.map((error) =>
    '<div class="skill-error">' + escapeHtml(runnerName(error.runnerId)) + ': ' + escapeHtml(error.message) + '</div>'
  ).join("");
  const libraryHtml = snapshot.library.map((item) => {
    const targets = onlineRunners.map((runner) => {
      const installed = item.installedRunnerIds.includes(runner.id);
      return installed
        ? '<span class="skill-installed">' + escapeHtml(runner.name) + ' installed</span>'
        : '<button type="button" data-skill-install="' + escapeAttr(item.name) + '" data-skill-runner="' + escapeAttr(runner.id) + '">Install on ' + escapeHtml(runner.name) + '</button>';
    }).join("");
    return '<article class="skill-card">'
      + '<header><h4>' + escapeHtml(item.name) + '</h4><span class="log-status completed">in library</span></header>'
      + '<p>' + escapeHtml(item.description || "No description provided.") + '</p>'
      + '<div class="skill-card-meta">Imported from ' + escapeHtml(runnerName(item.sourceRunnerId)) + '</div>'
      + '<div class="skill-card-actions">' + targets + '</div>'
      + '</article>';
  }).join("") || '<div class="log-empty">No skills have been imported into SquadAI yet.</div>';
  const discovered = snapshot.discovered.filter((item) => !item.inLibrary);
  const discoveredHtml = discovered.map((item) =>
    '<article class="skill-card">'
      + '<header><h4>' + escapeHtml(item.name) + '</h4><span class="log-status pending">on machine</span></header>'
      + '<p>' + escapeHtml(item.description || item.shortDescription || "No description provided.") + '</p>'
      + '<div class="skill-card-meta">Available on <strong class="skill-machine-name">' + escapeHtml(item.runnerName) + '</strong></div>'
      + '<div class="skill-card-actions"><button type="button" data-skill-import="' + escapeAttr(item.name) + '" data-skill-path="' + escapeAttr(item.path) + '" data-skill-runner="' + escapeAttr(item.runnerId) + '" data-skill-description="' + escapeAttr(item.description || item.shortDescription || "") + '">Import to library</button></div>'
      + '</article>'
  ).join("") || '<div class="log-empty">Every discovered user skill is already in the library.</div>';
  skillLibrary.innerHTML = errorsHtml
    + (skillLibraryLoading ? '<div class="skill-error">Checking connected machines...</div>' : '')
    + '<section class="skill-section"><h3>SquadAI library</h3><p>Stored centrally and ready to install on any online runner.</p><div class="skill-grid">' + libraryHtml + '</div></section>'
    + '<section class="skill-section"><h3>Available to import</h3><p>User skills discovered on connected machines.</p><div class="skill-grid">' + discoveredHtml + '</div></section>';
  bindSkillLibraryActions();
}

function bindSkillLibraryActions() {
  for (const button of skillLibrary.querySelectorAll("[data-skill-import]")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      const response = await fetch("/api/skill-library/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runnerId: button.dataset.skillRunner,
          name: button.dataset.skillImport,
          path: button.dataset.skillPath,
          description: button.dataset.skillDescription,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        toast(body.error || "Skill import failed", "error");
        button.disabled = false;
        return;
      }
      toast(button.dataset.skillImport + " added to the SquadAI library");
      await refreshSkillLibrary();
    });
  }
  for (const button of skillLibrary.querySelectorAll("[data-skill-install]")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      const response = await fetch("/api/skill-library/" + encodeURIComponent(button.dataset.skillInstall) + "/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerId: button.dataset.skillRunner }),
      });
      const body = await response.json();
      if (!response.ok) {
        toast(body.error || "Skill installation failed", "error");
        button.disabled = false;
        return;
      }
      toast(button.dataset.skillInstall + " installed on " + runnerNameForSkill(button.dataset.skillRunner));
      await refreshSkillLibrary();
    });
  }
}

function runnerNameForSkill(runnerId) {
  return skillLibrarySnapshot.runners.find((runner) => runner.id === runnerId)?.name || runnerId;
}

function renderQueues() {
  eventCount.textContent = String(sensorEvents.length);
  if (eventPanelCount) eventPanelCount.textContent = String(sensorEvents.length);
  workCount.textContent = String(workItems.length);
  if (workPanelCount) workPanelCount.textContent = String(workItems.length);
  sensorEventList.innerHTML = renderSensorEventLog(sensorEvents);
  workItemList.innerHTML = renderWorkItemLog(workItems);
  bindSensorEventActions();
  updateOpsCount();
  renderNotifications();
}

function renderSensorEventLog(items) {
  return [...items].reverse().map((event) => {
    const detail = [
      event.body ? ["Body", event.body] : null,
      event.url ? ["URL", event.url] : null,
      event.executionPolicy ? ["Execution", event.executionPolicy === "new" ? "New agent instance" : "Reuse base agent"] : null,
      event.targetAgentId ? ["Target agent", agentName(event.targetAgentId)] : null,
      event.workItemId ? ["Work item", event.workItemId] : null,
      event.failureReason ? ["Failure", event.failureReason] : null,
      hasKeys(event.metadata) ? ["Metadata", JSON.stringify(event.metadata, null, 2)] : null,
    ].filter(Boolean);
    const assignableAgents = agents.filter(
      (agent) => agent.metadata?.role !== "router" && agent.metadata?.role !== "jarvis",
    ).filter(
      (agent) => typeof agent.metadata?.instanceOfAgentId !== "string",
    );
    const actionsHtml = event.status === "unassigned" ? \`
      <select data-sensor-event-target="\${escapeAttr(event.id)}" aria-label="Assign event to agent">
        <option value="">Choose an agent</option>
        \${assignableAgents.map((agent) => \`<option value="\${escapeAttr(agent.id)}">\${escapeHtml(agent.name)}</option>\`).join("")}
      </select>
      <button type="button" data-sensor-event-assign="\${escapeAttr(event.id)}"\${assignableAgents.length ? "" : " disabled"}>Assign work</button>
    \` : "";
    return renderLogRow({
      time: event.updatedAt || event.createdAt,
      source: event.source,
      status: event.status + " · " + event.id,
      statusClass: event.status,
      message: event.title || event.type || event.body || event.id,
      detail,
      actionsHtml,
    });
  }).join("") || '<div class="log-empty">No sensor events yet.</div>';
}

function renderWorkItemLog(items) {
  return [...items].reverse().map((item) => {
    const agent = agentName(item.targetAgentId);
    const waitingForInstance = item.metadata?.pendingInstantiation === true;
    const detail = [
      item.eventId ? ["Sensor event", item.eventId] : null,
      waitingForInstance ? ["Execution", "Waiting for a free agent instance (backlog limit 5)"] : null,
      item.prompt ? ["Prompt", item.prompt] : null,
      item.result ? ["Result", item.result] : null,
      item.failureReason ? ["Failure", item.failureReason] : null,
      item.reason ? ["Routing reason", item.reason] : null,
    ].filter(Boolean);
    return renderLogRow({
      time: item.updatedAt || item.createdAt,
      source: agent,
      status: (waitingForInstance ? "waiting" : item.status) + " · " + item.id,
      statusClass: waitingForInstance ? "waiting" : item.status,
      message: item.prompt || item.id,
      detail,
    });
  }).join("") || '<div class="log-empty">No work items yet.</div>';
}

function renderLogRow({ time, source, status, statusClass, message, detail, actionsHtml = "" }) {
  const detailHtml = detail.length
    ? \`<div class="log-detail">\${detail.map(([label, value]) => \`<strong>\${escapeHtml(label)}:</strong> \${escapeHtml(String(value))}\`).join("\\n\\n")}</div>\`
    : "";
  return \`
    <details class="log-row">
      <summary class="log-summary">
        <span class="log-time">\${escapeHtml(formatShortTime(time))}</span>
        <span class="log-source">\${escapeHtml(source || "system")}</span>
        <span class="log-status \${escapeAttr(statusClass || "")}">\${escapeHtml(status || "")}</span>
        <span class="log-message">\${escapeHtml(message || "")}</span>
      </summary>
      \${detailHtml}
      \${actionsHtml ? \`<div class="log-actions">\${actionsHtml}</div>\` : ""}
    </details>
  \`;
}

function bindSensorEventActions() {
  for (const button of sensorEventList.querySelectorAll("[data-sensor-event-assign]")) {
    button.addEventListener("click", async () => {
      const eventId = button.dataset.sensorEventAssign;
      const select = sensorEventList.querySelector(
        \`[data-sensor-event-target="\${CSS.escape(eventId)}"]\`,
      );
      const targetAgentId = select?.value || "";
      if (!eventId || !targetAgentId) {
        toast("Choose an agent first", "error");
        return;
      }
      button.disabled = true;
      button.textContent = "Assigning…";
      const response = await fetch(
        "/api/sensor-events/" + encodeURIComponent(eventId) + "/assign",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetAgentId }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        toast(result.error || "Assignment failed", "error");
        button.disabled = false;
        button.textContent = "Assign work";
        return;
      }
      toast("Event assigned to " + agentName(targetAgentId));
      await refreshQueues();
    });
  }
}

function hasKeys(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function renderNotifications() {
  const pending = notifications.filter((item) => item.status === "pending");
  notificationCount.textContent = String(pending.length);
  if (notificationPanelCount) notificationPanelCount.textContent = String(pending.length);
  notificationList.innerHTML = [...pending].reverse().map(renderNotificationItem).join("") || '<div class="empty">No notifications need attention.</div>';
  updateOpsCount();
  bindNotificationActions();
}

function renderNotificationItem(item) {
  const dismissButton = item.kind === "approval_required" || item.kind === "compatibility_required"
    ? ""
    : \`<button type="button" class="secondary" data-notification-dismiss-id="\${escapeAttr(item.id)}">Dismiss</button>\`;
  const compatibilityApproval = item.kind === "compatibility_required"
    ? compatibilityApprovals.find((approval) => approval.id === item.approvalId && approval.status === "pending")
    : null;
  const compatibilityActions = compatibilityApproval ? \`
    <span class="compatibility-actions" data-compatibility-approval-id="\${escapeAttr(compatibilityApproval.id)}">
      <select aria-label="Replacement model">
        \${compatibilityApproval.issue.suggestedModels.map((model) => \`<option value="\${escapeAttr(model.model || model.id)}">\${escapeHtml(model.displayName || model.model || model.id)}\${model.isDefault ? " (Codex default)" : ""}</option>\`).join("")}
      </select>
      <button type="button" data-compatibility-action="approved">Apply and retry</button>
      <button type="button" class="secondary" data-compatibility-action="declined">Keep paused</button>
    </span>
  \` : "";
  return \`
    <div class="queue-item notification-item" role="button" tabindex="0" data-notification-id="\${escapeAttr(item.id)}" data-notification-agent-id="\${escapeAttr(item.agentId)}">
      <span class="queue-time">\${escapeHtml(formatShortTime(item.updatedAt || item.createdAt))}</span>
      <strong>\${escapeHtml(item.agentName)}</strong>
      <span class="queue-state">\${escapeHtml(notificationKindLabel(item.kind))} · \${escapeHtml(item.id)}</span>
      <span class="sub queue-message">\${escapeHtml(item.summary)} · event \${escapeHtml(item.sourceEventId)}</span>
      <span class="queue-actions">
        \${compatibilityActions || "<span>Open agent</span>"}
        \${dismissButton}
      </span>
    </div>
  \`;
}

function updateOpsCount() {
  if (!opsCount) return;
  if (activePanel === "notifications") {
    const pending = notifications.filter((item) => item.status === "pending").length;
    opsCount.textContent = pending + (pending === 1 ? " item" : " items");
    return;
  }
  if (activePanel === "events") {
    opsCount.textContent = sensorEvents.length + (sensorEvents.length === 1 ? " item" : " items");
    return;
  }
  if (activePanel === "work") {
    opsCount.textContent = workItems.length + (workItems.length === 1 ? " item" : " items");
    return;
  }
  if (activePanel === "skills") {
    const count = skillLibrarySnapshot.library.length;
    opsCount.textContent = count + (count === 1 ? " library skill" : " library skills");
    return;
  }
  if (activePanel === "runners") {
    const count = runners.length + 1;
    const online = runners.filter((runner) => runner.status === "online").length + 1;
    opsCount.textContent = online + " online · " + count + (count === 1 ? " machine" : " machines");
  }
}

function formatShortTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}

function eventBelongsToAgentInstance(event, agent) {
  if (!agent?.createdAt || !event?.createdAt) {
    return true;
  }
  const eventTime = Date.parse(event.createdAt);
  const agentTime = Date.parse(agent.createdAt);
  if (Number.isNaN(eventTime) || Number.isNaN(agentTime)) {
    return true;
  }
  return eventTime >= agentTime;
}

function bindNotificationActions() {
  for (const item of notificationList.querySelectorAll("[data-notification-agent-id]")) {
    item.addEventListener("click", () => {
      openNotification(item.dataset.notificationId, item.dataset.notificationAgentId);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openNotification(item.dataset.notificationId, item.dataset.notificationAgentId);
      }
    });
  }
  for (const button of notificationList.querySelectorAll("[data-notification-dismiss-id]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void dismissNotification(button.dataset.notificationDismissId);
    });
  }
  for (const button of notificationList.querySelectorAll("[data-compatibility-action]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const container = button.closest("[data-compatibility-approval-id]");
      const model = container?.querySelector("select")?.value || "";
      void resolveCompatibilityApproval(
        container?.dataset.compatibilityApprovalId,
        button.dataset.compatibilityAction,
        model,
      );
    });
  }
}

async function resolveCompatibilityApproval(approvalId, decision, model) {
  if (!approvalId) return;
  const response = await fetch("/api/compatibility/" + encodeURIComponent(approvalId) + "/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(decision === "approved" ? { decision, model } : { decision }),
  });
  const body = await response.json();
  if (!response.ok) {
    toast(body.error || "Compatibility update failed", "error");
    return;
  }
  await refresh();
  window.dispatchEvent(new CustomEvent("topology:refresh"));
  toast(decision === "approved" ? "Agent migrated; blocked work is resuming" : "Agent remains paused");
}

function openNotification(notificationId, agentId) {
  if (!agentId) return;
  selectedAgentId = agentId;
  activePanel = "agents";
  lastMessagesHtml = "";
  editAgentDirty = false;
  render();
  scrollDown();
  toast("Opened notification " + notificationId);
}

async function dismissNotification(notificationId) {
  if (!notificationId) return;
  const response = await fetch("/api/notifications/" + encodeURIComponent(notificationId) + "/dismiss", {
    method: "POST",
  });
  const body = await response.json();
  if (!response.ok) {
    toast(body.error || "Dismiss failed", "error");
    return;
  }
  await refreshNotifications();
  toast("Notification dismissed");
}

function notificationKindLabel(kind) {
  const labels = {
    approval_required: "Approval",
    compatibility_required: "Compatibility approval",
    agent_failed: "Agent failed",
    turn_failed: "Turn failed",
    work_item_failed: "Work failed",
    sensor_event_failed: "Sensor failed",
  };
  return labels[kind] || kind;
}

function approvalResolutionMap(visibleEvents) {
  const map = new Map();
  for (const event of visibleEvents) {
    if (event.type === "approval_resolved" && event.payload && event.payload.approvalId) {
      map.set(String(event.payload.approvalId), event);
    }
  }
  return map;
}

function hasActiveTurnPending(visibleEvents) {
  let turnStartedAt = -1;
  let turnFinishedAt = -1;
  visibleEvents.forEach((event, index) => {
    if (event.type === "turn_started") {
      turnStartedAt = index;
    }
    if (event.type === "turn_completed" || event.type === "turn_failed") {
      turnFinishedAt = index;
    }
  });
  return turnStartedAt > turnFinishedAt;
}

function dedupePendingMessages(visibleEvents) {
  const startedEvents = visibleEvents
    .filter((event) => event.type === "turn_started" && event.payload && event.payload.input)
    .map((event) => ({
      input: String(event.payload.input),
      startedAt: Date.parse(event.createdAt),
    }));
  if (!startedEvents.length) return;
  pendingMessages = pendingMessages.filter((item) => {
    return !startedEvents.some((event) => {
      return event.input === item.text && Number.isFinite(event.startedAt) && event.startedAt >= item.createdAt;
    });
  });
}

function summarizeWorkEvents(visibleEvents) {
  const summaries = new Map();
  for (const event of visibleEvents) {
    const workItemId = event.payload && event.payload.workItemId ? String(event.payload.workItemId) : "";
    if (!workItemId || !event.type.startsWith("work_item_")) {
      continue;
    }
    const current = summaries.get(workItemId) || {
      workItemId,
      eventIds: [],
      status: "created",
      title: "Work item",
      detail: "",
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
    };
    current.eventIds.push(event.id);
    current.updatedAt = event.createdAt;
    if (event.payload && event.payload.sensorEventId) {
      current.sensorEventId = String(event.payload.sensorEventId);
    }
    if (event.type === "work_item_created") {
      current.status = "queued";
      current.title = "Work item queued";
      current.detail = event.payload && event.payload.reason ? String(event.payload.reason) : event.message;
    }
    if (event.type === "work_item_requeued") {
      current.status = "queued";
      current.title = "Work item requeued";
      current.detail = event.message;
    }
    if (event.type === "work_item_started") {
      current.status = "running";
      current.title = "Work item running";
      current.detail = event.message;
    }
    if (event.type === "work_item_completed") {
      current.status = "done";
      current.title = "Work item completed";
      current.detail = event.message;
    }
    if (event.type === "work_item_failed") {
      current.status = "failed";
      current.title = "Work item failed";
      current.detail = event.message;
    }
    if (event.type === "work_item_cancelled") {
      current.status = "cancelled";
      current.title = "Work item cancelled";
      current.detail = event.message;
    }
    summaries.set(workItemId, current);
  }
  return Array.from(summaries.values());
}

function shouldShowTimelineInChat(summary) {
  return summary.status === "running" || summary.status === "failed" || summary.status === "cancelled" || summary.hasApproval || summary.hasCompaction;
}

function workSummaryToTimelineMessage(summary) {
  const workItem = workItems.find((item) => item.id === summary.workItemId);
  const status = workItem ? workItem.status : summary.status;
  const detail = workItem?.failureReason || summary.detail || "";
  return {
    kind: "timeline",
    meta: "Work queue",
    title: workItem?.status === "failed" ? "Work item failed" : "Work item",
    status,
    time: workItem?.updatedAt || summary.updatedAt,
    entries: [
      { label: "work", text: \`\${summary.workItemId} - \${status}\` },
      workItem?.eventId || summary.sensorEventId
        ? { label: "event", text: workItem?.eventId || summary.sensorEventId }
        : null,
      detail ? { label: "detail", text: detail } : null,
    ].filter(Boolean),
    hasApproval: false,
  };
}

function summarizeCommentaryEvents(visibleEvents) {
  const summaries = [];
  let current = null;
  for (const event of visibleEvents) {
    if (event.type === "turn_started") {
      if (current && current.entries.length) summaries.push(current);
      current = {
        commentaryId: "commentary-" + event.id,
        eventIds: [],
        entries: [],
        status: "running",
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      };
      continue;
    }
    if (event.type === "codex_item_completed" && isCommentaryEvent(event)) {
      if (!current) {
        current = {
          commentaryId: "commentary-" + event.id,
          eventIds: [],
          entries: [],
          status: "running",
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
        };
      }
      const text = String(event.payload?.item?.text || event.payload?.summary || "").trim();
      current.eventIds.push(event.id);
      current.updatedAt = event.createdAt;
      if (text) current.entries.push({ text, time: event.createdAt });
      continue;
    }
    if (event.type === "turn_completed" || event.type === "turn_failed") {
      if (current && current.entries.length) {
        current.status = event.type === "turn_completed" ? "done" : "failed";
        summaries.push(current);
      }
      current = null;
    }
  }
  if (current && current.entries.length) summaries.push(current);
  return summaries;
}

function isAgentMessageEvent(event) {
  return event.type === "codex_item_completed" &&
    String(event.payload?.itemType || event.payload?.item?.type || "") === "agentMessage";
}

function isCommentaryEvent(event) {
  return isAgentMessageEvent(event) && String(event.payload?.item?.phase || "") === "commentary";
}

function commentarySummaryToTimelineMessages(summary) {
  if (summary.status === "running") {
    return summary.entries.map((entry) => ({
      kind: "commentary",
      meta: "Agent update",
      text: entry.text,
      time: entry.time,
      status: "running",
    }));
  }
  return [{
    kind: "commentarySummary",
    commentaryId: summary.commentaryId,
    meta: "Commentary",
    status: summary.status,
    entries: summary.entries,
    time: summary.updatedAt,
  }];
}

function liveTurnToTimelineMessages(visibleEvents) {
  let activeTurnStart = -1;
  for (let index = 0; index < visibleEvents.length; index += 1) {
    const event = visibleEvents[index];
    if (event.type === "turn_started") activeTurnStart = index;
    if (event.type === "turn_completed" || event.type === "turn_failed") activeTurnStart = -1;
  }
  if (activeTurnStart < 0) return [];

  const messages = [];
  let activityBatch = [];
  const flushActivity = (collapsed) => {
    if (!activityBatch.length) return;
    if (collapsed) {
      messages.push({
        kind: "liveActivityBatch",
        text: summarizeLiveActivityBatch(activityBatch),
        time: activityBatch[activityBatch.length - 1].time,
      });
    } else {
      messages.push(...activityBatch.map((entry) => ({ kind: "liveActivity", ...entry })));
    }
    activityBatch = [];
  };

  for (const event of visibleEvents.slice(activeTurnStart + 1)) {
    if (isCommentaryEvent(event)) {
      flushActivity(true);
      const text = String(event.payload?.item?.text || event.payload?.summary || "").trim();
      if (text) {
        messages.push({
          kind: "commentary",
          meta: "Agent update",
          text,
          time: event.createdAt,
          status: "running",
        });
      }
      continue;
    }
    if (isDisplayableActivityEvent(event)) {
      const entry = liveActivityEntry(event);
      const existingIndex = activityBatch.findIndex((candidate) => candidate.itemId === entry.itemId);
      if (existingIndex >= 0) activityBatch[existingIndex] = entry;
      else activityBatch.push(entry);
      continue;
    }
    if (event.type === "codex_turn_retrying") {
      activityBatch.push({
        category: "status",
        text: "Reconnecting - " + retryingSummary(event.payload || {}),
        time: event.createdAt,
        failed: false,
        itemType: "connection",
      });
      continue;
    }
    if (event.type === "codex_thread_compacted") {
      activityBatch.push({
        category: "memory",
        text: "Compacted conversation history",
        time: event.createdAt,
        failed: false,
        itemType: "contextCompaction",
      });
    }
  }
  flushActivity(false);
  if (messages[messages.length - 1]?.kind === "commentary") {
    messages.push({
      kind: "liveActivity",
      category: "status",
      text: "Working",
      time: messages[messages.length - 1].time,
      running: true,
      failed: false,
    });
  }
  return messages;
}

function isDisplayableActivityEvent(event) {
  if (event.type !== "codex_item_started" && event.type !== "codex_item_completed") return false;
  const itemType = String(event.payload?.itemType || event.payload?.item?.type || "");
  return itemType === "commandExecution" ||
    itemType === "mcpToolCall" ||
    itemType === "fileChange" ||
    itemType === "contextCompaction";
}

function liveActivityEntry(event) {
  const payload = event.payload || {};
  const item = payload.item && typeof payload.item === "object" ? payload.item : {};
  const itemType = String(payload.itemType || item.type || "item");
  const status = String(item.status || "completed");
  const running = event.type !== "codex_item_completed" && status !== "failed";
  const failed = status === "failed" || Boolean(item.error);
  const itemId = String(item.id || event.id);
  if (itemType === "commandExecution") {
    const command = String(payload.command || item.command || payload.summary || "command");
    return {
      category: "run",
      text: (running ? "Running " : "Ran ") + truncateText(command, 220),
      time: event.createdAt,
      failed,
      running,
      itemId,
      itemType,
    };
  }
  if (itemType === "mcpToolCall") {
    const tool = friendlyActivityToolName(item.tool || payload.toolName || payload.title || "tool");
    return {
      category: "tool",
      text: (failed ? "Failed " : running ? "Using " : "Used ") + tool,
      time: event.createdAt,
      failed,
      running,
      itemId,
      itemType,
    };
  }
  if (itemType === "fileChange") {
    const count = Array.isArray(item.changes) ? item.changes.length : 1;
    return {
      category: "edit",
      text: (running ? "Editing " : "Edited ") + count + (count === 1 ? " file" : " files"),
      time: event.createdAt,
      failed,
      running,
      itemId,
      itemType,
      fileCount: count,
    };
  }
  return {
    category: "memory",
    text: "Compacted conversation history",
    time: event.createdAt,
    failed,
    running,
    itemId,
    itemType,
  };
}

function friendlyActivityToolName(value) {
  const raw = String(value || "tool");
  const leaf = raw.split(/[/.]/).filter(Boolean).pop() || raw;
  return leaf.replace(/^mcp__/, "").replace(/[_-]+/g, " ");
}

function summarizeLiveActivityBatch(entries) {
  if (entries.length === 1) return entries[0].text;
  const commandCount = entries.filter((entry) => entry.itemType === "commandExecution").length;
  const toolCount = entries.filter((entry) => entry.itemType === "mcpToolCall").length;
  const fileCount = entries.reduce((total, entry) => total + Number(entry.fileCount || 0), 0);
  const otherCount = entries.length - commandCount - toolCount - entries.filter((entry) => entry.itemType === "fileChange").length;
  const parts = [];
  if (fileCount) parts.push("Edited " + fileCount + (fileCount === 1 ? " file" : " files"));
  if (toolCount) parts.push("Used " + toolCount + (toolCount === 1 ? " tool" : " tools"));
  if (commandCount) parts.push("Ran " + commandCount + (commandCount === 1 ? " command" : " commands"));
  if (otherCount) parts.push("Completed " + otherCount + (otherCount === 1 ? " step" : " steps"));
  return joinActivityPhrases(parts);
}

function joinActivityPhrases(parts) {
  if (parts.length < 2) return parts[0] || "Completed activity";
  if (parts.length === 2) return parts[0] + " and " + parts[1].toLowerCase();
  return parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1].toLowerCase();
}

function summarizeActivityEvents(visibleEvents, resolvedApprovals) {
  const summaries = [];
  let current = null;
  for (const event of visibleEvents) {
    if (event.type === "turn_started") {
      if (current && current.entries.length) {
        summaries.push(current);
      }
      current = {
        activityId: "activity-" + event.id,
        eventIds: [],
        entries: [],
        status: "running",
        hasApproval: false,
        hasCompaction: false,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      };
      continue;
    }
    if (event.type === "codex_item_started") {
      continue;
    }
    if (event.type === "codex_item_completed") {
      if (!isDisplayableActivityEvent(event)) {
        continue;
      }
      if (!current) {
        current = {
          activityId: "activity-" + event.id,
          eventIds: [],
          entries: [],
          status: "running",
          hasApproval: false,
          hasCompaction: false,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
        };
      }
      current.eventIds.push(event.id);
      current.updatedAt = event.createdAt;
      current.entries.push({
        itemType: String(event.payload?.itemType || "item"),
        title: String(event.payload?.title || "Codex item"),
        summary: String(event.payload?.summary || ""),
      });
      continue;
    }
    if (event.type === "approval_requested") {
      const approvalId = event.payload && event.payload.approvalId ? String(event.payload.approvalId) : "";
      const resolved = resolvedApprovals.get(approvalId);
      if (!resolved) {
        continue;
      }
      if (!current) {
        current = {
          activityId: "activity-" + event.id,
          eventIds: [],
          entries: [],
          status: "running",
          hasApproval: true,
          hasCompaction: false,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
        };
      }
      current.eventIds.push(event.id);
      current.updatedAt = resolved.createdAt || event.createdAt;
      current.hasApproval = true;
      current.entries.push({
        itemType: "approval",
        title: approvalSummary(event.payload || {}, resolved.payload || {}),
        summary: "",
      });
      continue;
    }
    if (event.type === "codex_thread_compacted") {
      if (!current) {
        current = {
          activityId: "activity-" + event.id,
          eventIds: [],
          entries: [],
          status: "running",
          hasApproval: false,
          hasCompaction: true,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
        };
      }
      current.eventIds.push(event.id);
      current.updatedAt = event.createdAt;
      current.hasCompaction = true;
      current.entries.push({
        itemType: "memory",
        title: "Thread compacted",
        summary: "Conversation history was compacted.",
      });
      continue;
    }
    if (event.type === "codex_turn_retrying") {
      if (!current) {
        current = {
          activityId: "activity-" + event.id,
          eventIds: [],
          entries: [],
          status: "running",
          hasApproval: false,
          hasCompaction: false,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
        };
      }
      current.eventIds.push(event.id);
      current.updatedAt = event.createdAt;
      current.entries.push({
        itemType: "connection",
        title: "Reconnecting",
        summary: retryingSummary(event.payload || {}),
      });
      continue;
    }
    if (event.type === "turn_completed" || event.type === "turn_failed") {
      if (current && current.entries.length) {
        current.status = event.type === "turn_completed" ? "done" : "failed";
        summaries.push(current);
        current = null;
      }
    }
  }
  if (current && current.entries.length) {
    summaries.push(current);
  }
  return summaries;
}

function activitySummaryToTimelineMessage(summary) {
  return {
    kind: "timeline",
    activityId: summary.activityId || "activity-" + String(summary.eventIds[0] || summary.createdAt),
    meta: "Codex activity",
    title: summary.hasCompaction ? "Thread compacted" : summary.status === "running" ? "Agent is working" : "Activity",
    status: summary.status,
    entries: summary.entries.map((entry) => ({
      label: entry.itemType,
      text: entry.summary ? \`\${entry.title} - \${entry.summary}\` : entry.title,
    })),
    hiddenCount: 0,
    hasApproval: summary.hasApproval,
    hasCompaction: summary.hasCompaction,
    time: summary.updatedAt,
  };
}

function approvalSummary(requestPayload, resolvedPayload) {
  const params = requestPayload.params && typeof requestPayload.params === "object" ? requestPayload.params : {};
  const tool = approvalToolLabel(params);
  const decision = String(resolvedPayload.decision || "resolved");
  return tool ? \`\${decision}: \${tool}\` : \`\${decision}: \${requestPayload.kind || "approval"}\`;
}

function eventToMessages(event, state) {
  if (event.type === "turn_started") {
    if (event.payload && event.payload.internal === true) {
      return [];
    }
    const input = event.payload && event.payload.input ? String(event.payload.input) : "";
    return input
      ? [{ kind: "user", meta: "You", text: input, time: event.createdAt }]
      : [{ kind: "status", meta: "", text: "Turn started", time: event.createdAt }];
  }
  if (event.type === "turn_completed") {
    return [{ kind: "agent", meta: agentName(event.agentId), text: event.message, time: event.createdAt }];
  }
  if (event.type === "turn_failed") {
    return [{ kind: "system", meta: "", text: "Agent failed: " + event.message, time: event.createdAt }];
  }
  if (event.type === "approval_requested") {
    const approvalId = event.payload && event.payload.approvalId ? String(event.payload.approvalId) : "";
    const resolved = state.resolvedApprovals.get(approvalId);
    if (resolved) {
      return [];
    }
    return [{
      kind: "approval",
      meta: "Approval needed",
      text: approvalText(event.payload || {}),
      approvalId,
      canApproveSession: canApproveApprovalForSession(event.payload || {}),
      time: event.createdAt,
    }];
  }
  if (event.type === "approval_resolved") {
    return [];
  }
  if (event.type === "approval_auto_approved") {
    return [];
  }
  if (event.type === "codex_item_started" ||
      event.type === "codex_item_completed" ||
      event.type === "codex_thread_compacted") {
    return [];
  }
  if (event.type === "codex_turn_retrying") {
    return [];
  }
  if (event.type === "agent_starting") {
    return state.hasTurnStarted || state.hasCompletion
      ? []
      : [{ kind: "status", meta: "", text: "Starting agent session", pending: true, time: event.createdAt }];
  }
  if (event.type === "agent_started") {
    return state.hasCompletion ? [] : [{ kind: "system", meta: "", text: "Agent session ready", time: event.createdAt }];
  }
  if (event.type === "agent_failed" && event.payload && event.payload.staleThreadId) {
    return [];
  }
  return [{ kind: "system", meta: "", text: event.type + ": " + event.message, time: event.createdAt }];
}

function retryingSummary(payload) {
  const params = payload && typeof payload === "object" && payload.params && typeof payload.params === "object"
    ? payload.params
    : payload;
  const error = params && typeof params === "object" && params.error && typeof params.error === "object"
    ? params.error
    : params;
  const nested = error && typeof error === "object" && error.error && typeof error.error === "object"
    ? error.error
    : error;
  const message = nested && typeof nested === "object" && typeof nested.message === "string"
    ? nested.message
    : "";
  return message || "Codex stream disconnected; retrying.";
}

function renderMessage(message) {
  if (message.kind === "liveActivity" || message.kind === "liveActivityBatch") {
    const isBatch = message.kind === "liveActivityBatch";
    return \`
      <article class="message-row live-activity">
        <div class="live-activity-line \${isBatch ? "live-activity-batch" : ""} \${message.running ? "running" : ""} \${message.failed ? "failed" : ""}">
          <span class="live-activity-kind">\${escapeHtml(isBatch ? "Activity" : message.category || "Step")}</span>
          <span class="live-activity-text" title="\${escapeAttr(message.text)}">\${escapeHtml(message.text)}</span>
        </div>
      </article>
    \`;
  }
  if (message.kind === "commentary") {
    const meta = message.time
      ? \`\${escapeHtml(message.meta)} · \${escapeHtml(new Date(message.time).toLocaleTimeString())}\`
      : escapeHtml(message.meta);
    return \`
      <article class="message-row commentary">
        <div class="message-meta">\${meta}</div>
        <div class="commentary-live">\${escapeHtml(message.text)}</div>
      </article>
    \`;
  }
  if (message.kind === "commentarySummary") {
    const commentaryId = message.commentaryId || "commentary-" + String(message.time || "");
    const open = activityOpenState.get(commentaryId) ? " open" : "";
    const rows = message.entries.map((entry) => \`
      <div class="commentary-entry">
        <time>\${escapeHtml(new Date(entry.time).toLocaleTimeString())}</time>
        <span>\${escapeHtml(entry.text)}</span>
      </div>
    \`).join("");
    return \`
      <article class="message-row system">
        <details class="commentary-sequence \${escapeAttr(message.status || "done")}" data-commentary-id="\${escapeAttr(commentaryId)}"\${open}>
          <summary class="commentary-toggle">
            <strong>Commentary</strong>
            <span class="commentary-count">\${escapeHtml(message.entries.length)} updates</span>
          </summary>
          <div class="commentary-detail-list">\${rows}</div>
        </details>
      </article>
    \`;
  }
  if (message.kind === "timeline") {
    const rows = message.entries.map((entry) => \`
      <div class="activity-row">
        <strong>\${escapeHtml(entry.label)}</strong>
        <span>\${escapeHtml(entry.text)}</span>
      </div>
    \`).join("");
    const hidden = message.hiddenCount
      ? \`<div class="activity-muted">\${escapeHtml(message.hiddenCount)} earlier events hidden</div>\`
      : "";
    const activityId = message.activityId || "activity-" + String(message.time || message.title || "");
    const open = activityOpenState.get(activityId) ? " open" : "";
    return \`
      <article class="message-row system">
        <details class="activity-sequence \${escapeAttr(message.status || "done")}" data-activity-id="\${escapeAttr(activityId)}"\${open}>
          <summary class="activity-toggle">
            <strong>\${escapeHtml(message.title || message.meta)}</strong>
            <span class="activity-count">\${escapeHtml(message.status || "done")} · \${escapeHtml(message.entries.length)} steps</span>
          </summary>
          <div class="activity-detail-list">
            \${rows}
            \${hidden}
          </div>
        </details>
      </article>
    \`;
  }
  if (message.kind === "approval") {
    const actions = \`<div class="approval-actions">
          <button type="button" data-approval-id="\${escapeAttr(message.approvalId)}" data-approval-action="declined">Decline</button>
          \${message.canApproveSession ? \`<button type="button" data-approval-id="\${escapeAttr(message.approvalId)}" data-approval-action="approved-session">Approve Tool</button>\` : ""}
          <button type="button" data-approval-id="\${escapeAttr(message.approvalId)}" data-approval-action="approved">Approve</button>
        </div>\`;
    return \`
      <article class="message-row system">
        <div class="message-meta">\${escapeHtml(message.meta)}</div>
        <div class="approval-card">
          <div class="approval-title">Approval requested</div>
          <div class="approval-detail">\${escapeHtml(message.text)}</div>
          \${actions}
        </div>
      </article>
    \`;
  }
  if (message.pending) {
    return \`<div class="message-row status"><div class="pending-message">\${escapeHtml(message.text)}</div></div>\`;
  }
  const meta = message.time ? \`\${escapeHtml(message.meta)} · \${escapeHtml(new Date(message.time).toLocaleTimeString())}\` : escapeHtml(message.meta);
  return \`
    <article class="message-row \${escapeAttr(message.kind)}">
      \${meta ? \`<div class="message-meta">\${meta}</div>\` : ""}
      <div class="message-bubble \${escapeAttr(message.kind)}">\${escapeHtml(message.text)}</div>
    </article>
  \`;
}

function approvalText(payload) {
  const kind = String(payload.kind || "approval");
  const params = payload.params && typeof payload.params === "object" ? payload.params : {};
  const tool = approvalToolLabel(params);
  if (tool) {
    const paramsText = approvalParamsText(params);
    return [
      kind,
      \`Tool: \${tool}\`,
      params.message ? String(params.message) : "",
      paramsText ? \`Params:\\n\${paramsText}\` : "",
    ].filter(Boolean).join("\\n");
  }
  if (Array.isArray(params.command)) {
    return \`\${kind}\\nCommand: \${params.command.join(" ")}\\nDirectory: \${params.cwd || ""}\`;
  }
  if (params.permissions) {
    return \`\${kind}\\nPermissions: \${JSON.stringify(params.permissions, null, 2)}\`;
  }
  if (params.message) {
    return \`\${kind}\\n\${params.message}\`;
  }
  return \`\${kind}\\n\${JSON.stringify(params, null, 2)}\`;
}

function approvalParamsText(params) {
  const metadata = params._meta && typeof params._meta === "object" ? params._meta : {};
  const toolParams = metadata.tool_params;
  if (!toolParams || typeof toolParams !== "object") {
    return "";
  }
  return truncateText(JSON.stringify(toolParams, null, 2), 1800);
}

function approvalToolLabel(params) {
  const metadata = params._meta && typeof params._meta === "object" ? params._meta : {};
  const serverName = typeof params.serverName === "string" ? params.serverName : "";
  const toolName = typeof metadata.tool_title === "string"
    ? metadata.tool_title
    : toolNameFromApprovalMessage(params.message);
  return serverName && toolName ? serverName + "/" + toolName : "";
}

function toolNameFromApprovalMessage(value) {
  if (typeof value !== "string") return "";
  const match = value.match(/\\btool\\s+"([^"]+)"/i);
  return match && match[1] ? match[1].trim() : "";
}

function truncateText(value, maxLength) {
  const text = String(value);
  return text.length <= maxLength ? text : text.slice(0, maxLength - 3) + "...";
}

function canApproveApprovalForSession(payload) {
  const params = payload.params && typeof payload.params === "object" ? payload.params : {};
  const metadata = params._meta && typeof params._meta === "object" ? params._meta : {};
  return payload.method === "mcpServer/elicitation/request" &&
    Array.isArray(metadata.persist) &&
    metadata.persist.includes("session") &&
    Boolean(approvalToolLabel(params));
}

function bindApprovalButtons() {
  for (const button of messages.querySelectorAll("[data-approval-action]")) {
    button.addEventListener("click", () => {
      void resolveApproval(button.dataset.approvalId, button.dataset.approvalAction);
    });
  }
}

async function resolveApproval(approvalId, decision) {
  if (!approvalId || !decision) return;
  const approved = decision === "approved" || decision === "approved-session";
  const scope = decision === "approved-session" ? "session" : "once";
  for (const button of messages.querySelectorAll("[data-approval-id]")) {
    if (button.dataset.approvalId === approvalId) {
      button.disabled = true;
    }
  }
  const response = await fetch("/api/approvals/" + encodeURIComponent(approvalId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: approved ? "approved" : "declined", scope }),
  });
  const body = await response.json();
  if (!response.ok) {
    toast(body.error || "Approval failed", "error");
    await refresh();
    return;
  }
  toast(approved ? (scope === "session" ? "Tool approved for session" : "Approval sent") : "Approval declined");
  await refresh();
}

function agentName(agentId) {
  return agents.find((agent) => agent.id === agentId)?.name || agentId;
}

function toast(message, type = "info") {
  const node = document.createElement("div");
  node.className = "toast " + type;
  node.textContent = message;
  toasts.appendChild(node);
  setTimeout(() => node.remove(), 3500);
}

function renderMessagesIfChanged(nextHtml) {
  if (nextHtml === lastMessagesHtml) return;
  captureActivityScrollPositions();
  const shouldStickToBottom = forceLatestMessage || (isScrolledNearBottom(messages) && Date.now() > activityInteractionPauseUntil);
  messages.innerHTML = nextHtml;
  lastMessagesHtml = nextHtml;
  bindApprovalButtons();
  bindActivityToggles();
  messages.querySelector("[data-load-older]")?.addEventListener("click", loadOlderEvents);
  restoreActivityScrollPositions();
  if (shouldStickToBottom) {
    scrollDown();
  }
  forceLatestMessage = false;
}

function closeAgentSettings() {
  agentSettingsModal.hidden = true;
}

function bindActivityToggles() {
  const presentActivityIds = new Set();
  for (const details of messages.querySelectorAll("[data-activity-id], [data-commentary-id]")) {
    const activityId = details.dataset.activityId || details.dataset.commentaryId;
    if (!activityId) continue;
    presentActivityIds.add(activityId);
    details.addEventListener("toggle", () => {
      activityOpenState.set(activityId, details.open);
      markActivityInteraction();
    });
    details.addEventListener("pointerdown", markActivityInteraction);
    const detailList = details.querySelector(".activity-detail-list, .commentary-detail-list");
    if (detailList) {
      detailList.addEventListener("scroll", () => {
        activityScrollState.set(activityId, detailList.scrollTop);
        markActivityInteraction();
      }, { passive: true });
      detailList.addEventListener("pointerdown", markActivityInteraction);
      detailList.addEventListener("wheel", markActivityInteraction, { passive: true });
    }
  }
  for (const activityId of activityScrollState.keys()) {
    if (!presentActivityIds.has(activityId)) {
      activityScrollState.delete(activityId);
    }
  }
}

function captureActivityScrollPositions() {
  for (const details of messages.querySelectorAll("[data-activity-id], [data-commentary-id]")) {
    const activityId = details.dataset.activityId || details.dataset.commentaryId;
    const detailList = details.querySelector(".activity-detail-list, .commentary-detail-list");
    if (activityId && detailList) {
      activityScrollState.set(activityId, detailList.scrollTop);
    }
  }
}

function restoreActivityScrollPositions() {
  for (const details of messages.querySelectorAll("[data-activity-id], [data-commentary-id]")) {
    const activityId = details.dataset.activityId || details.dataset.commentaryId;
    const detailList = details.querySelector(".activity-detail-list, .commentary-detail-list");
    if (!activityId || !detailList) continue;
    const scrollTop = activityScrollState.get(activityId);
    if (typeof scrollTop === "number") {
      detailList.scrollTop = scrollTop;
    }
  }
}

function markActivityInteraction() {
  activityInteractionPauseUntil = Date.now() + 3000;
}

function isScrolledNearBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

function scrollDown() {
  const applyLatestPosition = () => {
    messages.scrollTop = messages.scrollHeight;
    if (window.matchMedia("(max-width: 980px)").matches) {
      window.scrollTo(0, document.documentElement.scrollHeight);
    }
  };
  applyLatestPosition();
  requestAnimationFrame(() => requestAnimationFrame(applyLatestPosition));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

refresh();
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const escapes: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escapes[char] ?? char;
  });
}
