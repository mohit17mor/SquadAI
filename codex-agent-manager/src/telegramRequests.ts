import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { TelegramGroupMessage } from "./telegram.js";
import type { TelegramAgentBindingService } from "./telegramBindings.js";

export type TelegramAgentRequestStatus =
  | "detected"
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "delivery_failed";

export type TelegramAgentRequest = {
  chatId: string;
  messageId: number;
  agentId: string;
  botUsername: string;
  status: TelegramAgentRequestStatus;
  sensorEventId: string | null;
  workItemId: string | null;
  effectiveAgentId: string | null;
  lastError: string | null;
  lastApprovalId: string | null;
  responseSentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type TelegramRequestKey = Pick<TelegramAgentRequest, "chatId" | "messageId" | "agentId">;

export type TelegramAgentResponse = {
  chatId: string;
  messageId: number;
  baseAgentId: string;
  effectiveAgentId: string;
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
        sensor_event_id,
        work_item_id,
        effective_agent_id,
        last_error,
        last_approval_id,
        response_sent_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.chatId,
      request.messageId,
      request.agentId,
      request.botUsername,
      request.status,
      request.sensorEventId,
      request.workItemId,
      request.effectiveAgentId,
      request.lastError,
      request.lastApprovalId,
      request.responseSentAt,
      request.createdAt,
      request.updatedAt,
    );
    return Number(result.changes) > 0;
  }

  listRequests(): TelegramAgentRequest[] {
    return (this.database.prepare(`
      ${TELEGRAM_REQUEST_SELECT}
      ORDER BY rowid
    `).all() as TelegramRequestRow[]).map(requestFromRow);
  }

  listRequestsForMessage(chatId: string, messageId: number): TelegramAgentRequest[] {
    return (this.database.prepare(`
      ${TELEGRAM_REQUEST_SELECT}
      WHERE chat_id = ? AND message_id = ?
      ORDER BY rowid
    `).all(chatId, messageId) as TelegramRequestRow[]).map(requestFromRow);
  }

  getRequest(key: TelegramRequestKey): TelegramAgentRequest | null {
    const row = this.database.prepare(`
      ${TELEGRAM_REQUEST_SELECT}
      WHERE chat_id = ? AND message_id = ? AND agent_id = ?
    `).get(key.chatId, key.messageId, key.agentId) as TelegramRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  findByWorkItemId(workItemId: string): TelegramAgentRequest | null {
    const row = this.database.prepare(`
      ${TELEGRAM_REQUEST_SELECT}
      WHERE work_item_id = ?
    `).get(workItemId) as TelegramRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  findActiveByEffectiveAgentId(agentId: string): TelegramAgentRequest | null {
    const row = this.database.prepare(`
      ${TELEGRAM_REQUEST_SELECT}
      WHERE effective_agent_id = ? AND status IN ('queued', 'running', 'blocked')
      ORDER BY rowid DESC
      LIMIT 1
    `).get(agentId) as TelegramRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  findByApprovalId(approvalId: string): TelegramAgentRequest | null {
    const row = this.database.prepare(`
      ${TELEGRAM_REQUEST_SELECT}
      WHERE last_approval_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(approvalId) as TelegramRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  saveAgentResponse(response: TelegramAgentResponse): void {
    this.database.prepare(`
      INSERT OR REPLACE INTO telegram_agent_responses (
        chat_id,
        message_id,
        base_agent_id,
        effective_agent_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      response.chatId,
      response.messageId,
      response.baseAgentId,
      response.effectiveAgentId,
      response.createdAt,
    );
  }

  findAgentResponse(chatId: string, messageId: number): TelegramAgentResponse | null {
    const row = this.database.prepare(`
      SELECT chat_id, message_id, base_agent_id, effective_agent_id, created_at
      FROM telegram_agent_responses
      WHERE chat_id = ? AND message_id = ?
    `).get(chatId, messageId) as TelegramAgentResponseRow | undefined;
    return row ? {
      chatId: row.chat_id,
      messageId: Number(row.message_id),
      baseAgentId: row.base_agent_id,
      effectiveAgentId: row.effective_agent_id,
      createdAt: row.created_at,
    } : null;
  }

  markQueued(
    key: TelegramRequestKey,
    sensorEventId: string,
    workItemId: string,
    effectiveAgentId: string,
    updatedAt: string,
  ): TelegramAgentRequest {
    return this.update(key, {
      status: "queued",
      sensorEventId,
      workItemId,
      effectiveAgentId,
      lastError: null,
      updatedAt,
    });
  }

  markStatusByWorkItem(
    workItemId: string,
    status: TelegramAgentRequestStatus,
    updatedAt: string,
    options: {
      lastError?: string | null;
      lastApprovalId?: string | null;
      responseSentAt?: string | null;
    } = {},
  ): TelegramAgentRequest | null {
    const request = this.findByWorkItemId(workItemId);
    if (!request) return null;
    return this.update(request, {
      status,
      updatedAt,
      ...options,
    });
  }

  markApproval(
    key: TelegramRequestKey,
    approvalId: string,
    updatedAt: string,
  ): TelegramAgentRequest {
    return this.update(key, { lastApprovalId: approvalId, updatedAt });
  }

  markFailed(key: TelegramRequestKey, error: string, updatedAt: string): TelegramAgentRequest {
    return this.update(key, {
      status: "failed",
      lastError: error,
      updatedAt,
    });
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private update(
    key: TelegramRequestKey,
    patch: Partial<Omit<TelegramAgentRequest, "chatId" | "messageId" | "agentId" | "botUsername" | "createdAt">>,
  ): TelegramAgentRequest {
    const existing = this.getRequest(key);
    if (!existing) throw new Error("Unknown Telegram agent request.");
    const next = { ...existing, ...patch };
    this.database.prepare(`
      UPDATE telegram_agent_requests SET
        status = ?,
        sensor_event_id = ?,
        work_item_id = ?,
        effective_agent_id = ?,
        last_error = ?,
        last_approval_id = ?,
        response_sent_at = ?,
        updated_at = ?
      WHERE chat_id = ? AND message_id = ? AND agent_id = ?
    `).run(
      next.status,
      next.sensorEventId,
      next.workItemId,
      next.effectiveAgentId,
      next.lastError,
      next.lastApprovalId,
      next.responseSentAt,
      next.updatedAt,
      key.chatId,
      key.messageId,
      key.agentId,
    );
    return this.getRequest(key)!;
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS telegram_agent_requests (
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        bot_username TEXT NOT NULL,
        status TEXT NOT NULL,
        sensor_event_id TEXT,
        work_item_id TEXT,
        effective_agent_id TEXT,
        last_error TEXT,
        last_approval_id TEXT,
        response_sent_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id, agent_id)
      );
    `);
    const columns = this.database.prepare("PRAGMA table_info(telegram_agent_requests)").all() as Array<{ name: string }>;
    const migrations: Array<[string, string]> = [
      ["sensor_event_id", "ALTER TABLE telegram_agent_requests ADD COLUMN sensor_event_id TEXT"],
      ["work_item_id", "ALTER TABLE telegram_agent_requests ADD COLUMN work_item_id TEXT"],
      ["effective_agent_id", "ALTER TABLE telegram_agent_requests ADD COLUMN effective_agent_id TEXT"],
      ["last_error", "ALTER TABLE telegram_agent_requests ADD COLUMN last_error TEXT"],
      ["last_approval_id", "ALTER TABLE telegram_agent_requests ADD COLUMN last_approval_id TEXT"],
      ["response_sent_at", "ALTER TABLE telegram_agent_requests ADD COLUMN response_sent_at TEXT"],
      ["updated_at", "ALTER TABLE telegram_agent_requests ADD COLUMN updated_at TEXT"],
    ];
    for (const [name, sql] of migrations) {
      if (!columns.some((column) => column.name === name)) this.database.exec(sql);
    }
    this.database.exec(`
      UPDATE telegram_agent_requests
      SET updated_at = COALESCE(updated_at, created_at);
      CREATE INDEX IF NOT EXISTS telegram_agent_requests_status
        ON telegram_agent_requests(status, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS telegram_agent_requests_work_item
        ON telegram_agent_requests(work_item_id)
        WHERE work_item_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS telegram_agent_responses (
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        base_agent_id TEXT NOT NULL,
        effective_agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      );
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
        sensorEventId: null,
        workItemId: null,
        effectiveAgentId: null,
        lastError: null,
        lastApprovalId: null,
        responseSentAt: null,
        createdAt: message.receivedAt,
        updatedAt: message.receivedAt,
      };
      if (this.options.store.appendRequest(request)) created.push(request);
    }
    return created;
  }

  listRequests(): TelegramAgentRequest[] {
    return this.options.store.listRequests();
  }
}

const TELEGRAM_REQUEST_SELECT = `
  SELECT
    chat_id,
    message_id,
    agent_id,
    bot_username,
    status,
    sensor_event_id,
    work_item_id,
    effective_agent_id,
    last_error,
    last_approval_id,
    response_sent_at,
    created_at,
    updated_at
  FROM telegram_agent_requests
`;

type TelegramRequestRow = {
  chat_id: string;
  message_id: number;
  agent_id: string;
  bot_username: string;
  status: TelegramAgentRequestStatus;
  sensor_event_id: string | null;
  work_item_id: string | null;
  effective_agent_id: string | null;
  last_error: string | null;
  last_approval_id: string | null;
  response_sent_at: string | null;
  created_at: string;
  updated_at: string | null;
};

type TelegramAgentResponseRow = {
  chat_id: string;
  message_id: number;
  base_agent_id: string;
  effective_agent_id: string;
  created_at: string;
};

function requestFromRow(row: TelegramRequestRow): TelegramAgentRequest {
  return {
    chatId: row.chat_id,
    messageId: Number(row.message_id),
    agentId: row.agent_id,
    botUsername: row.bot_username,
    status: row.status,
    sensorEventId: row.sensor_event_id,
    workItemId: row.work_item_id,
    effectiveAgentId: row.effective_agent_id,
    lastError: row.last_error,
    lastApprovalId: row.last_approval_id,
    responseSentAt: row.response_sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

function mentionsUsername(text: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, "i").test(text);
}
