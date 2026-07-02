import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import readline from "node:readline";

import type { AppServerTransport, JsonRpcMessage } from "./types.js";

export type StdioTransportOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
};

export const CODEX_DESKTOP_BINARY = "/Applications/Codex.app/Contents/Resources/codex";

export type CodexBinaryResolutionOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isExecutable?: (path: string) => boolean;
};

export function resolveCodexBinary(options: CodexBinaryResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env.CODEX_BINARY?.trim();
  if (configured) {
    return configured;
  }

  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? executable;
  if (platform === "darwin" && isExecutable(CODEX_DESKTOP_BINARY)) {
    return CODEX_DESKTOP_BINARY;
  }

  return "codex";
}

export class StdioCodexAppServerTransport implements AppServerTransport {
  private readonly command: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv | undefined;
  private child: ChildProcessWithoutNullStreams | null = null;
  private messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  private closeHandlers: Array<(error?: Error) => void> = [];

  constructor(options: StdioTransportOptions = {}) {
    this.command = options.command ?? resolveCodexBinary(
      options.env ? { env: options.env } : {},
    );
    this.args = options.args ?? ["app-server"];
    this.env = options.env;
  }

  getCommand(): string {
    return this.command;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const child = spawn(this.command, this.args, {
      env: this.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const stdout = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    stdout.on("line", (line) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", (error) => {
      this.emitClose(error);
    });
    child.once("exit", (code, signal) => {
      this.child = null;
      const clean = code === 0 || signal === "SIGTERM";
      this.emitClose(
        clean
          ? undefined
          : new Error(
              `codex app-server exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${stderr}`,
            ),
      );
    });
  }

  send(message: JsonRpcMessage): void {
    if (!this.child) {
      throw new Error("Codex App Server transport is not started.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  async close(): Promise<void> {
    if (!this.child) {
      return;
    }
    const child = this.child;
    this.child = null;
    child.kill("SIGTERM");
  }

  private emitClose(error?: Error): void {
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
