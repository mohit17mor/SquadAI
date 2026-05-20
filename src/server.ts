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
        <div class="connection"><span id="connection-dot" class="dot"></span><span id="connection">Connecting</span></div>
      </div>
      <section class="panel">
        <div class="section-head">
          <h2>Create Agent</h2>
          <span>runtime</span>
        </div>
        <form id="agent-form">
          <label>ID<input name="id" autocomplete="off" placeholder="maintenance"></label>
          <label>Name<input name="name" autocomplete="off" placeholder="Maintenance Debugger"></label>
          <label>Working directory<input name="cwd" autocomplete="off" value="${escapeHtml(process.cwd())}"></label>
          <label>Instructions<textarea name="instructions" rows="5" placeholder="You specialize in..."></textarea></label>
          <button id="create-agent-button" type="submit">Create Agent</button>
        </form>
      </section>
      <section class="panel">
        <div class="section-head">
          <h2>Agents</h2>
          <span id="agent-count">0</span>
        </div>
        <div id="agents" class="agents"></div>
      </section>
    </aside>
    <section class="workspace chat-stream">
      <header class="topbar">
        <div>
          <h2 id="selected-title">No agent selected</h2>
          <p id="selected-meta">Create or select an agent to begin.</p>
        </div>
        <button id="refresh" type="button" class="secondary">Refresh</button>
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
button, input, textarea { font: inherit; }
button { border: 1px solid #30363d; background: #1f6feb; color: #fff; border-radius: 8px; padding: 9px 13px; cursor: pointer; font-weight: 600; transition: background .15s, border-color .15s, opacity .15s; }
button:hover { background: #388bfd; }
button:disabled { opacity: .5; cursor: not-allowed; }
button.secondary { background: #161b22; color: #e6edf3; }
button.secondary:hover { border-color: #58a6ff; background: #1c2128; }
.shell { display: grid; grid-template-columns: 360px minmax(0, 1fr); height: 100vh; }
.sidebar { background: #161b22; border-right: 1px solid #30363d; display: flex; flex-direction: column; min-height: 0; overflow: auto; }
.brand { padding: 18px 20px; display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid #30363d; }
h1 { margin: 0; font-size: 18px; letter-spacing: -.2px; }
h2 { margin: 0; font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: .08em; }
.connection { display: flex; align-items: center; gap: 7px; color: #8b949e; font-size: 12px; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 999px; background: #f85149; display: inline-block; }
.dot.connected { background: #3fb950; }
.panel { padding: 16px 18px; border-bottom: 1px solid #30363d; }
.section-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; }
.section-head span { color: #8b949e; font-size: 12px; }
label { display: grid; gap: 6px; margin-bottom: 10px; color: #8b949e; font-size: 12px; }
input, textarea { width: 100%; border: 1px solid #30363d; border-radius: 8px; padding: 9px 11px; background: #0d1117; color: #e6edf3; outline: none; }
input:focus, textarea:focus { border-color: #58a6ff; }
textarea { resize: vertical; }
.agents { display: grid; gap: 8px; }
.empty { color: #8b949e; font-size: 13px; padding: 12px; border: 1px dashed #30363d; border-radius: 10px; }
.agent { width: 100%; background: #0d1117; color: #e6edf3; text-align: left; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; border: 1px solid #30363d; }
.agent.active { border-color: #58a6ff; box-shadow: 0 0 0 1px rgba(88,166,255,.3) inset; }
.agent strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent .sub { grid-column: 1 / -1; color: #8b949e; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
@media (max-width: 850px) { body { overflow: auto; } .shell { grid-template-columns: 1fr; height: auto; min-height: 100vh; } .sidebar { max-height: none; } .workspace { min-height: 70vh; } .message-row { max-width: 92%; } }
`;
}

function js(): string {
  return `
let agents = [];
let selectedAgentId = null;
let events = [];
let pendingMessages = [];
let sendInFlight = false;

const agentList = document.getElementById("agents");
const messages = document.getElementById("messages");
const selectedTitle = document.getElementById("selected-title");
const selectedMeta = document.getElementById("selected-meta");
const connection = document.getElementById("connection");
const connectionDot = document.getElementById("connection-dot");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message");
const agentCount = document.getElementById("agent-count");
const toasts = document.getElementById("toasts");

document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("agent-form").addEventListener("submit", createAgent);
messageForm.addEventListener("submit", sendMessage);
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
  agentCount.textContent = String(agents.length);
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
  selectedAgentId = result.agent.id;
  event.currentTarget.reset();
  await refresh();
  toast("Agent created");
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
  agentList.innerHTML = agents.map((agent) => \`
    <button class="agent \${agent.id === selectedAgentId ? "active" : ""}" data-agent-id="\${escapeAttr(agent.id)}">
      <strong>\${escapeHtml(agent.name)}</strong>
      <span class="status-pill \${escapeAttr(agent.status)}">\${escapeHtml(agent.status)}</span>
      <span class="sub">\${escapeHtml(agent.id)} - \${escapeHtml(agent.cwd)}</span>
    </button>
  \`).join("") || '<div class="empty">No agents yet. Create one from the form above.</div>';
  for (const button of agentList.querySelectorAll(".agent")) {
    button.addEventListener("click", () => {
      selectedAgentId = button.dataset.agentId;
      render();
    });
  }
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  selectedTitle.textContent = selected ? selected.name : "No agent selected";
  selectedMeta.textContent = selected ? \`\${selected.id} - \${selected.status} - \${selected.cwd}\` : "Create or select an agent to begin.";
  const visibleEvents = selectedAgentId ? events.filter((item) => item.agentId === selectedAgentId) : events;
  dedupePendingMessages(visibleEvents);
  const hasCompletion = visibleEvents.some((event) => event.type === "turn_completed" || event.type === "turn_failed");
  const hasTurnStarted = visibleEvents.some((event) => event.type === "turn_started");
  const persistedMessages = visibleEvents.flatMap((event) => eventToMessages(event, {
    hasCompletion,
    hasTurnStarted,
  }));
  const localMessages = pendingMessages
    .filter((item) => !selectedAgentId || item.agentId === selectedAgentId)
    .flatMap((item) => [
      { kind: "user", meta: "You", text: item.text },
      { kind: "status", meta: "", text: "Agent is working", pending: true },
    ]);
  const rendered = [...persistedMessages, ...localMessages];
  messages.innerHTML = rendered.map(renderMessage).join("") || '<div class="empty">No messages yet. Send the first instruction to this agent.</div>';
  scrollDown();
}

function dedupePendingMessages(visibleEvents) {
  const startedTexts = new Set(
    visibleEvents
      .filter((event) => event.type === "turn_started" && event.payload && event.payload.input)
      .map((event) => String(event.payload.input)),
  );
  if (!startedTexts.size) return;
  pendingMessages = pendingMessages.filter((item) => !startedTexts.has(item.text));
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
  if (event.type === "agent_starting") {
    return state.hasTurnStarted || state.hasCompletion
      ? []
      : [{ kind: "status", meta: "", text: "Starting agent session", pending: true, time: event.createdAt }];
  }
  if (event.type === "agent_started") {
    return state.hasCompletion ? [] : [{ kind: "system", meta: "", text: "Agent session ready", time: event.createdAt }];
  }
  return [{ kind: "system", meta: "", text: event.type + ": " + event.message, time: event.createdAt }];
}

function renderMessage(message) {
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
