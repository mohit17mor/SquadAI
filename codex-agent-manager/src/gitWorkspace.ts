import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  AgentDefinition,
  AgentWorkspaceManager,
  AgentWorkspaceStatus,
} from "./types.js";
import { CodexAgentManagerError } from "./types.js";

const execFileAsync = promisify(execFile);
const WORKSPACE_METADATA_KEY = "commandCenterWorkspace";

type GitContext = {
  commandCwd: string;
  repositoryRoot: string;
  worktreeRoot: string;
  relativeCwd: string;
  sourceBranch: string;
  sourceRef: string;
};

type WorkspaceMetadata = {
  kind: "git-worktree";
  repositoryRoot: string;
  sourceBranch: string;
  sourceRef: string;
  worktreePath: string;
  branch: string;
  relativeCwd: string;
  createdAt: string;
  removedAt?: string;
};

export type GitWorkspaceManagerOptions = {
  rootPath?: string;
  now?: () => Date;
};

export class GitWorkspaceManager implements AgentWorkspaceManager {
  private readonly rootPath: string;
  private readonly now: () => Date;

  constructor(options: GitWorkspaceManagerOptions = {}) {
    this.rootPath = resolve(options.rootPath ?? join(homedir(), ".codex", "command-center", "worktrees"));
    this.now = options.now ?? (() => new Date());
  }

  async prepareBase(definition: AgentDefinition): Promise<AgentDefinition> {
    const managed = workspaceMetadata(definition);
    if (managed && !managed.removedAt && existsSync(managed.worktreePath)) {
      return cloneDefinition(definition);
    }
    const context = await discoverGitContext(definition.cwd);
    if (!context) return cloneDefinition(definition);
    return this.createManagedDefinition(
      definition,
      context,
      `codex/agent-${slug(definition.id)}`,
      slug(definition.id),
    );
  }

  async prepareInstance(base: AgentDefinition, instance: AgentDefinition): Promise<AgentDefinition> {
    const baseWorkspace = workspaceMetadata(base);
    const context = baseWorkspace && !baseWorkspace.removedAt
      ? await contextFromManagedWorkspace(baseWorkspace)
      : await discoverGitContext(base.cwd);
    if (!context) return cloneDefinition(instance);
    return this.createManagedDefinition(
      instance,
      context,
      `codex/task-${slug(instance.id)}`,
      slug(instance.id),
    );
  }

  async inspect(definition: AgentDefinition): Promise<AgentWorkspaceStatus | null> {
    const metadata = workspaceMetadata(definition);
    if (!metadata) return null;
    if (metadata.removedAt || !existsSync(metadata.worktreePath)) {
      return {
        kind: "git-worktree",
        repositoryRoot: metadata.repositoryRoot,
        worktreePath: metadata.worktreePath,
        branch: metadata.branch,
        sourceBranch: metadata.sourceBranch,
        dirty: false,
        removed: true,
      };
    }
    const branch = (await git(metadata.worktreePath, ["branch", "--show-current"])).trim()
      || (await git(metadata.worktreePath, ["rev-parse", "--short", "HEAD"])).trim();
    const porcelain = await git(metadata.worktreePath, ["status", "--porcelain"]);
    return {
      kind: "git-worktree",
      repositoryRoot: metadata.repositoryRoot,
      worktreePath: metadata.worktreePath,
      branch,
      sourceBranch: metadata.sourceBranch,
      dirty: Boolean(porcelain.trim()),
      removed: false,
    };
  }

  async cleanup(definition: AgentDefinition): Promise<AgentDefinition> {
    const metadata = workspaceMetadata(definition);
    if (!metadata) {
      throw new CodexAgentManagerError(`Agent ${definition.id} does not have a managed Git worktree.`);
    }
    const status = await this.inspect(definition);
    if (status?.removed) return cloneDefinition(definition);
    if (status?.dirty) {
      throw new CodexAgentManagerError(
        `Worktree for ${definition.id} has uncommitted changes and will not be removed.`,
      );
    }
    await git(metadata.repositoryRoot, ["worktree", "remove", metadata.worktreePath]);
    const next = cloneDefinition(definition);
    next.metadata = {
      ...(next.metadata ?? {}),
      [WORKSPACE_METADATA_KEY]: {
        ...metadata,
        removedAt: this.now().toISOString(),
      },
    };
    return next;
  }

  private async createManagedDefinition(
    definition: AgentDefinition,
    context: GitContext,
    requestedBranch: string,
    directoryName: string,
  ): Promise<AgentDefinition> {
    const repositoryKey = createHash("sha256").update(context.repositoryRoot).digest("hex").slice(0, 12);
    const repositoryDirectory = join(this.rootPath, `${slug(basename(context.repositoryRoot))}-${repositoryKey}`);
    const created = await createWorktree(
      context.commandCwd,
      repositoryDirectory,
      directoryName,
      requestedBranch,
      context.sourceRef,
    );
    const next = cloneDefinition(definition);
    const worktreeCwd = context.relativeCwd ? join(created.path, context.relativeCwd) : created.path;
    if (!existsSync(worktreeCwd)) {
      throw new CodexAgentManagerError(
        `Managed worktree for ${definition.id} does not contain configured directory ${context.relativeCwd}.`,
      );
    }
    const metadata: WorkspaceMetadata = {
      kind: "git-worktree",
      repositoryRoot: context.repositoryRoot,
      sourceBranch: context.sourceBranch,
      sourceRef: context.sourceRef,
      worktreePath: created.path,
      branch: created.branch,
      relativeCwd: context.relativeCwd,
      createdAt: this.now().toISOString(),
    };
    next.cwd = worktreeCwd;
    next.metadata = {
      ...(next.metadata ?? {}),
      [WORKSPACE_METADATA_KEY]: metadata,
    };
    return next;
  }
}

async function discoverGitContext(cwd: string): Promise<GitContext | null> {
  const markerRoot = findGitMarker(cwd);
  if (!markerRoot) return null;
  const worktreeRoot = realpathSync((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
  const relativeCwd = (await git(cwd, ["rev-parse", "--show-prefix"]))
    .trim()
    .replace(/[\\/]+$/, "")
    .split("/")
    .join(sep);
  const worktreeList = await git(cwd, ["worktree", "list", "--porcelain"]);
  const repositoryRootValue = firstWorktreePath(worktreeList) ?? worktreeRoot;
  const repositoryRoot = existsSync(repositoryRootValue) ? realpathSync(repositoryRootValue) : repositoryRootValue;
  const branch = (await git(cwd, ["branch", "--show-current"])).trim();
  const sourceRef = branch || (await git(cwd, ["rev-parse", "HEAD"])).trim();
  return {
    commandCwd: worktreeRoot,
    repositoryRoot,
    worktreeRoot,
    relativeCwd,
    sourceBranch: branch || sourceRef,
    sourceRef,
  };
}

async function contextFromManagedWorkspace(metadata: WorkspaceMetadata): Promise<GitContext> {
  const sourceRef = await refExists(metadata.repositoryRoot, metadata.sourceBranch)
    ? metadata.sourceBranch
    : metadata.sourceRef;
  return {
    commandCwd: metadata.repositoryRoot,
    repositoryRoot: metadata.repositoryRoot,
    worktreeRoot: metadata.repositoryRoot,
    relativeCwd: metadata.relativeCwd,
    sourceBranch: metadata.sourceBranch,
    sourceRef,
  };
}

async function createWorktree(
  commandCwd: string,
  repositoryDirectory: string,
  requestedDirectory: string,
  requestedBranch: string,
  sourceRef: string,
): Promise<{ path: string; branch: string }> {
  for (let suffix = 0; suffix < 1_000; suffix++) {
    const tail = suffix ? `-${suffix + 1}` : "";
    const branch = `${requestedBranch}${tail}`;
    const path = join(repositoryDirectory, `${requestedDirectory}${tail}`);
    if (existsSync(path)) {
      if (findGitMarker(path)) {
        const actualBranch = (await git(path, ["branch", "--show-current"])).trim();
        if (actualBranch === branch) return { path, branch };
      }
      continue;
    }
    if (await refExists(commandCwd, branch)) continue;
    await git(commandCwd, ["worktree", "add", "-b", branch, path, sourceRef]);
    return { path, branch };
  }
  throw new CodexAgentManagerError(`Could not allocate a unique worktree branch for ${requestedBranch}.`);
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CodexAgentManagerError(`Git workspace operation failed: ${message}`);
  }
}

function findGitMarker(input: string): string | null {
  let current = resolve(input);
  while (existsSync(current)) {
    const marker = join(current, ".git");
    if (existsSync(marker)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function firstWorktreePath(value: string): string | null {
  const line = value.split(/\r?\n/).find((item) => item.startsWith("worktree "));
  return line ? line.slice("worktree ".length).trim() : null;
}

function workspaceMetadata(definition: AgentDefinition): WorkspaceMetadata | null {
  const value = definition.metadata?.[WORKSPACE_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Partial<WorkspaceMetadata>;
  if (
    metadata.kind !== "git-worktree"
    || typeof metadata.repositoryRoot !== "string"
    || typeof metadata.worktreePath !== "string"
    || typeof metadata.branch !== "string"
    || typeof metadata.sourceBranch !== "string"
    || typeof metadata.sourceRef !== "string"
    || typeof metadata.relativeCwd !== "string"
    || typeof metadata.createdAt !== "string"
  ) return null;
  return metadata as WorkspaceMetadata;
}

function cloneDefinition(definition: AgentDefinition): AgentDefinition {
  return JSON.parse(JSON.stringify(definition)) as AgentDefinition;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "agent";
}
