import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexAgentManager,
  type CodexControlClientContext,
  type CodexControlClientFactory,
  type AgentWorkspaceManager,
  SqliteTelegramAgentBindingStore,
  SqliteTelegramMessageStore,
  SqliteTelegramRequestStore,
  TelegramAgentBindingService,
  TelegramCoordinator,
  TelegramMentionIntake,
  TelegramListener,
} from "../src/index.js";

test("telegram message store persists group messages and deduplicates Telegram retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squadai-telegram-store-"));
  const databasePath = join(directory, "command-center.db");
  const store = new SqliteTelegramMessageStore(databasePath);
  const message = {
    updateId: 101,
    chatId: "-100123",
    messageId: 44,
    chatType: "supergroup" as const,
    chatTitle: "SquadAI",
    senderId: "9001",
    senderName: "Mohit",
    senderUsername: "mohit",
    authoredByBot: false,
    text: "@coder_bot fix the login bug",
    sentAt: "2026-07-16T04:30:00.000Z",
    receivedAt: "2026-07-16T04:30:01.000Z",
  };

  try {
    assert.equal(await store.appendMessage(message), true);
    assert.equal(await store.appendMessage(message), false);
    assert.deepEqual(store.listRecentMessages("-100123", 20), [message]);
  } finally {
    await store.close();
  }

  const reopened = new SqliteTelegramMessageStore(databasePath);
  try {
    assert.deepEqual(reopened.listRecentMessages("-100123", 20), [message]);
  } finally {
    await reopened.close();
  }
});

test("telegram listener stores only group text messages and advances its durable update offset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squadai-telegram-listener-"));
  const store = new SqliteTelegramMessageStore(join(directory, "command-center.db"));
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const receivedMessages: number[] = [];
  const responses = [
    {
      ok: true,
      result: [
        {
          update_id: 501,
          message: {
            message_id: 71,
            date: 1_784_200_000,
            text: "hello team",
            chat: { id: -100777, type: "supergroup", title: "Product Team" },
            from: { id: 42, first_name: "Mohit", username: "mohit", is_bot: false },
          },
        },
        {
          update_id: 502,
          message: {
            message_id: 72,
            date: 1_784_200_001,
            text: "private message",
            chat: { id: 42, type: "private" },
            from: { id: 42, first_name: "Mohit", is_bot: false },
          },
        },
        {
          update_id: 503,
          message: {
            message_id: 73,
            date: 1_784_200_002,
            photo: [{ file_id: "photo" }],
            chat: { id: -100777, type: "supergroup", title: "Product Team" },
            from: { id: 42, first_name: "Mohit", is_bot: false },
          },
        },
        {
          update_id: 504,
          message: {
            message_id: 71,
            date: 1_784_200_000,
            text: "hello team",
            chat: { id: -100777, type: "supergroup", title: "Product Team" },
            from: { id: 42, first_name: "Mohit", username: "mohit", is_bot: false },
          },
        },
      ],
    },
    { ok: true, result: [] },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const listener = new TelegramListener({
    token: "telegram-token",
    store,
    fetch: fetchImpl,
    clock: () => new Date("2026-07-16T04:31:00.000Z"),
    onMessage: (message) => {
      receivedMessages.push(message.messageId);
    },
  });

  try {
    assert.equal(await listener.pollOnce(), 1);
    assert.equal(await listener.pollOnce(), 0);

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, "https://api.telegram.org/bottelegram-token/getUpdates");
    assert.deepEqual(requests[0]?.body, {
      offset: 0,
      timeout: 25,
      allowed_updates: ["message"],
    });
    assert.equal(requests[1]?.body.offset, 505);
    assert.deepEqual(receivedMessages, [71, 71]);

    assert.deepEqual(store.listRecentMessages("-100777", 20), [{
      updateId: 501,
      chatId: "-100777",
      messageId: 71,
      chatType: "supergroup",
      chatTitle: "Product Team",
      senderId: "42",
      senderName: "Mohit",
      senderUsername: "mohit",
      authoredByBot: false,
      text: "hello team",
      sentAt: new Date(1_784_200_000 * 1_000).toISOString(),
      receivedAt: "2026-07-16T04:31:00.000Z",
    }]);
  } finally {
    await listener.close();
    await store.close();
  }
});

test("telegram agent binding verifies a bot token, persists its identity, and never lists the token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squadai-telegram-bindings-"));
  const databasePath = join(directory, "command-center.db");
  const store = new SqliteTelegramAgentBindingStore(databasePath);
  const requests: string[] = [];
  const service = new TelegramAgentBindingService({
    store,
    agentExists: (agentId) => agentId === "coder",
    fetch: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        ok: true,
        result: {
          id: 123456,
          is_bot: true,
          first_name: "Coder",
          username: "squadai_coder_bot",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    clock: () => new Date("2026-07-16T05:00:00.000Z"),
  });

  try {
    const binding = await service.bindAgent("coder", "123456:secret-token");

    assert.equal(requests[0], "https://api.telegram.org/bot123456:secret-token/getMe");
    assert.deepEqual(binding, {
      agentId: "coder",
      botId: "123456",
      botUsername: "squadai_coder_bot",
      botName: "Coder",
      executionPolicy: "reuse",
      createdAt: "2026-07-16T05:00:00.000Z",
      updatedAt: "2026-07-16T05:00:00.000Z",
    });
    assert.deepEqual(service.listBindings(), [binding]);
    assert.equal(store.getBotToken("coder"), "123456:secret-token");
    assert.equal(JSON.stringify(service.listBindings()).includes("secret-token"), false);
  } finally {
    await store.close();
  }

  const reopened = new SqliteTelegramAgentBindingStore(databasePath);
  try {
    assert.equal(reopened.getBotToken("coder"), "123456:secret-token");
    assert.equal(reopened.listBindings()[0]?.botUsername, "squadai_coder_bot");
  } finally {
    await reopened.close();
  }
});

test("telegram agent binding rejects unknown agents and prevents one bot from representing two agents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squadai-telegram-binding-rules-"));
  const store = new SqliteTelegramAgentBindingStore(join(directory, "command-center.db"));
  const service = new TelegramAgentBindingService({
    store,
    agentExists: (agentId) => agentId === "coder" || agentId === "reviewer",
    fetch: async () => new Response(JSON.stringify({
      ok: true,
      result: {
        id: 123456,
        is_bot: true,
        first_name: "Coder",
        username: "squadai_coder_bot",
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  try {
    await assert.rejects(service.bindAgent("missing", "token"), /unknown agent/i);
    await service.bindAgent("coder", "token-one");
    await assert.rejects(
      service.bindAgent("reviewer", "token-two"),
      /already represents agent coder/i,
    );
    assert.equal(await service.removeBinding("coder"), true);
    assert.deepEqual(service.listBindings(), []);
  } finally {
    await store.close();
  }
});

test("telegram mention intake creates requests only for agents tagged in the latest human message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squadai-telegram-mentions-"));
  const databasePath = join(directory, "command-center.db");
  const bindingStore = new SqliteTelegramAgentBindingStore(databasePath);
  const requestStore = new SqliteTelegramRequestStore(databasePath);
  const bindings = new TelegramAgentBindingService({
    store: bindingStore,
    agentExists: () => true,
    fetch: async (input) => {
      const token = String(input).match(/bot([^/]+)\/getMe/)?.[1] ?? "";
      const coder = token === "coder-token";
      return new Response(JSON.stringify({
        ok: true,
        result: {
          id: coder ? 101 : 202,
          is_bot: true,
          first_name: coder ? "Coder" : "Reviewer",
          username: coder ? "squadai_coder_bot" : "squadai_reviewer_bot",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await bindings.bindAgent("coder", "coder-token");
  await bindings.bindAgent("reviewer", "reviewer-token");
  const intake = new TelegramMentionIntake({ bindings, store: requestStore });
  const baseMessage = {
    updateId: 700,
    chatId: "-100999",
    messageId: 80,
    chatType: "supergroup" as const,
    chatTitle: "Product Team",
    senderId: "42",
    senderName: "Mohit",
    senderUsername: "mohit",
    authoredByBot: false,
    sentAt: "2026-07-16T06:00:00.000Z",
    receivedAt: "2026-07-16T06:00:01.000Z",
  };

  try {
    assert.deepEqual(
      intake.processMessage({
        ...baseMessage,
        text: "Earlier we asked @squadai_coder_bot. Now @squadai_reviewer_bot please review it.",
      }).map((request) => request.agentId),
      ["coder", "reviewer"],
    );
    assert.deepEqual(
      intake.processMessage({
        ...baseMessage,
        messageId: 81,
        updateId: 701,
        text: "Only @squadai_reviewer_bot should receive this latest request.",
      }).map((request) => request.agentId),
      ["reviewer"],
    );
    assert.deepEqual(
      intake.processMessage({
        ...baseMessage,
        messageId: 81,
        updateId: 701,
        text: "Only @squadai_reviewer_bot should receive this latest request.",
      }),
      [],
    );
    assert.deepEqual(
      intake.processMessage({
        ...baseMessage,
        messageId: 82,
        updateId: 702,
        authoredByBot: true,
        text: "@squadai_coder_bot mentioned by another bot",
      }),
      [],
    );
    assert.equal(requestStore.listRequests().length, 3);
    assert.deepEqual(
      requestStore.listRequests().map((request) => [request.messageId, request.agentId]),
      [[80, "coder"], [80, "reviewer"], [81, "reviewer"]],
    );
  } finally {
    await requestStore.close();
    await bindingStore.close();
  }
});

test("telegram coordinator queues tagged work with chat context and replies through an instantiated remote agent bot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squadai-telegram-e2e-"));
  const databasePath = join(directory, "command-center.db");
  const messageStore = new SqliteTelegramMessageStore(databasePath);
  const bindingStore = new SqliteTelegramAgentBindingStore(databasePath);
  const requestStore = new SqliteTelegramRequestStore(databasePath);
  const clientContexts: CodexControlClientContext[] = [];
  const prompts: string[] = [];
  const clientFactory: CodexControlClientFactory = (context) => {
    assert.ok(context);
    clientContexts.push(context);
    return {
      async startSession() {
        return {
          threadId: "telegram-thread",
          async ask(input) {
            prompts.push(input);
            return {
              finalText: `Completed by ${context.agentId} on ${context.runnerId}.`,
              threadId: "telegram-thread",
              turn: { status: "completed" },
            };
          },
        };
      },
      async resumeSession() {
        throw new Error("Unexpected resume.");
      },
      async close() {},
    };
  };
  const manager = new CodexAgentManager({
    agents: [{
      id: "coder",
      name: "Coder",
      runnerId: "vm-1",
      cwd: directory,
      instructions: "Implement coding tasks.",
    }],
    clientFactory,
    workspaceManager: passthroughWorkspaceManager(),
  });
  const bindings = new TelegramAgentBindingService({
    store: bindingStore,
    agentExists: () => true,
    fetch: async () => new Response(JSON.stringify({
      ok: true,
      result: {
        id: 101,
        is_bot: true,
        first_name: "Coder",
        username: "squadai_coder_bot",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await bindings.bindAgent("coder", "coder-token", "new");
  const mentionIntake = new TelegramMentionIntake({ bindings, store: requestStore });
  const sentMessages: Array<{ token: string; body: Record<string, unknown> }> = [];
  let outgoingMessageId = 900;
  const telegramFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const token = url.match(/bot([^/]+)\/sendMessage/)?.[1] ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sentMessages.push({ token, body });
    const agentBot = token === "coder-token";
    return new Response(JSON.stringify({
      ok: true,
      result: {
        message_id: outgoingMessageId++,
        date: 1_784_210_000,
        text: body.text,
        chat: { id: -100999, type: "supergroup", title: "Product Team" },
        from: {
          id: agentBot ? 101 : 303,
          is_bot: true,
          first_name: agentBot ? "Coder" : "SquadAI",
          username: agentBot ? "squadai_coder_bot" : "squadai_control_bot",
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const coordinator = new TelegramCoordinator({
    manager,
    bindings,
    mentionIntake,
    requestStore,
    messageStore,
    controlBotToken: "control-token",
    fetch: telegramFetch,
  });
  const previousBotReply = telegramMessage({
    updateId: 699,
    messageId: 79,
    authoredByBot: true,
    senderId: "404",
    senderName: "Newsbot",
    senderUsername: "squadai_news_bot",
    text: "Earlier agent result that should be included as context.",
  });
  const latestMessage = telegramMessage({
    updateId: 700,
    messageId: 80,
    text: "@squadai_coder_bot please implement the login fix.",
  });

  try {
    await manager.start();
    await coordinator.start();
    for (let messageId = 60; messageId <= 78; messageId += 1) {
      await messageStore.appendMessage(telegramMessage({
        updateId: 600 + messageId,
        messageId,
        text: messageId === 60 ? "Oldest message that must fall outside the 20-message window." : `Context ${messageId}`,
      }));
    }
    await messageStore.appendMessage(previousBotReply);
    await messageStore.appendMessage(latestMessage);
    assert.equal(mentionIntake.processMessage(latestMessage).length, 1);
    await coordinator.processMessage(latestMessage);
    await waitFor(
      () => requestStore.listRequests()[0]?.status === "completed",
      "Telegram request completion",
    );

    const request = requestStore.listRequests()[0];
    assert.equal(request?.status, "completed");
    assert.equal(request?.agentId, "coder");
    assert.match(request?.effectiveAgentId ?? "", /^coder--sensor-/);
    assert.equal(clientContexts[0]?.runnerId, "vm-1");
    assert.match(clientContexts[0]?.agentId ?? "", /^coder--sensor-/);
    assert.match(prompts[0] ?? "", /Earlier agent result that should be included as context/);
    assert.match(prompts[0] ?? "", /please implement the login fix/);
    assert.doesNotMatch(prompts[0] ?? "", /Oldest message that must fall outside/);
    assert.equal(sentMessages[0]?.token, "control-token");
    assert.match(String(sentMessages[0]?.body.text), /Queued for Coder/);
    assert.match(String(sentMessages[0]?.body.text), /new instance/);
    assert.equal(sentMessages[1]?.token, "coder-token");
    assert.match(String(sentMessages[1]?.body.text), /Completed by coder--sensor-/);
    assert.deepEqual(
      messageStore.listRecentMessages("-100999", 20).slice(-2).map((message) => message.senderUsername),
      ["squadai_control_bot", "squadai_coder_bot"],
    );

    const botAuthoredTag = telegramMessage({
      updateId: 701,
      messageId: 81,
      authoredByBot: true,
      senderId: "404",
      senderName: "Newsbot",
      senderUsername: "squadai_news_bot",
      text: "@squadai_coder_bot please start another task.",
    });
    await messageStore.appendMessage(botAuthoredTag);
    assert.deepEqual(await coordinator.processMessage(botAuthoredTag), []);
    assert.equal(requestStore.listRequests().length, 1);
  } finally {
    await coordinator.close();
    await manager.close();
    await requestStore.close();
    await bindingStore.close();
    await messageStore.close();
  }
});

test("telegram coordinator reports agent failures through the bound agent bot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "squadai-telegram-failure-"));
  const databasePath = join(directory, "command-center.db");
  const messageStore = new SqliteTelegramMessageStore(databasePath);
  const bindingStore = new SqliteTelegramAgentBindingStore(databasePath);
  const requestStore = new SqliteTelegramRequestStore(databasePath);
  const manager = new CodexAgentManager({
    agents: [{
      id: "coder",
      name: "Coder",
      cwd: directory,
      instructions: "Implement coding tasks.",
    }],
    clientFactory: () => ({
      async startSession() {
        return {
          threadId: "failure-thread",
          async ask() {
            throw new Error("build failed");
          },
        };
      },
      async resumeSession() {
        throw new Error("Unexpected resume.");
      },
      async close() {},
    }),
    workspaceManager: passthroughWorkspaceManager(),
  });
  const bindings = new TelegramAgentBindingService({
    store: bindingStore,
    agentExists: () => true,
    fetch: async () => new Response(JSON.stringify({
      ok: true,
      result: {
        id: 101,
        is_bot: true,
        first_name: "Coder",
        username: "squadai_coder_bot",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await bindings.bindAgent("coder", "coder-token");
  const mentionIntake = new TelegramMentionIntake({ bindings, store: requestStore });
  const sentMessages: Array<{ token: string; text: string }> = [];
  let outgoingMessageId = 950;
  const coordinator = new TelegramCoordinator({
    manager,
    bindings,
    mentionIntake,
    requestStore,
    messageStore,
    controlBotToken: "control-token",
    fetch: async (input, init) => {
      const token = String(input).match(/bot([^/]+)\/sendMessage/)?.[1] ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as { text: string };
      sentMessages.push({ token, text: body.text });
      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: outgoingMessageId++,
          date: 1_784_210_000,
          text: body.text,
          chat: { id: -100999, type: "supergroup", title: "Product Team" },
          from: {
            id: token === "coder-token" ? 101 : 303,
            is_bot: true,
            first_name: token === "coder-token" ? "Coder" : "SquadAI",
            username: token === "coder-token" ? "squadai_coder_bot" : "squadai_control_bot",
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const message = telegramMessage({
    text: "@squadai_coder_bot run the build.",
  });

  try {
    await manager.start();
    await coordinator.start();
    await messageStore.appendMessage(message);
    await coordinator.processMessage(message);
    await waitFor(
      () => requestStore.listRequests()[0]?.status === "failed",
      "Telegram failure delivery",
    );
    assert.equal(sentMessages[0]?.token, "control-token");
    assert.equal(sentMessages.at(-1)?.token, "coder-token");
    assert.match(sentMessages.at(-1)?.text ?? "", /couldn’t complete this request: build failed/i);
    assert.equal(requestStore.listRequests()[0]?.lastError, "build failed");
  } finally {
    await coordinator.close();
    await manager.close();
    await requestStore.close();
    await bindingStore.close();
    await messageStore.close();
  }
});

function telegramMessage(overrides: Partial<{
  updateId: number;
  messageId: number;
  authoredByBot: boolean;
  senderId: string;
  senderName: string;
  senderUsername: string;
  text: string;
}> = {}) {
  return {
    updateId: overrides.updateId ?? 700,
    chatId: "-100999",
    messageId: overrides.messageId ?? 80,
    chatType: "supergroup" as const,
    chatTitle: "Product Team",
    senderId: overrides.senderId ?? "42",
    senderName: overrides.senderName ?? "Mohit",
    senderUsername: overrides.senderUsername ?? "mohit",
    authoredByBot: overrides.authoredByBot ?? false,
    text: overrides.text ?? "hello",
    sentAt: "2026-07-16T06:00:00.000Z",
    receivedAt: "2026-07-16T06:00:01.000Z",
  };
}

function passthroughWorkspaceManager(): AgentWorkspaceManager {
  return {
    async prepareBase(definition) { return definition; },
    async prepareInstance(_base, instance) { return instance; },
    async inspect() { return null; },
    async cleanup(definition) { return definition; },
  };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
