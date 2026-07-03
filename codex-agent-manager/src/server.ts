import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { AddressInfo } from "node:net";

import type { CodexAgentManager } from "./manager.js";
import type {
  AgentDefinition,
  AgentDefinitionUpdate,
  AgentEvent,
  ApprovalScope,
  AskOptions,
  CompatibilityApprovalResolution,
  ReasoningEffort,
  SensorEventInput,
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

export type CommandCenterServerOptions = {
  manager: CodexAgentManager;
  title?: string;
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

  constructor(private readonly options: CommandCenterServerOptions) {
    this.title = options.title ?? "Jarvis Command Center";
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    options.manager.on("event", (event) => {
      this.broadcast(event as AgentEvent);
      if (![
        "sensor_event_ingested",
        "work_item_created",
        "sensor_event_routed",
      ].includes((event as AgentEvent).type)) {
        this.kickAutomation();
      }
    });
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
  }

  async close(): Promise<void> {
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

      if (request.method === "GET" && url.pathname === "/api/model-options") {
        const includeHidden = url.searchParams.get("includeHidden") === "true";
        this.json(response, await this.options.manager.listModelOptions({ includeHidden }));
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
        this.json(response, { events: this.options.manager.listEvents(agentId) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/events/stream") {
        this.sse(response);
        return;
      }

      this.json(response, { error: "Not found" }, 404);
    } catch (error) {
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

  private broadcast(event: AgentEvent): void {
    const data = `event: agent-event\ndata: ${JSON.stringify(event)}\n\n`;
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
  const metadata = asOptionalRecord(value.metadata);
  const reasoningEffort = optionalEnum(value.reasoningEffort, REASONING_EFFORTS);
  const serviceTier = optionalString(value.serviceTier);
  if (model) {
    definition.model = model;
  }
  if (reasoningEffort) {
    definition.reasoningEffort = reasoningEffort;
  }
  if (serviceTier) {
    definition.serviceTier = serviceTier;
  }
  if (approvalPolicy) {
    definition.approvalPolicy = approvalPolicy;
  }
  if (sandbox) {
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
  const metadata = asOptionalRecord(value.metadata);
  const reasoningEffort = optionalEnum(value.reasoningEffort, REASONING_EFFORTS);
  const serviceTier = optionalString(value.serviceTier);
  if (name) {
    update.name = name;
  }
  if (cwd) {
    update.cwd = cwd;
  }
  if (instructions) {
    update.instructions = instructions;
  }
  if ("model" in value) {
    update.model = model;
  }
  if ("reasoningEffort" in value) {
    update.reasoningEffort = reasoningEffort;
  }
  if ("serviceTier" in value) {
    update.serviceTier = serviceTier;
  }
  if (approvalPolicy) {
    update.approvalPolicy = approvalPolicy;
  }
  if (sandbox) {
    update.sandbox = sandbox;
  }
  if (metadata) {
    update.metadata = metadata;
  }
  return update;
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
  <main id="shell" class="shell">
    <nav class="command-rail">
      <div class="brand">
        <h1>${escapeHtml(title)}</h1>
      </div>
      <div class="rail-nav" aria-label="Command center sections">
        <button type="button" class="rail-item" data-panel="topology">Topology</button>
        <button type="button" class="rail-item" data-panel="jarvis">Jarvis</button>
        <button type="button" class="rail-item" data-panel="agents">Agents <span id="agent-count">0</span></button>
        <button type="button" class="rail-item" data-panel="create">Create Agent</button>
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
        <div class="section-head">
          <h2>Create Agent</h2>
          <span>runtime</span>
        </div>
        <form id="agent-form">
          <label>Name<input id="agent-name" name="name" autocomplete="off" placeholder="Maintenance Debugger"></label>
          <label>ID (optional)<input id="agent-id" name="id" autocomplete="off" placeholder="auto-generated from name"></label>
          <div id="agent-id-hint" class="field-hint">Used in API paths and state. Leave empty to derive from name.</div>
          <label>Role<select name="role"><option value="">Worker</option><option value="router">Router</option><option value="jarvis">Jarvis</option></select></label>
          <label>Model<select name="model" data-model-select><option value="">Default Codex model</option></select></label>
          <label>Thinking<select name="reasoningEffort" data-reasoning-select><option value="">Default</option></select></label>
          <label>Speed<select name="serviceTier" data-service-tier-select><option value="">Default</option></select></label>
          <label>Working directory<input name="cwd" autocomplete="off" value="${escapeHtml(process.cwd())}"></label>
          <label>Routing description<textarea name="routingDescription" rows="2" placeholder="Short capability summary for the router"></textarea></label>
          <label>Instructions<textarea name="instructions" rows="5" placeholder="You specialize in..."></textarea></label>
          <button id="create-agent-button" type="submit">Create Agent</button>
        </form>
      </section>
      <section id="panel-agents" class="panel-view active">
        <div class="section-head">
          <h2>Agents</h2>
          <span id="agent-panel-count">0</span>
        </div>
        <div id="agents" class="agents"></div>
        <details id="agent-settings" class="agent-editor">
          <summary class="settings-summary">
            <span>
              <strong>Agent Settings</strong>
              <small id="edit-agent-status">select one</small>
            </span>
            <span class="settings-caret" aria-hidden="true">&gt;</span>
          </summary>
          <form id="edit-agent-form" class="agent-editor-form">
            <label>Name<input name="name" autocomplete="off"></label>
            <label>Role<select name="role"><option value="">Worker</option><option value="router">Router</option><option value="jarvis">Jarvis</option></select></label>
            <label>Model<select name="model" data-model-select><option value="">Default Codex model</option></select></label>
            <label>Thinking<select name="reasoningEffort" data-reasoning-select><option value="">Default</option></select></label>
            <label>Speed<select name="serviceTier" data-service-tier-select><option value="">Default</option></select></label>
            <label>Working directory<input name="cwd" autocomplete="off"></label>
            <label>Routing description<textarea name="routingDescription" rows="2"></textarea></label>
            <label>Developer instructions<textarea name="instructions" rows="6"></textarea></label>
            <div class="field-hint">Saving developer instructions or session settings starts a fresh Codex session on the next turn.</div>
            <div class="agent-actions">
              <button type="submit">Save Changes</button>
              <button id="delete-agent-button" type="button" class="danger">Delete</button>
            </div>
          </form>
        </details>
      </section>
    </aside>
    <section class="workspace chat-stream">
      <header class="topbar">
        <div>
          <h2 id="selected-title">No agent selected</h2>
          <p id="selected-meta">Create or select an agent to begin.</p>
        </div>
        <button id="cancel-agent-button" type="button" class="danger" hidden>Cancel</button>
      </header>
      <section class="message-list" id="messages"></section>
      <form id="message-form" class="composer">
        <textarea id="message" rows="1" placeholder="Message the selected agent"></textarea>
        <div class="composer-row">
          <label><input id="allow-network" type="checkbox" checked> Network</label>
          <button type="submit">Send</button>
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
.shell.jarvis-mode, .shell.ops-mode, .shell.topology-mode { grid-template-columns: 220px minmax(0, 1fr); }
.shell.jarvis-mode .side-panel, .shell.ops-mode .side-panel, .shell.ops-mode .workspace, .shell.topology-mode .side-panel, .shell.topology-mode .workspace, .shell.topology-mode .ops-workspace { display: none; }
.shell.jarvis-mode .workspace, .shell.ops-mode .ops-workspace { display: grid; grid-column: 2; }
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
#topology-canvas.dragging-node { cursor: grabbing; }
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
.agents { display: grid; gap: 8px; }
.agent-editor { margin-top: 16px; padding-top: 12px; border-top: 1px solid #30363d; }
.settings-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 10px; border: 1px solid #30363d; border-radius: 8px; background: #161b22; cursor: pointer; list-style: none; }
.settings-summary::-webkit-details-marker { display: none; }
.settings-summary:hover { border-color: #58a6ff; background: #1c2128; }
.settings-summary span:first-child { display: grid; gap: 2px; min-width: 0; }
.settings-summary strong { color: #e6edf3; font-size: 13px; }
.settings-summary small { color: #8b949e; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-caret { color: #8b949e; font-weight: 700; transition: transform .15s ease; }
.agent-editor[open] .settings-caret { transform: rotate(90deg); }
.agent-editor-form { padding-top: 12px; }
.agent-editor-form.disabled { opacity: .55; pointer-events: none; }
.agent-actions { display: flex; gap: 8px; justify-content: space-between; }
.agent-actions button { flex: 1; }
.empty { color: #8b949e; font-size: 13px; padding: 12px; border: 1px dashed #30363d; border-radius: 10px; }
.agent { width: 100%; background: #0d1117; color: #e6edf3; text-align: left; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; border: 1px solid #30363d; }
.agent.active { border-color: #58a6ff; box-shadow: 0 0 0 1px rgba(88,166,255,.3) inset; }
.agent strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent .sub { grid-column: 1 / -1; color: #8b949e; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.log-status.queued, .log-status.pending, .log-status.routing, .log-status.running { color: #d29922; }
.log-status.completed, .log-status.routed { color: #3fb950; }
.log-status.failed { color: #f85149; }
.log-message { color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-detail { margin: 0 0 8px 250px; padding: 8px 10px; border-left: 2px solid #30363d; color: #8b949e; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(22,27,34,.65); border-radius: 0 6px 6px 0; }
.log-detail strong { color: #c9d1d9; }
.log-actions { margin: 0 0 10px 250px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.log-actions select { min-width: 180px; padding: 7px 9px; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 7px; }
.log-actions button { padding: 7px 11px; }
.log-empty { display: grid; place-items: center; min-height: 280px; color: #8b949e; border: 1px dashed #30363d; border-radius: 8px; }
.status-pill { align-self: start; justify-self: end; border-radius: 999px; padding: 2px 8px; background: #1c2128; color: #8b949e; font-size: 11px; font-weight: 700; }
.status-pill.running, .status-pill.starting { background: rgba(210,153,34,.15); color: #d29922; }
.status-pill.idle { background: rgba(63,185,80,.12); color: #3fb950; }
.status-pill.failed { background: rgba(248,81,73,.14); color: #f85149; }
.workspace { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; min-height: 0; }
.ops-workspace { display: none; }
.topbar { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 22px; background: #161b22; border-bottom: 1px solid #30363d; }
.topbar h2 { text-transform: none; letter-spacing: 0; color: #e6edf3; font-size: 18px; margin: 0; }
.topbar p { margin: 4px 0 0; color: #8b949e; font-size: 13px; overflow-wrap: anywhere; }
.message-list { overflow-y: auto; padding: 22px; display: flex; flex-direction: column; gap: 13px; }
.message-list::-webkit-scrollbar { width: 6px; }
.message-list::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
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
.composer { background: #161b22; border-top: 1px solid #30363d; padding: 13px 22px; }
.composer textarea { min-height: 44px; max-height: 150px; resize: none; }
.composer-row { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; gap: 12px; }
.composer-row label { display: flex; grid-template-columns: none; align-items: center; gap: 7px; margin: 0; font-size: 13px; }
.composer-row input { width: auto; accent-color: #58a6ff; }
.toasts { position: fixed; right: 18px; bottom: 18px; display: grid; gap: 8px; z-index: 10; }
.toast { background: #1c2128; border: 1px solid #30363d; border-left: 3px solid #58a6ff; color: #e6edf3; border-radius: 8px; padding: 10px 12px; min-width: 220px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
.toast.error { border-left-color: #f85149; }
@media (max-width: 980px) { body { overflow: auto; } .shell, .shell.jarvis-mode, .shell.ops-mode, .shell.topology-mode { grid-template-columns: 1fr; height: auto; min-height: 100vh; } .shell.jarvis-mode .workspace, .shell.ops-mode .ops-workspace, .shell.topology-mode .topology-workspace { grid-column: 1; } .command-rail { min-height: auto; } .rail-nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } .side-panel { min-height: 420px; border-right: 0; border-bottom: 1px solid #30363d; } .workspace { min-height: 70vh; } .ops-workspace { min-height: 70vh; } .topology-workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 68vh auto auto; } .topology-toolbar { flex-wrap: wrap; } .topology-toolbar-group { overflow-x: auto; } .topology-health { margin-left: 0; } .topology-inspector { grid-column: 1; grid-row: 3; max-height: none; border-left: 0; border-top: 1px solid #202638; } .topology-timeline { grid-row: 4; } .message-row { max-width: 92%; } .queue-item { grid-template-columns: 76px minmax(0, 1fr); } .queue-item .queue-message, .queue-actions { grid-column: 1 / -1; } }
`;
}

function js(): string {
  return `
let agents = [];
let selectedAgentId = null;
let events = [];
let sensorEvents = [];
let workItems = [];
let notifications = [];
let compatibilityApprovals = [];
let compatibilitySnapshot = null;
let modelOptions = [];
let pendingMessages = [];
let sendInFlight = false;
let cancelInFlight = false;
let activePanel = "topology";
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
const agentList = document.getElementById("agents");
const messages = document.getElementById("messages");
const selectedTitle = document.getElementById("selected-title");
const selectedMeta = document.getElementById("selected-meta");
const cancelAgentButton = document.getElementById("cancel-agent-button");
const connection = document.getElementById("connection");
const connectionDot = document.getElementById("connection-dot");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message");
const agentCount = document.getElementById("agent-count");
const notificationCount = document.getElementById("notification-count");
const eventCount = document.getElementById("event-count");
const workCount = document.getElementById("work-count");
const agentPanelCount = document.getElementById("agent-panel-count");
const notificationPanelCount = document.getElementById("notification-panel-count");
const eventPanelCount = document.getElementById("event-panel-count");
const workPanelCount = document.getElementById("work-panel-count");
const compatibilityHealth = document.getElementById("compatibility-health");
const notificationList = document.getElementById("notifications-list");
const sensorEventList = document.getElementById("sensor-events");
const workItemList = document.getElementById("work-items");
const toasts = document.getElementById("toasts");
const agentNameInput = document.getElementById("agent-name");
const agentIdInput = document.getElementById("agent-id");
const agentIdHint = document.getElementById("agent-id-hint");
const editAgentForm = document.getElementById("edit-agent-form");
const editAgentStatus = document.getElementById("edit-agent-status");
const deleteAgentButton = document.getElementById("delete-agent-button");
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

document.getElementById("refresh").addEventListener("click", refresh);
opsRefresh.addEventListener("click", refresh);
for (const button of document.querySelectorAll("[data-panel]")) {
  button.addEventListener("click", () => {
    const previousPanel = activePanel;
    activePanel = button.dataset.panel || "agents";
    if (previousPanel !== activePanel) {
      lastMessagesHtml = "";
    }
    render();
  });
}
window.addEventListener("topology:open-agent", (event) => {
  const agentId = event.detail && event.detail.agentId;
  if (!agentId) return;
  selectedAgentId = agentId;
  activePanel = "agents";
  lastMessagesHtml = "";
  editAgentDirty = false;
  render();
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
editAgentForm.addEventListener("submit", updateSelectedAgent);
editAgentForm.addEventListener("input", () => {
  editAgentDirty = true;
});
editAgentForm.elements.model.addEventListener("change", renderModelControls);
deleteAgentButton.addEventListener("click", deleteSelectedAgent);
cancelAgentButton.addEventListener("click", cancelSelectedAgent);
messageForm.addEventListener("submit", sendMessage);
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
  events.push(JSON.parse(message.data));
  void refreshAgents();
  void refreshQueues();
  void refreshNotifications();
  render();
});

async function refresh() {
  await Promise.all([
    refreshAgents(),
    refreshEvents(),
    refreshQueues(),
    refreshNotifications(),
    refreshModelOptions(),
  ]);
  render();
}

async function refreshModelOptions() {
  const response = await fetch("/api/model-options");
  if (!response.ok) {
    return;
  }
  const body = await response.json();
  modelOptions = Array.isArray(body.models) ? body.models : [];
  renderModelControls();
}

async function refreshAgents() {
  const response = await fetch("/api/agents");
  const body = await response.json();
  agents = body.agents;
  if (activePanel === "jarvis") {
    selectedAgentId = jarvisAgent()?.id || null;
  } else if (!selectedAgentId && agents.length) {
    selectedAgentId = agents[0].id;
  }
  agentCount.textContent = String(agents.length);
  agentPanelCount.textContent = String(agents.length);
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
  agentPanelCount.textContent = String(agents.length);
}

function renderModelControls() {
  updateModelSelect(agentForm.elements.model);
  updateModelSelect(editAgentForm.elements.model);
  updateModelDependentSelects(agentForm);
  updateModelDependentSelects(editAgentForm);
}

function updateModelSelect(select) {
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
  const response = await fetch("/api/events");
  const body = await response.json();
  events = body.events;
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
  applyRoleMetadata(body);
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
  activePanel = result.agent.metadata?.role === "jarvis" ? "jarvis" : "agents";
  editAgentDirty = false;
  editAgentLoadedId = null;
  event.currentTarget.reset();
  agentIdTouched = false;
  createInstructionsTouched = false;
  updateDerivedAgentId();
  applyCreateRoleDefaults();
  renderModelControls();
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

async function updateSelectedAgent(event) {
  event.preventDefault();
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  if (!selected) return;
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  applyRoleMetadata(body, selected.metadata || {}, true);
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

function render() {
  renderPanel();
  if (activePanel === "jarvis") {
    const jarvis = jarvisAgent();
    if (selectedAgentId !== jarvis?.id) {
      selectedAgentId = jarvis?.id || null;
      lastMessagesHtml = "";
    }
  } else if (activePanel === "agents" && !agents.some((agent) => agent.id === selectedAgentId)) {
    selectedAgentId = agents[0]?.id || null;
    lastMessagesHtml = "";
  }
  const agentListHtml = agents.map((agent) => \`
    <button class="agent \${agent.id === selectedAgentId ? "active" : ""}" data-agent-id="\${escapeAttr(agent.id)}">
      <strong>\${escapeHtml(agent.name)}</strong>
      <span class="status-pill \${escapeAttr(agent.status)}">\${escapeHtml(agent.status)}</span>
      <span class="sub">\${escapeHtml(agent.id)} - \${escapeHtml(agent.cwd)}</span>
    </button>
  \`).join("") || '<div class="empty">No agents yet. Create one from the Create Agent section.</div>';
  if (agentListHtml !== lastAgentListHtml) {
    agentList.innerHTML = agentListHtml;
    lastAgentListHtml = agentListHtml;
    for (const button of agentList.querySelectorAll(".agent")) {
      button.addEventListener("click", () => {
        selectedAgentId = button.dataset.agentId;
        lastMessagesHtml = "";
        editAgentDirty = false;
        render();
      });
    }
  }
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  selectedTitle.textContent = selected ? selected.name : "No agent selected";
  selectedMeta.textContent = selected ? \`\${selected.id} - \${selected.status} - \${selected.cwd}\` : "Create or select an agent to begin.";
  messageInput.placeholder = selected ? "Message " + selected.name : "Create or select an agent to begin";
  cancelAgentButton.hidden = !(selected && selected.status === "running");
  cancelAgentButton.disabled = cancelInFlight;
  cancelAgentButton.textContent = cancelInFlight ? "Cancelling" : "Cancel";
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
  const activitySummaries = summarizeActivityEvents(visibleEvents, resolvedApprovals);
  const activityEventIds = new Set(activitySummaries.flatMap((summary) => summary.eventIds));
  const timelineMessages = [
    ...workSummaries.map(workSummaryToTimelineMessage),
    ...activitySummaries.map(activitySummaryToTimelineMessage),
  ].filter(Boolean).filter(shouldShowTimelineInChat);
  const persistedMessages = visibleEvents
    .filter((event) => !workEventIds.has(event.id))
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
    && !timelineMessages.some((message) => message.status === "running")
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
  renderMessagesIfChanged(rendered.map(renderMessage).join("") || '<div class="empty">Create or select an agent to begin.</div>');
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
  if (editAgentDirty && editAgentLoadedId === selected.id) {
    return;
  }
  editAgentLoadedId = selected.id;
  editAgentDirty = false;
  editAgentForm.elements.name.value = selected.name || "";
  editAgentForm.elements.role.value = selected.metadata?.role === "router" || selected.metadata?.role === "jarvis"
    ? selected.metadata.role
    : "";
  editAgentForm.elements.model.value = selected.model || "";
  editAgentForm.elements.reasoningEffort.value = selected.reasoningEffort || "";
  editAgentForm.elements.serviceTier.value = selected.serviceTier || "";
  editAgentForm.elements.cwd.value = selected.cwd || "";
  editAgentForm.elements.routingDescription.value = selected.metadata?.routingDescription || "";
  editAgentForm.elements.instructions.value = selected.instructions || "";
  renderModelControls();
}

function renderPanel() {
  const titles = {
    topology: ["Topology", "Live agent, event, and work relationships."],
    jarvis: ["Jarvis", "Talk to the command center as a whole."],
    agents: ["Agents", "Select an agent and watch its conversation on the right."],
    create: ["Create Agent", "Add a specialized Codex session to the command center."],
    notifications: ["Notifications", "Human-attention items from active agents."],
    events: ["Event Inbox", "Sensor events assigned directly, waiting for assignment, or already routed."],
    work: ["Work Queue", "Durable work assigned to worker agents."],
  };
  const [title, subtitle] = titles[activePanel] || titles.agents;
  const opsMode = activePanel === "notifications" || activePanel === "events" || activePanel === "work";
  const topologyMode = activePanel === "topology";
  shell.classList.toggle("jarvis-mode", activePanel === "jarvis");
  shell.classList.toggle("ops-mode", opsMode);
  shell.classList.toggle("topology-mode", topologyMode);
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
      (activePanel === "work" && log.id === "work-items")
    ));
  }
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
      event.workItemId ? ["Work item", event.workItemId] : null,
      event.failureReason ? ["Failure", event.failureReason] : null,
      hasKeys(event.metadata) ? ["Metadata", JSON.stringify(event.metadata, null, 2)] : null,
    ].filter(Boolean);
    const assignableAgents = agents.filter(
      (agent) => agent.metadata?.role !== "router" && agent.metadata?.role !== "jarvis",
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
    const detail = [
      item.eventId ? ["Sensor event", item.eventId] : null,
      item.prompt ? ["Prompt", item.prompt] : null,
      item.result ? ["Result", item.result] : null,
      item.failureReason ? ["Failure", item.failureReason] : null,
      item.reason ? ["Routing reason", item.reason] : null,
    ].filter(Boolean);
    return renderLogRow({
      time: item.updatedAt || item.createdAt,
      source: agent,
      status: item.status + " · " + item.id,
      statusClass: item.status,
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
    summaries.set(workItemId, current);
  }
  return Array.from(summaries.values());
}

function shouldShowTimelineInChat(summary) {
  return summary.status === "running" || summary.status === "failed" || summary.hasApproval || summary.hasCompaction;
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
    if (event.type === "codex_item_completed") {
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
        current.updatedAt = event.createdAt;
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
  if (event.type === "codex_item_completed" || event.type === "codex_thread_compacted") {
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
  const shouldStickToBottom = isScrolledNearBottom(messages) && Date.now() > activityInteractionPauseUntil;
  messages.innerHTML = nextHtml;
  lastMessagesHtml = nextHtml;
  bindApprovalButtons();
  bindActivityToggles();
  restoreActivityScrollPositions();
  if (shouldStickToBottom) {
    scrollDown();
  }
}

function bindActivityToggles() {
  const presentActivityIds = new Set();
  for (const details of messages.querySelectorAll("[data-activity-id]")) {
    const activityId = details.dataset.activityId;
    if (!activityId) continue;
    presentActivityIds.add(activityId);
    details.addEventListener("toggle", () => {
      activityOpenState.set(activityId, details.open);
      markActivityInteraction();
    });
    details.addEventListener("pointerdown", markActivityInteraction);
    const detailList = details.querySelector(".activity-detail-list");
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
  for (const details of messages.querySelectorAll("[data-activity-id]")) {
    const activityId = details.dataset.activityId;
    const detailList = details.querySelector(".activity-detail-list");
    if (activityId && detailList) {
      activityScrollState.set(activityId, detailList.scrollTop);
    }
  }
}

function restoreActivityScrollPositions() {
  for (const details of messages.querySelectorAll("[data-activity-id]")) {
    const activityId = details.dataset.activityId;
    const detailList = details.querySelector(".activity-detail-list");
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
  messages.scrollTop = messages.scrollHeight;
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
