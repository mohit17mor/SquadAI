import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { TelegramGroupMessage } from "./telegram.js";
import type { TelegramAgentBindingService } from "./telegramBindings.js";

export type TelegramAgentRequest = {
  chatId: string;
  messageId: number;
  agentId: string;
  botUsername: string;
  status: "detected";
  createdAt: string;
};

export class SqliteTelegramRequestStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.createSchema();
  }

  appendRequest(request: TelegramAgentRequest): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO telegram_agent_requests (
        chat_id,
        message_id,
        agent_id,
        bot_username,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      request.chatId,
      request.messageId,
      request.agentId,
      request.botUsername,
      request.status,
      request.createdAt,
    );
    return Number(result.changes) > 0;
  }

  listRequests(): TelegramAgentRequest[] {
    return (this.database.prepare(`
      SELECT chat_id, message_id, agent_id, bot_username, status, created_at
      FROM telegram_agent_requests
      ORDER BY rowid
    `).all() as TelegramRequestRow[]).map(requestFromRow);
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS telegram_agent_requests (
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        bot_username TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS telegram_agent_requests_status
        ON telegram_agent_requests(status, created_at);
    `);
  }
}

export type TelegramMentionIntakeOptions = {
  bindings: TelegramAgentBindingService;
  store: SqliteTelegramRequestStore;
};

export class TelegramMentionIntake {
  constructor(private readonly options: TelegramMentionIntakeOptions) {}

  processMessage(message: TelegramGroupMessage): TelegramAgentRequest[] {
    if (message.authoredByBot) return [];
    const created: TelegramAgentRequest[] = [];
    for (const binding of this.options.bindings.listBindings()) {
      if (!mentionsUsername(message.text, binding.botUsername)) continue;
      const request: TelegramAgentRequest = {
        chatId: message.chatId,
        messageId: message.messageId,
        agentId: binding.agentId,
        botUsername: binding.botUsername,
        status: "detected",
        createdAt: message.receivedAt,
      };
      if (this.options.store.appendRequest(request)) created.push(request);
    }
    return created;
  }

  listRequests(): TelegramAgentRequest[] {
    return this.options.store.listRequests();
  }
}

type TelegramRequestRow = {
  chat_id: string;
  message_id: number;
  agent_id: string;
  bot_username: string;
  status: "detected";
  created_at: string;
};

function requestFromRow(row: TelegramRequestRow): TelegramAgentRequest {
  return {
    chatId: row.chat_id,
    messageId: Number(row.message_id),
    agentId: row.agent_id,
    botUsername: row.bot_username,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mentionsUsername(text: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, "i").test(text);
}
