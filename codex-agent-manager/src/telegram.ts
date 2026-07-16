import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type TelegramGroupMessage = {
  updateId: number;
  chatId: string;
  messageId: number;
  chatType: "group" | "supergroup";
  chatTitle: string | null;
  senderId: string | null;
  senderName: string;
  senderUsername: string | null;
  authoredByBot: boolean;
  replyToMessageId?: number | null;
  text: string;
  sentAt: string;
  receivedAt: string;
};

export class SqliteTelegramMessageStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.createSchema();
  }

  async appendMessage(message: TelegramGroupMessage): Promise<boolean> {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO telegram_messages (
        chat_id,
        message_id,
        update_id,
        chat_type,
        chat_title,
        sender_id,
        sender_name,
        sender_username,
        authored_by_bot,
        reply_to_message_id,
        text,
        sent_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.chatId,
      message.messageId,
      message.updateId,
      message.chatType,
      message.chatTitle,
      message.senderId,
      message.senderName,
      message.senderUsername,
      message.authoredByBot ? 1 : 0,
      message.replyToMessageId ?? null,
      message.text,
      message.sentAt,
      message.receivedAt,
    );
    return Number(result.changes) > 0;
  }

  listRecentMessages(chatId: string, limit = 20): TelegramGroupMessage[] {
    const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = this.database.prepare(`
      SELECT
        update_id,
        chat_id,
        message_id,
        chat_type,
        chat_title,
        sender_id,
        sender_name,
        sender_username,
        authored_by_bot,
        reply_to_message_id,
        text,
        sent_at,
        received_at
      FROM telegram_messages
      WHERE chat_id = ?
      ORDER BY message_id DESC
      LIMIT ?
    `).all(chatId, normalizedLimit) as TelegramMessageRow[];
    return rows.reverse().map(messageFromRow);
  }

  getMessage(chatId: string, messageId: number): TelegramGroupMessage | null {
    const row = this.database.prepare(`
      SELECT
        update_id,
        chat_id,
        message_id,
        chat_type,
        chat_title,
        sender_id,
        sender_name,
        sender_username,
        authored_by_bot,
        reply_to_message_id,
        text,
        sent_at,
        received_at
      FROM telegram_messages
      WHERE chat_id = ? AND message_id = ?
    `).get(chatId, messageId) as TelegramMessageRow | undefined;
    return row ? messageFromRow(row) : null;
  }

  getUpdateOffset(): number {
    return this.getListenerOffset("update_offset");
  }

  getListenerOffset(key: string): number {
    const row = this.database.prepare(`
      SELECT value FROM telegram_listener_state WHERE key = ?
    `).get(key) as { value: string } | undefined;
    const offset = Number(row?.value ?? 0);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  }

  setUpdateOffset(offset: number): void {
    this.setListenerOffset("update_offset", offset);
  }

  setListenerOffset(key: string, offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error(`Invalid Telegram update offset: ${offset}`);
    }
    this.database.prepare(`
      INSERT INTO telegram_listener_state (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(offset));
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS telegram_messages (
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        update_id INTEGER NOT NULL,
        chat_type TEXT NOT NULL,
        chat_title TEXT,
        sender_id TEXT,
        sender_name TEXT NOT NULL,
        sender_username TEXT,
        authored_by_bot INTEGER NOT NULL,
        reply_to_message_id INTEGER,
        text TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS telegram_messages_chat_received
        ON telegram_messages(chat_id, message_id DESC);
      CREATE TABLE IF NOT EXISTS telegram_listener_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const columns = this.database.prepare("PRAGMA table_info(telegram_messages)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "reply_to_message_id")) {
      this.database.exec("ALTER TABLE telegram_messages ADD COLUMN reply_to_message_id INTEGER");
    }
  }
}

export type TelegramListenerOptions = {
  token: string;
  store: SqliteTelegramMessageStore;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  pollTimeoutSeconds?: number;
  clock?: () => Date;
  onMessage?: (message: TelegramGroupMessage) => void | Promise<void>;
};

export type TelegramCallbackQuery = {
  updateId: number;
  id: string;
  userId: string;
  userName: string;
  data: string;
  chatId: string;
  messageId: number;
  messageText: string;
};

export type TelegramAgentCallbackListenerOptions = {
  bots: () => Array<{ id: string; token: string }>;
  store: SqliteTelegramMessageStore;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  pollTimeoutSeconds?: number;
  onCallback: (botId: string, callback: TelegramCallbackQuery) => void | Promise<void>;
};

export class TelegramAgentCallbackListener {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly pollTimeoutSeconds: number;
  private running = false;
  private readonly aborts = new Set<AbortController>();

  constructor(private readonly options: TelegramAgentCallbackListenerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.pollTimeoutSeconds = Math.max(0, Math.min(Math.floor(options.pollTimeoutSeconds ?? 25), 50));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.running) {
      const bots = this.options.bots();
      if (!bots.length) {
        await delay(1_000);
        continue;
      }
      await Promise.all(bots.map((bot) => this.pollBot(bot).catch((error) => {
        if (this.running) {
          console.error(`Telegram approval poll failed for ${bot.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      })));
    }
  }

  async close(): Promise<void> {
    this.running = false;
    for (const abort of this.aborts) abort.abort();
    this.aborts.clear();
  }

  private async pollBot(bot: { id: string; token: string }): Promise<void> {
    const abort = new AbortController();
    this.aborts.add(abort);
    const offsetKey = `callback_offset:${bot.id}`;
    try {
      const response = await this.fetchImpl(
        `${this.apiBaseUrl}/bot${bot.token}/getUpdates`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            offset: this.options.store.getListenerOffset(offsetKey),
            timeout: this.pollTimeoutSeconds,
            allowed_updates: ["callback_query"],
          }),
          signal: abort.signal,
        },
      );
      const body = await response.json() as unknown;
      if (!response.ok) throw new Error(telegramApiError(body, response.status));
      let nextOffset = this.options.store.getListenerOffset(offsetKey);
      for (const update of telegramUpdates(body)) {
        const callback = callbackQuery(update);
        if (callback) await this.options.onCallback(bot.id, callback);
        nextOffset = Math.max(nextOffset, update.update_id + 1);
      }
      this.options.store.setListenerOffset(offsetKey, nextOffset);
    } finally {
      this.aborts.delete(abort);
    }
  }
}

export class TelegramListener {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly pollTimeoutSeconds: number;
  private readonly clock: () => Date;
  private running = false;
  private pollAbort: AbortController | null = null;

  constructor(private readonly options: TelegramListenerOptions) {
    if (!options.token.trim()) throw new Error("Telegram bot token is required.");
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.pollTimeoutSeconds = Math.max(0, Math.min(Math.floor(options.pollTimeoutSeconds ?? 25), 50));
    this.clock = options.clock ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let retryMs = 500;
    while (this.running) {
      try {
        await this.pollOnce();
        retryMs = 500;
      } catch (error) {
        if (!this.running) break;
        console.error(`Telegram poll failed: ${error instanceof Error ? error.message : String(error)}`);
        await delay(retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      }
    }
  }

  async pollOnce(): Promise<number> {
    const abort = new AbortController();
    this.pollAbort = abort;
    try {
      const response = await this.fetchImpl(
        `${this.apiBaseUrl}/bot${this.options.token}/getUpdates`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            offset: this.options.store.getUpdateOffset(),
            timeout: this.pollTimeoutSeconds,
            allowed_updates: ["message"],
          }),
          signal: abort.signal,
        },
      );
      const body = await response.json() as unknown;
      if (!response.ok) {
        throw new Error(telegramApiError(body, response.status));
      }
      const result = telegramUpdates(body);
      let stored = 0;
      let nextOffset = this.options.store.getUpdateOffset();
      for (const update of result) {
        const message = groupTextMessage(update, this.clock());
        if (message) {
          if (await this.options.store.appendMessage(message)) stored += 1;
          await this.options.onMessage?.(message);
        }
        nextOffset = Math.max(nextOffset, update.update_id + 1);
      }
      if (nextOffset !== this.options.store.getUpdateOffset()) {
        this.options.store.setUpdateOffset(nextOffset);
      }
      return stored;
    } finally {
      if (this.pollAbort === abort) this.pollAbort = null;
    }
  }

  async close(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();
    this.pollAbort = null;
  }
}

type TelegramMessageRow = {
  update_id: number;
  chat_id: string;
  message_id: number;
  chat_type: TelegramGroupMessage["chatType"];
  chat_title: string | null;
  sender_id: string | null;
  sender_name: string;
  sender_username: string | null;
  authored_by_bot: number;
  reply_to_message_id: number | null;
  text: string;
  sent_at: string;
  received_at: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id?: number;
    date?: number;
    text?: string;
    chat?: {
      id?: number | string;
      type?: string;
      title?: string;
    };
    from?: {
      id?: number | string;
      is_bot?: boolean;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    reply_to_message?: {
      message_id?: number;
    };
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: {
      id?: number | string;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    message?: {
      message_id?: number;
      text?: string;
      chat?: {
        id?: number | string;
        type?: string;
      };
    };
  };
};

function messageFromRow(row: TelegramMessageRow): TelegramGroupMessage {
  return {
    updateId: Number(row.update_id),
    chatId: row.chat_id,
    messageId: Number(row.message_id),
    chatType: row.chat_type,
    chatTitle: row.chat_title,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderUsername: row.sender_username,
    authoredByBot: Boolean(row.authored_by_bot),
    replyToMessageId: row.reply_to_message_id === null ? null : Number(row.reply_to_message_id),
    text: row.text,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
  };
}

function telegramUpdates(value: unknown): TelegramUpdate[] {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.result)) {
    throw new Error("Telegram returned an invalid getUpdates response.");
  }
  return value.result.filter((entry): entry is TelegramUpdate => (
    isRecord(entry) && Number.isSafeInteger(entry.update_id)
  ));
}

function groupTextMessage(update: TelegramUpdate, receivedAt: Date): TelegramGroupMessage | null {
  const message = update.message;
  const chat = message?.chat;
  if (
    !message
    || !chat
    || (chat.type !== "group" && chat.type !== "supergroup")
    || typeof message.text !== "string"
    || !message.text.trim()
    || !Number.isSafeInteger(message.message_id)
    || !Number.isFinite(message.date)
    || (typeof chat.id !== "number" && typeof chat.id !== "string")
  ) {
    return null;
  }
  const sender = message.from;
  const senderName = [sender?.first_name, sender?.last_name].filter(Boolean).join(" ").trim()
    || sender?.username
    || "Unknown";
  return {
    updateId: update.update_id,
    chatId: String(chat.id),
    messageId: message.message_id!,
    chatType: chat.type,
    chatTitle: typeof chat.title === "string" ? chat.title : null,
    senderId: sender?.id === undefined ? null : String(sender.id),
    senderName,
    senderUsername: typeof sender?.username === "string" ? sender.username : null,
    authoredByBot: sender?.is_bot === true,
    replyToMessageId: Number.isSafeInteger(message.reply_to_message?.message_id)
      ? message.reply_to_message!.message_id!
      : null,
    text: message.text,
    sentAt: new Date(message.date! * 1_000).toISOString(),
    receivedAt: receivedAt.toISOString(),
  };
}

function callbackQuery(update: TelegramUpdate): TelegramCallbackQuery | null {
  const callback = update.callback_query;
  const message = callback?.message;
  const chat = message?.chat;
  const sender = callback?.from;
  if (
    !callback
    || typeof callback.id !== "string"
    || typeof callback.data !== "string"
    || !message
    || !Number.isSafeInteger(message.message_id)
    || !chat
    || (chat.type !== "group" && chat.type !== "supergroup")
    || (typeof chat.id !== "number" && typeof chat.id !== "string")
    || !sender
    || (typeof sender.id !== "number" && typeof sender.id !== "string")
  ) {
    return null;
  }
  const userName = [sender.first_name, sender.last_name]
    .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
    .join(" ")
    .trim()
    || (typeof sender.username === "string" ? sender.username : "Unknown user");
  return {
    updateId: update.update_id,
    id: callback.id,
    userId: String(sender.id),
    userName,
    data: callback.data,
    chatId: String(chat.id),
    messageId: Number(message.message_id),
    messageText: typeof message.text === "string" ? message.text : "Approval required.",
  };
}

function telegramApiError(value: unknown, status: number): string {
  if (isRecord(value) && typeof value.description === "string") return value.description;
  return `Telegram API returned HTTP ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
