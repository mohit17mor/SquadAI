import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import type { CodexAgentManager } from "./manager.js";
import type {
  AgentDefinition,
  AgentDefinitionUpdate,
  AgentEvent,
  ApprovalScope,
  AskOptions,
  SensorEventInput,
} from "./types.js";

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
      this.kickAutomation();
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

      if (request.method === "GET" && url.pathname === "/api/agents") {
        this.json(response, { agents: this.options.manager.listAgents() });
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

      if (request.method === "GET" && url.pathname === "/api/sensor-events") {
        this.json(response, { events: this.options.manager.listSensorEvents() });
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
  if (model) {
    definition.model = model;
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
  if (name) {
    update.name = name;
  }
  if (cwd) {
    update.cwd = cwd;
  }
  if (instructions) {
    update.instructions = instructions;
  }
  if (model !== undefined) {
    update.model = model;
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
  <main class="shell">
    <nav class="command-rail">
      <div class="brand">
        <h1>${escapeHtml(title)}</h1>
      </div>
      <div class="rail-nav" aria-label="Command center sections">
        <button type="button" class="rail-item" data-panel="agents">Agents <span id="agent-count">0</span></button>
        <button type="button" class="rail-item" data-panel="create">Create Agent</button>
        <button type="button" class="rail-item" data-panel="events">Event Inbox <span id="event-count">0</span></button>
        <button type="button" class="rail-item" data-panel="work">Work Queue <span id="work-count">0</span></button>
      </div>
      <div class="rail-footer">
        <span id="connection-dot" class="dot"></span>
        <span id="connection">Connecting</span>
      </div>
    </nav>
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
          <label>Role<select name="role"><option value="">Worker</option><option value="router">Router</option></select></label>
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
        <form id="edit-agent-form" class="agent-editor">
          <div class="section-head">
            <h2>Agent Settings</h2>
            <span id="edit-agent-status">select one</span>
          </div>
          <label>Name<input name="name" autocomplete="off"></label>
          <label>Role<select name="role"><option value="">Worker</option><option value="router">Router</option></select></label>
          <label>Working directory<input name="cwd" autocomplete="off"></label>
          <label>Routing description<textarea name="routingDescription" rows="2"></textarea></label>
          <label>Developer instructions<textarea name="instructions" rows="6"></textarea></label>
          <div class="field-hint">Saving developer instructions or session settings starts a fresh Codex session on the next turn.</div>
          <div class="agent-actions">
            <button type="submit">Save Changes</button>
            <button id="delete-agent-button" type="button" class="danger">Delete</button>
          </div>
        </form>
      </section>
      <section id="panel-events" class="panel-view queue-panel">
        <div class="section-head">
          <h2>Event Inbox</h2>
          <span id="event-panel-count">0</span>
        </div>
        <div id="sensor-events" class="queue-list"></div>
      </section>
      <section id="panel-work" class="panel-view queue-panel">
        <div class="section-head">
          <h2>Work Queue</h2>
          <span id="work-panel-count">0</span>
        </div>
        <div id="work-items" class="queue-list"></div>
      </section>
    </aside>
    <section class="workspace chat-stream">
      <header class="topbar">
        <div>
          <h2 id="selected-title">No agent selected</h2>
          <p id="selected-meta">Create or select an agent to begin.</p>
        </div>
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
    <div id="toasts" class="toasts"></div>
  </main>
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
.agent-editor { margin-top: 16px; padding-top: 16px; border-top: 1px solid #30363d; }
.agent-editor.disabled { opacity: .55; pointer-events: none; }
.agent-actions { display: flex; gap: 8px; justify-content: space-between; }
.agent-actions button { flex: 1; }
.empty { color: #8b949e; font-size: 13px; padding: 12px; border: 1px dashed #30363d; border-radius: 10px; }
.agent { width: 100%; background: #0d1117; color: #e6edf3; text-align: left; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; border: 1px solid #30363d; }
.agent.active { border-color: #58a6ff; box-shadow: 0 0 0 1px rgba(88,166,255,.3) inset; }
.agent strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent .sub { grid-column: 1 / -1; color: #8b949e; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue-list { display: grid; gap: 7px; }
.queue-item { border: 1px solid #30363d; border-radius: 8px; padding: 9px; background: #0d1117; display: grid; gap: 4px; }
.queue-item strong { color: #e6edf3; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue-item .sub { color: #8b949e; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-pill { align-self: start; justify-self: end; border-radius: 999px; padding: 2px 8px; background: #1c2128; color: #8b949e; font-size: 11px; font-weight: 700; }
.status-pill.running, .status-pill.starting { background: rgba(210,153,34,.15); color: #d29922; }
.status-pill.idle { background: rgba(63,185,80,.12); color: #3fb950; }
.status-pill.failed { background: rgba(248,81,73,.14); color: #f85149; }
.workspace { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; min-height: 0; }
.topbar { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 22px; background: #161b22; border-bottom: 1px solid #30363d; }
.topbar h2 { text-transform: none; letter-spacing: 0; color: #e6edf3; font-size: 18px; margin: 0; }
.topbar p { margin: 4px 0 0; color: #8b949e; font-size: 13px; overflow-wrap: anywhere; }
.message-list { overflow-y: auto; padding: 22px; display: flex; flex-direction: column; gap: 13px; }
.message-list::-webkit-scrollbar { width: 6px; }
.message-list::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
.message-row { display: flex; flex-direction: column; max-width: 78%; gap: 4px; animation: fadeIn .15s ease-out; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
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
.approval-resolved { color: #8b949e; font-size: 12px; text-align: right; }
.work-card { background: #1c2128; border: 1px solid #30363d; border-radius: 8px; padding: 12px; display: grid; gap: 8px; min-width: min(520px, 80vw); max-width: 720px; }
.work-card.failed { border-color: rgba(248,81,73,.55); }
.work-card.done { border-color: rgba(63,185,80,.45); }
.work-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #f0f6fc; font-weight: 700; }
.work-detail { color: #c9d1d9; font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.work-muted { color: #8b949e; font-size: 11px; }
.activity-card { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 12px; display: grid; gap: 8px; min-width: min(520px, 80vw); max-width: 720px; }
.activity-row { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; align-items: start; font-size: 12px; }
.activity-row strong { color: #58a6ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-row span { color: #c9d1d9; overflow-wrap: anywhere; }
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
@media (max-width: 980px) { body { overflow: auto; } .shell { grid-template-columns: 1fr; height: auto; min-height: 100vh; } .command-rail { min-height: auto; } .rail-nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } .side-panel { min-height: 420px; border-right: 0; border-bottom: 1px solid #30363d; } .workspace { min-height: 70vh; } .message-row { max-width: 92%; } }
`;
}

function js(): string {
  return `
let agents = [];
let selectedAgentId = null;
let events = [];
let sensorEvents = [];
let workItems = [];
let pendingMessages = [];
let sendInFlight = false;
let activePanel = "agents";
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

const agentList = document.getElementById("agents");
const messages = document.getElementById("messages");
const selectedTitle = document.getElementById("selected-title");
const selectedMeta = document.getElementById("selected-meta");
const connection = document.getElementById("connection");
const connectionDot = document.getElementById("connection-dot");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message");
const agentCount = document.getElementById("agent-count");
const eventCount = document.getElementById("event-count");
const workCount = document.getElementById("work-count");
const agentPanelCount = document.getElementById("agent-panel-count");
const eventPanelCount = document.getElementById("event-panel-count");
const workPanelCount = document.getElementById("work-panel-count");
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
let agentIdTouched = false;
let createInstructionsTouched = false;
let editAgentLoadedId = null;
let editAgentDirty = false;

document.getElementById("refresh").addEventListener("click", refresh);
for (const button of document.querySelectorAll("[data-panel]")) {
  button.addEventListener("click", () => {
    activePanel = button.dataset.panel || "agents";
    renderPanel();
  });
}
const agentForm = document.getElementById("agent-form");
const createRoleSelect = agentForm.elements.role;
const createInstructionsInput = agentForm.elements.instructions;
agentForm.addEventListener("submit", createAgent);
agentForm.addEventListener("input", (event) => {
  if (event.target === createInstructionsInput) {
    createInstructionsTouched = true;
  }
});
createRoleSelect.addEventListener("change", applyCreateRoleDefaults);
editAgentForm.addEventListener("submit", updateSelectedAgent);
editAgentForm.addEventListener("input", () => {
  editAgentDirty = true;
});
deleteAgentButton.addEventListener("click", deleteSelectedAgent);
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
  render();
});

async function refresh() {
  await Promise.all([refreshAgents(), refreshEvents(), refreshQueues()]);
  render();
}

async function refreshAgents() {
  const response = await fetch("/api/agents");
  const body = await response.json();
  agents = body.agents;
  if (!selectedAgentId && agents.length) selectedAgentId = agents[0].id;
  agentCount.textContent = String(agents.length);
  agentPanelCount.textContent = String(agents.length);
}

function upsertAgent(agent) {
  const index = agents.findIndex((item) => item.id === agent.id);
  if (index >= 0) {
    agents[index] = agent;
  } else {
    agents = [...agents, agent];
  }
  agentCount.textContent = String(agents.length);
  agentPanelCount.textContent = String(agents.length);
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
  eventCount.textContent = String(sensorEvents.length);
  eventPanelCount.textContent = String(sensorEvents.length);
  workCount.textContent = String(workItems.length);
  workPanelCount.textContent = String(workItems.length);
  renderQueues();
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
  activePanel = "agents";
  editAgentDirty = false;
  editAgentLoadedId = null;
  event.currentTarget.reset();
  agentIdTouched = false;
  createInstructionsTouched = false;
  updateDerivedAgentId();
  applyCreateRoleDefaults();
  await refreshAgents();
  await refreshEvents();
  render();
  toast("Agent created");
}

function applyCreateRoleDefaults() {
  if (createRoleSelect.value === "router") {
    if (!createInstructionsTouched || !createInstructionsInput.value.trim()) {
      createInstructionsInput.value = defaultRouterInstructions;
      createInstructionsTouched = false;
    }
    return;
  }
  if (!createInstructionsTouched && createInstructionsInput.value === defaultRouterInstructions) {
    createInstructionsInput.value = "";
  }
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
  editAgentDirty = false;
  editAgentLoadedId = null;
  await refreshAgents();
  await refreshEvents();
  render();
  toast("Agent deleted");
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
  agentList.innerHTML = agents.map((agent) => \`
    <button class="agent \${agent.id === selectedAgentId ? "active" : ""}" data-agent-id="\${escapeAttr(agent.id)}">
      <strong>\${escapeHtml(agent.name)}</strong>
      <span class="status-pill \${escapeAttr(agent.status)}">\${escapeHtml(agent.status)}</span>
      <span class="sub">\${escapeHtml(agent.id)} - \${escapeHtml(agent.cwd)}</span>
    </button>
  \`).join("") || '<div class="empty">No agents yet. Create one from the Create Agent section.</div>';
  for (const button of agentList.querySelectorAll(".agent")) {
    button.addEventListener("click", () => {
      selectedAgentId = button.dataset.agentId;
      editAgentDirty = false;
      render();
    });
  }
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  selectedTitle.textContent = selected ? selected.name : "No agent selected";
  selectedMeta.textContent = selected ? \`\${selected.id} - \${selected.status} - \${selected.cwd}\` : "Create or select an agent to begin.";
  renderAgentEditor(selected);
  const visibleEvents = selectedAgentId ? events.filter((item) => item.agentId === selectedAgentId) : [];
  dedupePendingMessages(visibleEvents);
  const hasCompletion = visibleEvents.some((event) => event.type === "turn_completed" || event.type === "turn_failed");
  const hasTurnStarted = visibleEvents.some((event) => event.type === "turn_started");
  const activeTurnPending = hasActiveTurnPending(visibleEvents);
  const resolvedApprovals = approvalResolutionMap(visibleEvents);
  const workSummaries = summarizeWorkEvents(visibleEvents);
  const workEventIds = new Set(workSummaries.flatMap((summary) => summary.eventIds));
  const activitySummaries = summarizeActivityEvents(visibleEvents);
  const activityEventIds = new Set(activitySummaries.flatMap((summary) => summary.eventIds));
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
    && !activitySummaries.some((summary) => summary.status === "running")
    ? [{ kind: "status", meta: "", text: "Agent is working", pending: true }]
    : [];
  const rendered = [
    ...persistedMessages,
    ...workSummaries.map(workSummaryToMessage),
    ...activitySummaries.map(activitySummaryToMessage),
    ...localMessages,
    ...workingMessage,
  ].sort((left, right) => {
    return Date.parse(left.time || "") - Date.parse(right.time || "");
  });
  messages.innerHTML = rendered.map(renderMessage).join("") || '<div class="empty">Create or select an agent to begin.</div>';
  bindApprovalButtons();
  renderQueues();
  scrollDown();
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
  editAgentForm.elements.role.value = selected.metadata?.role === "router" ? "router" : "";
  editAgentForm.elements.cwd.value = selected.cwd || "";
  editAgentForm.elements.routingDescription.value = selected.metadata?.routingDescription || "";
  editAgentForm.elements.instructions.value = selected.instructions || "";
}

function renderPanel() {
  const titles = {
    agents: ["Agents", "Select an agent and watch its conversation on the right."],
    create: ["Create Agent", "Add a specialized Codex session to the command center."],
    events: ["Event Inbox", "Sensor events waiting to be routed or already routed."],
    work: ["Work Queue", "Worker-owned items created by the router."],
  };
  const [title, subtitle] = titles[activePanel] || titles.agents;
  panelTitle.textContent = title;
  panelSubtitle.textContent = subtitle;
  for (const button of document.querySelectorAll("[data-panel]")) {
    button.classList.toggle("active", button.dataset.panel === activePanel);
  }
  for (const view of document.querySelectorAll(".panel-view")) {
    view.classList.toggle("active", view.id === "panel-" + activePanel);
  }
}

function renderQueues() {
  eventCount.textContent = String(sensorEvents.length);
  eventPanelCount.textContent = String(sensorEvents.length);
  workCount.textContent = String(workItems.length);
  workPanelCount.textContent = String(workItems.length);
  sensorEventList.innerHTML = sensorEvents.slice(-5).reverse().map((event) => \`
    <div class="queue-item">
      <strong>\${escapeHtml(event.title || event.type)}</strong>
      <span class="sub">\${escapeHtml(event.source)} - \${escapeHtml(event.status)} - \${escapeHtml(event.id)}</span>
      <span class="sub">\${escapeHtml(event.body)}</span>
    </div>
  \`).join("") || '<div class="empty">No sensor events yet.</div>';
  workItemList.innerHTML = workItems.slice(-5).reverse().map((item) => \`
    <div class="queue-item">
      <strong>\${escapeHtml(item.targetAgentId)} - \${escapeHtml(item.status)}</strong>
      <span class="sub">\${escapeHtml(item.id)}\${item.eventId ? " from " + escapeHtml(item.eventId) : ""}</span>
      <span class="sub">\${escapeHtml(item.prompt)}</span>
    </div>
  \`).join("") || '<div class="empty">No work queued yet.</div>';
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

function workSummaryToMessage(summary) {
  const workItem = workItems.find((item) => item.id === summary.workItemId);
  const status = workItem ? workItem.status : summary.status;
  const detail = workItem?.failureReason || workItem?.result || summary.detail || "";
  return {
    kind: "work",
    meta: "Work queue",
    text: detail,
    status,
    workItemId: summary.workItemId,
    sensorEventId: workItem?.eventId || summary.sensorEventId || "",
    time: workItem?.updatedAt || summary.updatedAt,
    prompt: workItem?.prompt || "",
  };
}

function summarizeActivityEvents(visibleEvents) {
  const summaries = [];
  let current = null;
  for (const event of visibleEvents) {
    if (event.type === "turn_started") {
      if (current && current.entries.length) {
        summaries.push(current);
      }
      current = {
        eventIds: [],
        entries: [],
        status: "running",
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      };
      continue;
    }
    if (event.type === "codex_item_completed") {
      if (!current) {
        current = {
          eventIds: [],
          entries: [],
          status: "running",
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
    if (event.type === "codex_thread_compacted") {
      if (!current) {
        current = {
          eventIds: [],
          entries: [],
          status: "running",
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
        };
      }
      current.eventIds.push(event.id);
      current.updatedAt = event.createdAt;
      current.entries.push({
        itemType: "memory",
        title: "Thread compacted",
        summary: "Conversation history was compacted.",
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

function activitySummaryToMessage(summary) {
  return {
    kind: "activity",
    meta: "Codex activity",
    status: summary.status,
    entries: summary.entries.slice(-8),
    hiddenCount: Math.max(0, summary.entries.length - 8),
    time: summary.updatedAt,
  };
}

function eventToMessages(event, state) {
  if (event.type === "turn_started") {
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
    return [{
      kind: "approval",
      meta: "Approval needed",
      text: approvalText(event.payload || {}),
      approvalId,
      resolvedDecision: resolved && resolved.payload ? String(resolved.payload.decision || "") : "",
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

function renderMessage(message) {
  if (message.kind === "activity") {
    const rows = message.entries.map((entry) => \`
      <div class="activity-row">
        <strong>\${escapeHtml(entry.itemType)}</strong>
        <span>\${escapeHtml(entry.title)}\${entry.summary ? " - " + escapeHtml(entry.summary) : ""}</span>
      </div>
    \`).join("");
    const hidden = message.hiddenCount
      ? \`<div class="work-muted">\${escapeHtml(message.hiddenCount)} earlier events hidden</div>\`
      : "";
    return \`
      <article class="message-row system">
        <div class="message-meta">\${escapeHtml(message.meta)} · \${escapeHtml(new Date(message.time).toLocaleTimeString())}</div>
        <div class="activity-card">
          <div class="work-title">
            <span>Activity</span>
            <span class="status-pill \${escapeAttr(message.status || "running")}">\${escapeHtml(message.status || "running")}</span>
          </div>
          \${rows}
          \${hidden}
        </div>
      </article>
    \`;
  }
  if (message.kind === "work") {
    const status = message.status || "queued";
    const detail = message.text || message.prompt || "No details yet.";
    return \`
      <article class="message-row system">
        <div class="message-meta">\${escapeHtml(message.meta)} · \${escapeHtml(new Date(message.time).toLocaleTimeString())}</div>
        <div class="work-card \${escapeAttr(status)}">
          <div class="work-title">
            <span>\${escapeHtml(message.workItemId || "Work item")}</span>
            <span class="status-pill \${escapeAttr(status)}">\${escapeHtml(status)}</span>
          </div>
          \${message.sensorEventId ? \`<div class="work-muted">From \${escapeHtml(message.sensorEventId)}</div>\` : ""}
          <div class="work-detail">\${escapeHtml(detail)}</div>
        </div>
      </article>
    \`;
  }
  if (message.kind === "approval") {
    const resolved = message.resolvedDecision
      ? \`<div class="approval-resolved">Resolved: \${escapeHtml(message.resolvedDecision)}</div>\`
      : \`<div class="approval-actions">
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
          \${resolved}
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
