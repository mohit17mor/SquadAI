import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { GitWorkspaceManager, type AgentDefinition } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("creates isolated base and task worktrees from the original branch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "command-center-worktree-"));
  const repository = join(directory, "repository");
  const worktrees = join(directory, "managed-worktrees");
  await mkdir(repository);
  await runGit(repository, ["init", "-b", "main"]);
  await runGit(repository, ["config", "user.email", "command-center@example.test"]);
  await runGit(repository, ["config", "user.name", "Command Center Test"]);
  await writeFile(join(repository, "README.md"), "initial\n", "utf8");
  await runGit(repository, ["add", "README.md"]);
  await runGit(repository, ["commit", "-m", "initial"]);
  const mainCommit = await runGit(repository, ["rev-parse", "main"]);

  await writeFile(join(repository, "local-notes.txt"), "uncommitted and intentionally local\n", "utf8");
  const manager = new GitWorkspaceManager({ rootPath: worktrees });
  const baseDefinition: AgentDefinition = {
    id: "coder",
    name: "Coder",
    cwd: repository,
    instructions: "Code safely.",
  };
  const base = await manager.prepareBase(baseDefinition);
  assert.notEqual(base.cwd, repository);
  assert.equal(await runGit(base.cwd, ["branch", "--show-current"]), "codex/agent-coder");
  assert.equal(await runGit(base.cwd, ["rev-parse", "HEAD"]), mainCommit);
  assert.equal(await pathExists(join(base.cwd, "local-notes.txt")), false);

  await writeFile(join(base.cwd, "base-only.txt"), "base branch change\n", "utf8");
  await runGit(base.cwd, ["add", "base-only.txt"]);
  await runGit(base.cwd, ["commit", "-m", "base-only"]);

  const instance = await manager.prepareInstance(base, {
    ...base,
    id: "coder--sensor-1",
    name: "Coder task",
  });
  assert.equal(await runGit(instance.cwd, ["branch", "--show-current"]), "codex/task-coder--sensor-1");
  assert.equal(await runGit(instance.cwd, ["rev-parse", "HEAD"]), mainCommit);
  assert.equal(await pathExists(join(instance.cwd, "base-only.txt")), false);

  await runGit(instance.cwd, ["switch", "-c", "user-requested-base", "main"]);
  assert.equal((await manager.inspect(instance))?.branch, "user-requested-base");

  const cleanStatus = await manager.inspect(instance);
  assert.equal(cleanStatus?.dirty, false);
  await writeFile(join(instance.cwd, "task-change.txt"), "dirty task change\n", "utf8");
  assert.equal((await manager.inspect(instance))?.dirty, true);
  await assert.rejects(manager.cleanup(instance), /has uncommitted changes and will not be removed/);

  await runGit(instance.cwd, ["add", "task-change.txt"]);
  await runGit(instance.cwd, ["commit", "-m", "task change"]);
  const cleaned = await manager.cleanup(instance);
  assert.equal((await manager.inspect(cleaned))?.removed, true);
  assert.equal(await runGit(repository, ["rev-parse", "--verify", "codex/task-coder--sensor-1"])
    .then(() => true), true);
});

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then(({ access }) => access(path));
    return true;
  } catch {
    return false;
  }
}
