import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import type { CodexAgentManager } from "./manager.js";
import type { AgentDefinition, AgentEvent, AskOptions } from "./types.js";

export type CommandCenterServerOptions = {
  manager: CodexAgentManager;
  title?: string;
};

export class CommandCenterServer {
  private readonly server: http.Server;
  private readonly sseClients = new Set<ServerResponse>();
  private readonly title: string;

  constructor(private readonly options: CommandCenterServerOptions) {
    this.title = options.title ?? "Jarvis Command Center";
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    options.manager.on("event", (event) => this.broadcast(event as AgentEvent));
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
  const definition: AgentDefinition = {
    id: requiredString(value.id, "id"),
    name: requiredString(value.name, "name"),
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
    <aside class="sidebar">
      <div class="brand">
        <h1>${escapeHtml(title)}</h1>
        <span id="connection">connecting</span>
      </div>
      <section class="panel">
        <h2>Create Agent</h2>
        <form id="agent-form">
          <label>ID<input name="id" autocomplete="off" placeholder="maintenance"></label>
          <label>Name<input name="name" autocomplete="off" placeholder="Maintenance Debugger"></label>
          <label>cwd<input name="cwd" autocomplete="off" value="${escapeHtml(process.cwd())}"></label>
          <label>Instructions<textarea name="instructions" rows="5" placeholder="You specialize in..."></textarea></label>
          <button type="submit">Create</button>
        </form>
      </section>
      <section class="panel">
        <h2>Agents</h2>
        <div id="agents" class="agents"></div>
      </section>
    </aside>
    <section class="workspace">
      <header class="topbar">
        <div>
          <h2 id="selected-title">No agent selected</h2>
          <p id="selected-meta">Create or select an agent to begin.</p>
        </div>
        <button id="refresh" type="button">Refresh</button>
      </header>
      <section class="activity" id="activity"></section>
      <form id="message-form" class="composer">
        <textarea id="message" rows="4" placeholder="Send a message to the selected agent"></textarea>
        <div class="composer-row">
          <label><input id="allow-network" type="checkbox" checked> Network</label>
          <button type="submit">Send</button>
        </div>
      </form>
    </section>
  </main>
  <script>${js()}</script>
</body>
</html>`;
}

function css(): string {
  return `
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2933; background: #f6f7f9; }
button, input, textarea { font: inherit; }
.shell { display: grid; grid-template-columns: 360px minmax(0, 1fr); min-height: 100vh; }
.sidebar { border-right: 1px solid #d8dde6; background: #ffffff; padding: 18px; overflow: auto; }
.brand { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 20px; }
h2 { margin: 0 0 10px; font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: #52606d; }
#connection { color: #66788a; font-size: 12px; }
.panel { border-top: 1px solid #e5e8ee; padding-top: 16px; margin-top: 16px; }
label { display: grid; gap: 5px; margin-bottom: 10px; color: #52606d; font-size: 12px; }
input, textarea { width: 100%; border: 1px solid #c9d2df; border-radius: 6px; padding: 8px 10px; background: #fff; color: #1f2933; }
textarea { resize: vertical; }
button { border: 1px solid #1f6feb; background: #1f6feb; color: #fff; border-radius: 6px; padding: 8px 12px; cursor: pointer; }
button:disabled { opacity: .55; cursor: not-allowed; }
.agents { display: grid; gap: 8px; }
.agent { width: 100%; border: 1px solid #d8dde6; background: #fff; color: #1f2933; text-align: left; display: grid; gap: 3px; }
.agent.active { border-color: #1f6feb; background: #eef5ff; }
.agent strong { font-size: 14px; }
.agent span { font-size: 12px; color: #52606d; }
.workspace { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; }
.topbar { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 18px 22px; background: #fff; border-bottom: 1px solid #d8dde6; }
.topbar h2 { text-transform: none; letter-spacing: 0; color: #1f2933; font-size: 18px; margin: 0; }
.topbar p { margin: 4px 0 0; color: #66788a; }
.activity { overflow: auto; padding: 18px 22px; display: grid; align-content: start; gap: 10px; }
.event { background: #fff; border: 1px solid #d8dde6; border-radius: 8px; padding: 10px 12px; }
.event-head { display: flex; justify-content: space-between; gap: 12px; color: #52606d; font-size: 12px; margin-bottom: 6px; }
.event-message { white-space: pre-wrap; overflow-wrap: anywhere; }
.composer { border-top: 1px solid #d8dde6; background: #fff; padding: 14px 22px; }
.composer-row { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.composer-row label { display: flex; grid-template-columns: none; align-items: center; gap: 6px; margin: 0; font-size: 13px; }
.composer-row input { width: auto; }
@media (max-width: 800px) { .shell { grid-template-columns: 1fr; } .sidebar { border-right: 0; border-bottom: 1px solid #d8dde6; } }
`;
}

function js(): string {
  return `
let agents = [];
let selectedAgentId = null;
let events = [];

const agentList = document.getElementById("agents");
const activity = document.getElementById("activity");
const selectedTitle = document.getElementById("selected-title");
const selectedMeta = document.getElementById("selected-meta");
const connection = document.getElementById("connection");

document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("agent-form").addEventListener("submit", createAgent);
document.getElementById("message-form").addEventListener("submit", sendMessage);

const stream = new EventSource("/api/events/stream");
stream.onopen = () => { connection.textContent = "live"; };
stream.onerror = () => { connection.textContent = "reconnecting"; };
stream.addEventListener("agent-event", (message) => {
  events.push(JSON.parse(message.data));
  refreshAgents();
  render();
});

async function refresh() {
  await Promise.all([refreshAgents(), refreshEvents()]);
  render();
}

async function refreshAgents() {
  const response = await fetch("/api/agents");
  const body = await response.json();
  agents = body.agents;
  if (!selectedAgentId && agents.length) selectedAgentId = agents[0].id;
}

async function refreshEvents() {
  const response = await fetch("/api/events");
  const body = await response.json();
  events = body.events;
}

async function createAgent(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  const response = await fetch("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    alert(result.error || "Failed to create agent");
    return;
  }
  selectedAgentId = result.agent.id;
  event.currentTarget.reset();
  await refresh();
}

async function sendMessage(event) {
  event.preventDefault();
  if (!selectedAgentId) return;
  const textarea = document.getElementById("message");
  const message = textarea.value.trim();
  if (!message) return;
  textarea.value = "";
  const allowNetwork = document.getElementById("allow-network").checked;
  const response = await fetch("/api/agents/" + encodeURIComponent(selectedAgentId) + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, options: { network: allowNetwork ? "allow" : "deny" } }),
  });
  const result = await response.json();
  if (!response.ok) alert(result.error || "Send failed");
  await refresh();
}

function render() {
  agentList.innerHTML = agents.map((agent) => \`
    <button class="agent \${agent.id === selectedAgentId ? "active" : ""}" data-agent-id="\${escapeAttr(agent.id)}">
      <strong>\${escapeHtml(agent.name)}</strong>
      <span>\${escapeHtml(agent.id)} · \${escapeHtml(agent.status)}</span>
    </button>
  \`).join("") || "<p>No agents yet.</p>";
  for (const button of agentList.querySelectorAll(".agent")) {
    button.addEventListener("click", () => {
      selectedAgentId = button.dataset.agentId;
      render();
    });
  }
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  selectedTitle.textContent = selected ? selected.name : "No agent selected";
  selectedMeta.textContent = selected ? \`\${selected.id} · \${selected.status} · \${selected.cwd}\` : "Create or select an agent to begin.";
  const visibleEvents = selectedAgentId ? events.filter((event) => event.agentId === selectedAgentId) : events;
  activity.innerHTML = visibleEvents.slice().reverse().map((event) => \`
    <article class="event">
      <div class="event-head"><span>\${escapeHtml(event.type)}</span><time>\${escapeHtml(new Date(event.createdAt).toLocaleString())}</time></div>
      <div class="event-message">\${escapeHtml(event.message)}</div>
    </article>
  \`).join("") || "<p>No activity yet.</p>";
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
