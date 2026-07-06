import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { win32 } from "node:path";
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

export type CodexLaunchResolutionOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

export type CodexLaunchSpec = {
  command: string;
  args: string[];
};

export function resolveCodexBinary(options: CodexBinaryResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? executable;
  const configured = env.CODEX_BINARY?.trim();
  if (configured) {
    return platform === "win32"
      ? resolveWindowsCommand(configured, env, isExecutable)
      : configured;
  }

  if (platform === "darwin" && isExecutable(CODEX_DESKTOP_BINARY)) {
    return CODEX_DESKTOP_BINARY;
  }

  if (platform === "win32") {
    return resolveWindowsCommand("codex", env, isExecutable);
  }

  return "codex";
}

export function createCodexLaunchSpec(
  command: string,
  args: string[],
  options: CodexLaunchResolutionOptions = {},
): CodexLaunchSpec {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args: [...args] };
  }
  const env = options.env ?? process.env;
  return {
    command: environmentValue(env, "ComSpec") || "cmd.exe",
    args: ["/d", "/s", "/c", command, ...args],
  };
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

    const launch = createCodexLaunchSpec(this.command, this.args, { env: this.env ?? process.env });
    const child = spawn(launch.command, launch.args, {
      env: this.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
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
    child.stdin.end();
    if (await waitForExit(child, 1_000)) return;
    child.kill("SIGTERM");
    await waitForExit(child, 1_000);
  }

  private emitClose(error?: Error): void {
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}

function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  isExecutable: (path: string) => boolean,
): string {
  if (win32.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }
  const pathValue = environmentValue(env, "Path");
  if (!pathValue) return command;
  const extensions = win32.extname(command)
    ? [""]
    : (environmentValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
      .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  for (const pathEntry of pathValue.split(";").map((entry) => entry.trim().replace(/^"|"$/g, ""))) {
    if (!pathEntry) continue;
    for (const extension of extensions) {
      const candidate = win32.join(pathEntry, `${command}${extension.toLowerCase()}`);
      if (isExecutable(candidate)) return candidate;
      const upperCaseCandidate = win32.join(pathEntry, `${command}${extension.toUpperCase()}`);
      if (upperCaseCandidate !== candidate && isExecutable(upperCaseCandidate)) return upperCaseCandidate;
    }
  }
  return command;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const exited = () => finish(true);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      child.off("exit", exited);
      resolve(value);
    };
    child.once("exit", exited);
  });
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
