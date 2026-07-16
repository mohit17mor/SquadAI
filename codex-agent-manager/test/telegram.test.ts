import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SqliteTelegramAgentBindingStore,
  SqliteTelegramMessageStore,
  SqliteTelegramRequestStore,
  TelegramAgentBindingService,
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
