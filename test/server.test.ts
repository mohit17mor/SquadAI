import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CodexAgentManager,
  createCommandCenterServer,
  type CodexControlClientFactory,
} from "../src/index.js";

class ImmediateCodexClient {
  private nextThread = 1;

  async startSession(): Promise<ImmediateCodexSession> {
    return new ImmediateCodexSession(`thread-${this.nextThread++}`);
  }

  async resumeSession(threadId: string): Promise<ImmediateCodexSession> {
    return new ImmediateCodexSession(threadId);
  }

  async close(): Promise<void> {}
}

class ImmediateCodexSession {
  constructor(readonly threadId: string) {}

  async ask(input: string): Promise<{
    finalText: string;
    threadId: string;
    turn: Record<string, unknown>;
  }> {
    return {
      finalText: `received: ${input}`,
      threadId: this.threadId,
      turn: { status: "completed" },
    };
  }
}

function immediateFactory(): CodexControlClientFactory {
  return () => new ImmediateCodexClient();
}

test("command center API creates agents, lists them, sends messages, and exposes events", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const created = await jsonFetch(`${baseUrl}/api/agents`, {
      method: "POST",
      body: {
        id: "maintenance",
        name: "Maintenance Debugger",
        cwd: "/tmp/ops-poc",
        instructions: "You specialize in maintenance debugging.",
      },
    });
    assert.equal(created.agent.id, "maintenance");

    const listed = await jsonFetch(`${baseUrl}/api/agents`);
    assert.equal(listed.agents.length, 1);
    assert.equal(listed.agents[0].status, "idle");

    const sent = await jsonFetch(`${baseUrl}/api/agents/maintenance/messages`, {
      method: "POST",
      body: { message: "hello agent", options: { network: "allow" } },
    });
    assert.equal(sent.result.finalText, "received: hello agent");

    const events = await jsonFetch(`${baseUrl}/api/events`);
    assert.ok(events.events.some((event: { type: string }) => event.type === "turn_completed"));

    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Jarvis Command Center/);
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center API derives an agent id from name when id is omitted", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const created = await jsonFetch(`http://127.0.0.1:${server.port}/api/agents`, {
      method: "POST",
      body: {
        name: "Slack Debugger",
        cwd: "/tmp/ops-poc",
        instructions: "You specialize in Slack workflows.",
      },
    });

    assert.equal(created.agent.id, "slack-debugger");
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center UI exposes chat-style messaging affordances", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const html = await response.text();

    assert.match(html, /chat-stream/);
    assert.match(html, /class="message-list"/);
    assert.match(html, /message-bubble\.user/);
    assert.match(html, /message-bubble\.agent/);
    assert.match(html, /pending-message/);
    assert.match(html, /Agent created/);
    assert.match(html, /Message sent/);
    assert.match(html, /deriveAgentId/);
    assert.match(html, /upsertAgent/);
    assert.match(html, /ID \(optional\)/);
    assert.match(html, /e\.key === "Enter" && !e\.shiftKey/);
    assert.match(html, /dedupePendingMessages/);
    assert.match(html, /hasCompletion/);
    assert.match(html, /Starting agent session/);
    assert.doesNotMatch(html, /slice\(\)\.reverse\(\)/);
  } finally {
    await server.close();
    await manager.close();
  }
});

test("command center inline script parses as JavaScript", async () => {
  const manager = new CodexAgentManager({
    agents: [],
    clientFactory: immediateFactory(),
  });
  const server = createCommandCenterServer({ manager });
  await server.listen(0);

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const html = await response.text();
    const start = html.indexOf("<script>") + "<script>".length;
    const end = html.lastIndexOf("</script>");
    assert.ok(start > -1 && end > start);

    const dir = await mkdtemp(join(tmpdir(), "codex-agent-manager-ui-"));
    const scriptPath = join(dir, "inline.js");
    await writeFile(scriptPath, html.slice(start, end), "utf8");

    const result = spawnSync(process.execPath, ["--check", scriptPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await server.close();
    await manager.close();
  }
});

async function jsonFetch(
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<any> {
  const request: RequestInit = {
    method: init.method ?? "GET",
  };
  if (init.body !== undefined) {
    request.headers = { "content-type": "application/json" };
    request.body = JSON.stringify(init.body);
  }
  const response = await fetch(url, request);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
