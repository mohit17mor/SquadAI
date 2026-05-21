import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentStateStore, PersistedAgentManagerState } from "./types.js";

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

function cloneState(state: PersistedAgentManagerState): PersistedAgentManagerState {
  return JSON.parse(JSON.stringify(state)) as PersistedAgentManagerState;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
