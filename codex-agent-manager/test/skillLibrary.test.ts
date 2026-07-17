import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  exportUserSkill,
  installUserSkill,
  RunnerHub,
  SkillLibraryService,
  validateSkillPackage,
  type AgentSkillCatalog,
  type CodexAgentManager,
  type RunnerRegistration,
  type SkillPackage,
} from "../src/index.js";

test("skill packages copy a complete user skill and refuse unsafe or duplicate installs", async () => {
  const root = await mkdtemp(join(tmpdir(), "squadai-skill-package-"));
  const sourceSkills = join(root, "source");
  const source = join(sourceSkills, "reviewer");
  await mkdir(join(source, "scripts"), { recursive: true });
  await writeFile(join(source, "SKILL.md"), "---\nname: reviewer\n---\nReview carefully.\n");
  await writeFile(join(source, "scripts", "check.js"), "console.log('checked');\n");

  const skill = await exportUserSkill(join(source, "SKILL.md"), {
    name: "reviewer",
    description: "Reviews code",
    skillsDirectory: sourceSkills,
  });
  const targetSkills = join(root, "target");
  const installed = await installUserSkill(skill, { skillsDirectory: targetSkills });

  assert.equal(await readFile(installed.path, "utf8"), "---\nname: reviewer\n---\nReview carefully.\n");
  assert.equal(await readFile(join(targetSkills, "reviewer", "scripts", "check.js"), "utf8"), "console.log('checked');\n");
  await assert.rejects(installUserSkill(skill, { skillsDirectory: targetSkills }), /already installed/i);
  assert.throws(() => validateSkillPackage({
    ...skill,
    files: [...skill.files, { path: "../outside.txt", content: "" }],
  }), /unsafe skill package path/i);
  assert.throws(() => validateSkillPackage({ ...skill, fingerprint: "changed" }), /fingerprint/i);
  assert.throws(() => validateSkillPackage({
    ...skill,
    files: skill.files.map((file) => file.path === "SKILL.md" ? { ...file, content: "not base64!" } : file),
  }), /base64/i);
});

test("skill library imports from one runner and sends the package to another runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "squadai-skill-library-"));
  const sourceSkills = join(root, "source-skills");
  const source = join(sourceSkills, "news-digest");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "Latest news workflow.\n");
  const skillPackage = await exportUserSkill(join(source, "SKILL.md"), {
    name: "news-digest",
    description: "Builds a news digest",
    skillsDirectory: sourceSkills,
  });

  const hub = new RunnerHub("secret");
  hub.register(registration("source-runner"));
  hub.register(registration("target-runner"));
  const manager = {
    async listSkillOptions(): Promise<AgentSkillCatalog> {
      return { cwd: root, skills: [], errors: [] };
    },
  } as unknown as CodexAgentManager;
  const service = new SkillLibraryService(
    join(root, "control.db"),
    join(root, "library"),
    manager,
    hub,
  );

  try {
    const snapshotPromise = service.snapshot();
    const sourceList = await hub.poll("source-runner", 100);
    const targetList = await hub.poll("target-runner", 100);
    assert.equal(sourceList?.type, "skills.listUser");
    assert.equal(targetList?.type, "skills.listUser");
    hub.complete("source-runner", sourceList!.id, {
      ok: true,
      value: catalog(root, "source-runner", true),
    });
    hub.complete("target-runner", targetList!.id, {
      ok: true,
      value: catalog(root, "target-runner", false),
    });
    const snapshot = await snapshotPromise;
    assert.equal(snapshot.discovered[0]?.name, "news-digest");

    const importPromise = service.importSkill({
      runnerId: "source-runner",
      name: "news-digest",
      path: join(source, "SKILL.md"),
      description: "Builds a news digest",
    });
    const exportCommand = await hub.poll("source-runner", 100);
    assert.equal(exportCommand?.type, "skills.export");
    hub.complete("source-runner", exportCommand!.id, { ok: true, value: skillPackage });
    const imported = await importPromise;
    assert.equal(imported.name, "news-digest");

    const installPromise = service.installSkill("news-digest", "target-runner");
    const installCommand = await hub.poll("target-runner", 100);
    assert.equal(installCommand?.type, "skills.install");
    assert.equal((installCommand?.payload?.package as SkillPackage).fingerprint, skillPackage.fingerprint);
    hub.complete("target-runner", installCommand!.id, {
      ok: true,
      value: { path: "/home/test/.codex/skills/news-digest/SKILL.md" },
    });
    const installed = await installPromise;
    assert.equal(installed.runnerId, "target-runner");
  } finally {
    await service.close();
  }
});

function catalog(root: string, runnerId: string, hasSkill: boolean): AgentSkillCatalog {
  return {
    cwd: root,
    skills: hasSkill ? [{
      name: "news-digest",
      scope: "user",
      description: "Builds a news digest",
      path: join(root, runnerId, "news-digest", "SKILL.md"),
      enabled: true,
    }] : [],
    errors: [],
  };
}

function registration(id: string): RunnerRegistration {
  return {
    id,
    name: id,
    hostname: `${id}.test`,
    platform: "linux",
    arch: "x64",
    version: "test",
  };
}
