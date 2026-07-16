import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { RunnerRegistration } from "./types.js";

const DEFAULT_ENROLLMENT_TTL_MS = 10 * 60 * 1_000;

export type RunnerEnrollment = {
  bundle: string;
  command: string;
  controlUrl: string;
  expiresAt: string;
};

export type RunnerCredential = {
  controlUrl: string;
  runnerId: string;
  token: string;
};

type EnrollmentRow = {
  control_url: string;
  expires_at: string;
  used_at: string | null;
};

export class SqliteRunnerEnrollmentStore {
  private readonly database: DatabaseSync;

  constructor(
    path: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.createSchema();
  }

  create(controlUrl: string, ttlMs = DEFAULT_ENROLLMENT_TTL_MS): RunnerEnrollment {
    const normalizedControlUrl = normalizeControlUrl(controlUrl);
    const code = randomToken(24);
    const expiresAt = new Date(this.clock().getTime() + ttlMs).toISOString();
    this.database.prepare(`
      INSERT INTO runner_enrollments (code_hash, control_url, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(hashSecret(code), normalizedControlUrl, expiresAt, this.clock().toISOString());
    const bundle = encodeRunnerEnrollmentBundle({ v: 1, controlUrl: normalizedControlUrl, code });
    return {
      bundle,
      command: `squadai runner connect ${bundle}`,
      controlUrl: normalizedControlUrl,
      expiresAt,
    };
  }

  exchange(code: string, registration: RunnerRegistration): RunnerCredential {
    const now = this.clock().toISOString();
    let credential: RunnerCredential | null = null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT control_url, expires_at, used_at
        FROM runner_enrollments
        WHERE code_hash = ?
      `).get(hashSecret(code)) as EnrollmentRow | undefined;
      if (!row) throw new Error("This runner enrollment code is invalid.");
      if (row.used_at) throw new Error("This runner enrollment code has already been used.");
      if (Date.parse(row.expires_at) <= this.clock().getTime()) {
        throw new Error("This runner enrollment code has expired. Create a new one in SquadAI.");
      }

      const runnerId = this.availableRunnerId(registration.id);
      const token = randomToken(32);
      this.database.prepare(`
        INSERT INTO runner_credentials (
          runner_id, token_hash, runner_name, hostname, platform, arch, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runnerId,
        hashSecret(token),
        registration.name,
        registration.hostname,
        registration.platform,
        registration.arch,
        now,
        now,
      );
      this.database.prepare(`
        UPDATE runner_enrollments SET used_at = ?, runner_id = ? WHERE code_hash = ?
      `).run(now, runnerId, hashSecret(code));
      credential = { controlUrl: row.control_url, runnerId, token };
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return credential;
  }

  authenticate(runnerId: string, token: string): boolean {
    const row = this.database.prepare(`
      SELECT token_hash FROM runner_credentials
      WHERE runner_id = ? AND revoked_at IS NULL
    `).get(runnerId) as { token_hash: string } | undefined;
    return Boolean(row && row.token_hash === hashSecret(token));
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private availableRunnerId(requestedId: string): string {
    const base = sanitizeRunnerId(requestedId);
    const exists = this.database.prepare(`
      SELECT 1 FROM runner_credentials WHERE runner_id = ?
    `);
    if (!exists.get(base)) return base;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = `${base}-${randomToken(4).toLowerCase()}`;
      if (!exists.get(candidate)) return candidate;
    }
    throw new Error("Could not allocate a unique runner ID.");
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runner_enrollments (
        code_hash TEXT PRIMARY KEY,
        control_url TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        runner_id TEXT
      );
      CREATE TABLE IF NOT EXISTS runner_credentials (
        runner_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        runner_name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        platform TEXT NOT NULL,
        arch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `);
  }
}

export function encodeRunnerEnrollmentBundle(value: {
  v: 1;
  controlUrl: string;
  code: string;
}): string {
  return `sq1_${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

export function decodeRunnerEnrollmentBundle(bundle: string): {
  v: 1;
  controlUrl: string;
  code: string;
} {
  if (!bundle.startsWith("sq1_")) throw new Error("Invalid SquadAI runner enrollment bundle.");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bundle.slice(4), "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid SquadAI runner enrollment bundle.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Invalid SquadAI runner enrollment bundle.");
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.controlUrl !== "string" || typeof record.code !== "string") {
    throw new Error("Unsupported SquadAI runner enrollment bundle.");
  }
  return {
    v: 1,
    controlUrl: normalizeControlUrl(record.controlUrl),
    code: record.code,
  };
}

function normalizeControlUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The control plane URL must use HTTP or HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function sanitizeRunnerId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `runner-${randomToken(4).toLowerCase()}`;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}
