import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import { decodeRunnerEnrollmentBundle } from "./runnerEnrollment.js";
import type { RunnerRegistration } from "./types.js";

export type SavedRunnerConfig = {
  version: 1;
  controlUrl: string;
  token: string;
  id: string;
  name: string;
  sshHost?: string;
};

export function runnerConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.SQUADAI_HOME?.trim() || join(homedir(), ".squadai");
  return join(home, "runner.json");
}

export async function enrollRunner(
  bundle: string,
  options: {
    name?: string;
    sshHost?: string;
    fetch?: typeof fetch;
    configPath?: string;
  } = {},
): Promise<SavedRunnerConfig> {
  const enrollment = decodeRunnerEnrollmentBundle(bundle);
  const machineName = hostname();
  const registration: RunnerRegistration = {
    id: machineName,
    name: options.name?.trim() || machineName,
    hostname: machineName,
    ...(options.sshHost?.trim() ? { sshHost: options.sshHost.trim() } : {}),
    platform: process.platform,
    arch: process.arch,
    version: "0.1.0",
  };
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${enrollment.controlUrl}/api/runner-enrollments/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: enrollment.code, runner: registration }),
  });
  const body = await response.json() as {
    controlUrl?: string;
    runnerId?: string;
    token?: string;
    error?: string;
  };
  if (!response.ok || !body.controlUrl || !body.runnerId || !body.token) {
    throw new Error(body.error || `Runner enrollment failed with HTTP ${response.status}.`);
  }
  const config: SavedRunnerConfig = {
    version: 1,
    controlUrl: body.controlUrl,
    token: body.token,
    id: body.runnerId,
    name: registration.name,
    ...(registration.sshHost ? { sshHost: registration.sshHost } : {}),
  };
  await saveRunnerConfig(config, options.configPath);
  return config;
}

export async function loadRunnerConfig(path = runnerConfigPath()): Promise<SavedRunnerConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`This machine is not enrolled yet. Run "squadai runner connect <bundle>" first.`);
    }
    throw error;
  }
  if (!value || typeof value !== "object") throw new Error(`Invalid runner config at ${path}.`);
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || typeof record.controlUrl !== "string"
    || typeof record.token !== "string"
    || typeof record.id !== "string"
    || typeof record.name !== "string"
  ) {
    throw new Error(`Invalid runner config at ${path}.`);
  }
  return {
    version: 1,
    controlUrl: record.controlUrl,
    token: record.token,
    id: record.id,
    name: record.name,
    ...(typeof record.sshHost === "string" ? { sshHost: record.sshHost } : {}),
  };
}

export async function saveRunnerConfig(
  config: SavedRunnerConfig,
  path = runnerConfigPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
