import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteTelegramMessageStore, TelegramListener } from "../src/index.js";

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
    assert.equal(requests[1]?.body.offset, 504);

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
