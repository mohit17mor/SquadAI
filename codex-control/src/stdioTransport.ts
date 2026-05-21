import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import type { AppServerTransport, JsonRpcMessage } from "./types.js";

export type StdioTransportOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
};

export class StdioCodexAppServerTransport implements AppServerTransport {
  private readonly command: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv | undefined;
  private child: ChildProcessWithoutNullStreams | null = null;
  private messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  private closeHandlers: Array<(error?: Error) => void> = [];

  constructor(options: StdioTransportOptions = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server"];
    this.env = options.env;
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
