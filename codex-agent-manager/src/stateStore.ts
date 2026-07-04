import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentEvent,
  AgentEventCursor,
  AgentEventPage,
  AgentEventQuery,
  AgentStateStore,
  PersistedAgentManagerState,
} from "./types.js";

export class MemoryAgentStateStore implements AgentStateStore {
  private state: PersistedAgentManagerState;

  constructor(initialState: PersistedAgentManagerState = {}) {
    this.state = cloneState(initialState);
  }

  async load(): Promise<PersistedAgentManagerState> {
    return cloneState(this.state);
  }

  async save(state: PersistedAgentManagerState): Promise<void> {
    this.state = cloneState(state);
  }
}

export class JsonFileAgentStateStore implements AgentStateStore {
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<PersistedAgentManagerState> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as PersistedAgentManagerState;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async save(state: PersistedAgentManagerState): Promise<void> {
    const snapshot = cloneState(state);
    const write = () => this.writeState(snapshot);
    this.saveChain = this.saveChain.then(write, write);
    return this.saveChain;
  }

  private async writeState(state: PersistedAgentManagerState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, "utf8");
    await rename(tempPath, this.path);
  }
}

export class SqliteAgentStateStore implements AgentStateStore {
  private readonly database: DatabaseSync;

  constructor(
    private readonly path: string,
    private readonly options: { legacyJsonPath?: string } = {},
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.createSchema();
  }

  async load(): Promise<PersistedAgentManagerState> {
    this.importLegacyStateIfNeeded();
    return {
      version: 1,
      agents: Object.fromEntries(this.readRows("agents").map((row) => [row.id, parseJson(row.stateJson)])),
      sensorEvents: this.readRows("sensor_events").map((row) => parseJson(row.stateJson)),
      workItems: this.readRows("work_items").map((row) => parseJson(row.stateJson)),
      notifications: this.readRows("notifications").map((row) => parseJson(row.stateJson)),
      compatibilityApprovals: this.readRows("compatibility_approvals").map((row) => parseJson(row.stateJson)),
    } as PersistedAgentManagerState;
  }

  async save(state: PersistedAgentManagerState): Promise<void> {
    this.transaction(() => {
      if (state.agents !== undefined) {
        this.replaceRows("agents", Object.entries(state.agents));
      }
      if (state.sensorEvents !== undefined) {
        this.replaceRows("sensor_events", state.sensorEvents.map((value) => [value.id, value]));
      }
      if (state.workItems !== undefined) {
        this.replaceRows("work_items", state.workItems.map((value) => [value.id, value]));
      }
      if (state.notifications !== undefined) {
        this.replaceRows("notifications", state.notifications.map((value) => [value.id, value]));
      }
      if (state.compatibilityApprovals !== undefined) {
        this.replaceRows(
          "compatibility_approvals",
          state.compatibilityApprovals.map((value) => [value.id, value]),
        );
      }
      if (state.events !== undefined) {
        this.database.exec("DELETE FROM events");
        this.insertEvents(state.events);
      }
      this.setMeta("schema_version", "1");
    });
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    this.database.prepare(`
      INSERT OR REPLACE INTO events (id, agent_id, type, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.agentId, event.type, event.message, JSON.stringify(event.payload), event.createdAt);
  }

  queryEvents(query: AgentEventQuery = {}): AgentEventPage {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.agentId) {
      conditions.push("agent_id = ?");
      parameters.push(query.agentId);
    }
    if (query.beforeId !== undefined) {
      conditions.push("id < ?");
      parameters.push(query.beforeId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const requestedLimit = query.limit === undefined
      ? null
      : Math.max(1, Math.min(Math.floor(query.limit), 5_000));
    const sqlLimit = requestedLimit === null ? "" : "LIMIT ?";
    if (requestedLimit !== null) parameters.push(requestedLimit + 1);
    const rows = this.database.prepare(`
      SELECT id, agent_id, type, message, payload_json, created_at
      FROM events
      ${where}
      ORDER BY id DESC
      ${sqlLimit}
    `).all(...parameters) as EventRow[];
    const hasMore = requestedLimit !== null && rows.length > requestedLimit;
    const pageRows = hasMore ? rows.slice(0, requestedLimit ?? undefined) : rows;
    const events = pageRows.reverse().map(eventFromRow);
    return {
      events,
      hasMore,
      nextBeforeId: hasMore && events.length ? events[0]?.id ?? null : null,
    };
  }

  eventCursor(): AgentEventCursor {
    const row = this.database.prepare(`
      SELECT
        COALESCE(MAX(id), 0) AS max_event_id,
        COALESCE(MAX(
          CASE
            WHEN json_extract(payload_json, '$.approvalId') LIKE 'approval-%'
            THEN CAST(substr(json_extract(payload_json, '$.approvalId'), 10) AS INTEGER)
            ELSE 0
          END
        ), 0) AS max_approval_id
      FROM events
    `).get() as { max_event_id: number; max_approval_id: number };
    return {
      maxEventId: Number(row.max_event_id),
      maxApprovalId: Number(row.max_approval_id),
    };
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_agent_id_id ON events(agent_id, id DESC);
      CREATE INDEX IF NOT EXISTS events_type_id ON events(type, id DESC);
      CREATE TABLE IF NOT EXISTS sensor_events (
        id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS compatibility_approvals (
        id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      );
    `);
  }

  private importLegacyStateIfNeeded(): void {
    if (this.getMeta("legacy_import_complete") === "true") return;
    const hasData = Number((this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agents) +
        (SELECT COUNT(*) FROM events) +
        (SELECT COUNT(*) FROM sensor_events) +
        (SELECT COUNT(*) FROM work_items) AS count
    `).get() as { count: number }).count) > 0;
    if (hasData) {
      this.setMeta("legacy_import_complete", "true");
      return;
    }
    const legacyPath = this.options.legacyJsonPath;
    if (!legacyPath || !existsSync(legacyPath)) {
      this.setMeta("legacy_import_complete", "true");
      return;
    }
    const state = JSON.parse(readFileSync(legacyPath, "utf8")) as PersistedAgentManagerState;
    this.transaction(() => {
      this.replaceRows("agents", Object.entries(state.agents ?? {}));
      this.replaceRows("sensor_events", (state.sensorEvents ?? []).map((value) => [value.id, value]));
      this.replaceRows("work_items", (state.workItems ?? []).map((value) => [value.id, value]));
      this.replaceRows("notifications", (state.notifications ?? []).map((value) => [value.id, value]));
      this.replaceRows(
        "compatibility_approvals",
        (state.compatibilityApprovals ?? []).map((value) => [value.id, value]),
      );
      this.insertEvents(state.events ?? []);
      this.setMeta("legacy_json_path", legacyPath);
      this.setMeta("legacy_import_complete", "true");
      this.setMeta("schema_version", "1");
    });
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  private insertEvents(events: AgentEvent[]): void {
    const statement = this.database.prepare(`
      INSERT OR REPLACE INTO events (id, agent_id, type, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const event of events) {
      statement.run(event.id, event.agentId, event.type, event.message, JSON.stringify(event.payload), event.createdAt);
    }
  }

  private readRows(table: EntityTable): EntityRow[] {
    return this.database.prepare(`SELECT id, state_json FROM ${table} ORDER BY rowid ASC`).all()
      .map((row) => {
        const typed = row as { id: string; state_json: string };
        return { id: typed.id, stateJson: typed.state_json };
      });
  }

  private replaceRows(table: EntityTable, rows: Array<[string, unknown]>): void {
    this.database.exec(`DELETE FROM ${table}`);
    const statement = this.database.prepare(`INSERT INTO ${table} (id, state_json) VALUES (?, ?)`);
    for (const [id, value] of rows) statement.run(id, JSON.stringify(value));
  }

  private getMeta(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private transaction(action: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

type EntityTable = "agents" | "sensor_events" | "work_items" | "notifications" | "compatibility_approvals";
type EntityRow = { id: string; stateJson: string };
type EventRow = {
  id: number;
  agent_id: string;
  type: AgentEvent["type"];
  message: string;
  payload_json: string;
  created_at: string;
};

function eventFromRow(row: EventRow): AgentEvent {
  return {
    id: Number(row.id),
    agentId: row.agent_id,
    type: row.type,
    message: row.message,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function cloneState(state: PersistedAgentManagerState): PersistedAgentManagerState {
  return JSON.parse(JSON.stringify(state)) as PersistedAgentManagerState;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
