import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type TelegramAgentBinding = {
  agentId: string;
  botId: string;
  botUsername: string;
  botName: string;
  createdAt: string;
  updatedAt: string;
};

type StoredTelegramAgentBinding = TelegramAgentBinding & {
  botToken: string;
};

export class SqliteTelegramAgentBindingStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.createSchema();
  }

  listBindings(): TelegramAgentBinding[] {
    return (this.database.prepare(`
      SELECT agent_id, bot_id, bot_username, bot_name, created_at, updated_at
      FROM telegram_agent_bindings
      ORDER BY agent_id
    `).all() as TelegramBindingRow[]).map(bindingFromRow);
  }

  getBotToken(agentId: string): string | null {
    const row = this.database.prepare(`
      SELECT bot_token FROM telegram_agent_bindings WHERE agent_id = ?
    `).get(agentId) as { bot_token: string } | undefined;
    return row?.bot_token ?? null;
  }

  findByBotId(botId: string): TelegramAgentBinding | null {
    const row = this.database.prepare(`
      SELECT agent_id, bot_id, bot_username, bot_name, created_at, updated_at
      FROM telegram_agent_bindings
      WHERE bot_id = ?
    `).get(botId) as TelegramBindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }

  saveBinding(binding: StoredTelegramAgentBinding): TelegramAgentBinding {
    this.database.prepare(`
      INSERT INTO telegram_agent_bindings (
        agent_id,
        bot_id,
        bot_username,
        bot_name,
        bot_token,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        bot_id = excluded.bot_id,
        bot_username = excluded.bot_username,
        bot_name = excluded.bot_name,
        bot_token = excluded.bot_token,
        updated_at = excluded.updated_at
    `).run(
      binding.agentId,
      binding.botId,
      binding.botUsername,
      binding.botName,
      binding.botToken,
      binding.createdAt,
      binding.updatedAt,
    );
    return this.listBindings().find((item) => item.agentId === binding.agentId)!;
  }

  removeBinding(agentId: string): boolean {
    const result = this.database.prepare(`
      DELETE FROM telegram_agent_bindings WHERE agent_id = ?
    `).run(agentId);
    return Number(result.changes) > 0;
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS telegram_agent_bindings (
        agent_id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL UNIQUE,
        bot_username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        bot_name TEXT NOT NULL,
        bot_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
}

export type TelegramAgentBindingServiceOptions = {
  store: SqliteTelegramAgentBindingStore;
  agentExists: (agentId: string) => boolean;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  clock?: () => Date;
};

export class TelegramAgentBindingService {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly clock: () => Date;

  constructor(private readonly options: TelegramAgentBindingServiceOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.clock = options.clock ?? (() => new Date());
  }

  listBindings(): TelegramAgentBinding[] {
    return this.options.store.listBindings();
  }

  async bindAgent(agentId: string, token: string): Promise<TelegramAgentBinding> {
    const normalizedAgentId = agentId.trim();
    const normalizedToken = token.trim();
    if (!normalizedAgentId || !this.options.agentExists(normalizedAgentId)) {
      throw new Error(`Unknown agent: ${normalizedAgentId || agentId}`);
    }
    if (!normalizedToken) throw new Error("Telegram bot token is required.");

    const identity = await this.getBotIdentity(normalizedToken);
    const owner = this.options.store.findByBotId(identity.id);
    if (owner && owner.agentId !== normalizedAgentId) {
      throw new Error(`Telegram bot @${identity.username} already represents agent ${owner.agentId}.`);
    }
    const existing = this.options.store.listBindings().find((item) => item.agentId === normalizedAgentId);
    const now = this.clock().toISOString();
    return this.options.store.saveBinding({
      agentId: normalizedAgentId,
      botId: identity.id,
      botUsername: identity.username,
      botName: identity.name,
      botToken: normalizedToken,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async removeBinding(agentId: string): Promise<boolean> {
    return this.options.store.removeBinding(agentId.trim());
  }

  private async getBotIdentity(token: string): Promise<{ id: string; username: string; name: string }> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}/bot${token}/getMe`);
    const body = await response.json() as unknown;
    if (!response.ok || !isRecord(body) || body.ok !== true || !isRecord(body.result)) {
      throw new Error(telegramApiError(body, response.status));
    }
    const result = body.result;
    if (
      result.is_bot !== true
      || (typeof result.id !== "number" && typeof result.id !== "string")
      || typeof result.username !== "string"
      || !result.username.trim()
    ) {
      throw new Error("Telegram getMe returned an invalid bot identity.");
    }
    const name = [result.first_name, result.last_name]
      .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
      .join(" ")
      .trim() || result.username;
    return {
      id: String(result.id),
      username: result.username,
      name,
    };
  }
}

type TelegramBindingRow = {
  agent_id: string;
  bot_id: string;
  bot_username: string;
  bot_name: string;
  created_at: string;
  updated_at: string;
};

function bindingFromRow(row: TelegramBindingRow): TelegramAgentBinding {
  return {
    agentId: row.agent_id,
    botId: row.bot_id,
    botUsername: row.bot_username,
    botName: row.bot_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function telegramApiError(value: unknown, status: number): string {
  if (isRecord(value) && typeof value.description === "string") return value.description;
  return `Telegram API returned HTTP ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
