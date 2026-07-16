import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type TailscaleStatus = {
  BackendState?: string;
  Self?: {
    DNSName?: string;
  };
};

export type TailscalePrivateAccess = {
  controlUrl: string;
  dnsName: string;
};

export class TailscaleSetupError extends Error {
  constructor(
    message: string,
    readonly approvalUrl?: string,
  ) {
    super(message);
    this.name = "TailscaleSetupError";
  }
}

export class TailscaleService {
  constructor(
    private readonly options: {
      platform?: NodeJS.Platform;
      environment?: NodeJS.ProcessEnv;
      homeDirectory?: string;
      fileExists?: (path: string) => Promise<boolean>;
      run?: (executable: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
    } = {},
  ) {}

  async locateBinary(): Promise<string> {
    const environment = this.options.environment ?? process.env;
    const configured = environment.SQUADAI_TAILSCALE_BINARY?.trim();
    if (configured) {
      if (await this.fileExists(configured)) return configured;
      throw new TailscaleSetupError(`Tailscale was not found at ${configured}.`);
    }

    for (const candidate of this.binaryCandidates()) {
      if (await this.fileExists(candidate)) return candidate;
    }

    try {
      await this.run("tailscale", ["version"]);
      return "tailscale";
    } catch {
      throw new TailscaleSetupError(
        "Tailscale is not installed. Install Tailscale and sign in, then try again.",
      );
    }
  }

  async ensurePrivateAccess(localPort: number): Promise<TailscalePrivateAccess> {
    const executable = await this.locateBinary();
    const status = await this.readStatus(executable);
    if (status.BackendState !== "Running") {
      throw new TailscaleSetupError(
        "Tailscale is installed but not connected. Open Tailscale, sign in, and try again.",
      );
    }
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
    if (!dnsName) {
      throw new TailscaleSetupError(
        "Tailscale is connected, but this machine does not have a private DNS name.",
      );
    }

    try {
      await this.run(executable, ["serve", "--bg", "--yes", String(localPort)], 5_000);
    } catch (error) {
      const output = commandErrorText(error);
      const approvalUrl = findUrl(output);
      if (approvalUrl) {
        throw new TailscaleSetupError(
          "Tailscale needs one-time approval before SquadAI can be shared privately.",
          approvalUrl,
        );
      }
      if (/access is denied|permission denied|must be run as administrator/i.test(output)) {
        throw new TailscaleSetupError(
          "Windows blocked SquadAI from configuring Tailscale. Restart SquadAI once as Administrator and try again.",
        );
      }
      throw new TailscaleSetupError(
        `Tailscale could not share SquadAI privately: ${cleanCommandError(output)}`,
      );
    }

    return {
      controlUrl: `https://${dnsName}`,
      dnsName,
    };
  }

  private async readStatus(executable: string): Promise<TailscaleStatus> {
    try {
      const { stdout } = await this.run(executable, ["status", "--json"]);
      return JSON.parse(stdout) as TailscaleStatus;
    } catch (error) {
      const output = commandErrorText(error);
      if (/access is denied|permission denied/i.test(output)) {
        throw new TailscaleSetupError(
          "Windows blocked SquadAI from reading Tailscale. Restart SquadAI once as Administrator and try again.",
        );
      }
      throw new TailscaleSetupError(
        `SquadAI could not read Tailscale status: ${cleanCommandError(output)}`,
      );
    }
  }

  private binaryCandidates(): string[] {
    const platform = this.options.platform ?? process.platform;
    const environment = this.options.environment ?? process.env;
    const home = this.options.homeDirectory ?? homedir();
    if (platform === "win32") {
      return [
        environment.ProgramFiles && join(environment.ProgramFiles, "Tailscale", "tailscale.exe"),
        environment["ProgramFiles(x86)"]
          && join(environment["ProgramFiles(x86)"], "Tailscale", "tailscale.exe"),
        environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, "Tailscale", "tailscale.exe"),
        "C:\\Program Files\\Tailscale\\tailscale.exe",
      ].filter((candidate): candidate is string => Boolean(candidate));
    }
    if (platform === "darwin") {
      return [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        join(home, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale"),
      ];
    }
    return [
      "/usr/bin/tailscale",
      "/usr/local/bin/tailscale",
      "/snap/bin/tailscale",
      "/opt/bin/tailscale",
    ];
  }

  private async fileExists(path: string): Promise<boolean> {
    if (this.options.fileExists) return this.options.fileExists(path);
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async run(
    executable: string,
    args: string[],
    timeout = 30_000,
  ): Promise<{ stdout: string; stderr: string }> {
    if (this.options.run) return this.options.run(executable, args);
    return execFileAsync(executable, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout,
    });
  }
}

function commandErrorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  return [record.stderr, record.stdout, record.message]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .join("\n");
}

function findUrl(value: string): string | undefined {
  return value.match(/https:\/\/[^\s]+/)?.[0]?.replace(/[).,]+$/, "");
}

function cleanCommandError(value: string): string {
  return value.trim().split(/\r?\n/).find((line) => line.trim())?.trim() || "unknown error";
}
