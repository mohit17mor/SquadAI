import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CodexAgentManager } from "./manager.js";
import type { RunnerHub } from "./runnerHub.js";
import {
  exportUserSkill,
  isPortableUserSkill,
  isValidSkillName,
  installUserSkill,
  validateSkillPackage,
  type SkillPackage,
} from "./skillPackages.js";
import type { AgentSkillCatalog, AgentSkillMetadata } from "./types.js";

export type SkillLibraryEntry = {
  name: string;
  description: string;
  fingerprint: string;
  sourceRunnerId: string;
  importedAt: string;
  installedRunnerIds: string[];
};

export type DiscoveredRunnerSkill = AgentSkillMetadata & {
  runnerId: string;
  runnerName: string;
  inLibrary: boolean;
};

export type SkillLibrarySnapshot = {
  library: SkillLibraryEntry[];
  discovered: DiscoveredRunnerSkill[];
  runners: Array<{ id: string; name: string; status: "online" | "offline" }>;
  errors: Array<{ runnerId: string; message: string }>;
};

type LibraryRow = {
  name: string;
  description: string;
  fingerprint: string;
  source_runner_id: string;
  imported_at: string;
};

export class SkillLibraryService {
  private readonly database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly libraryRoot: string,
    private readonly manager: CodexAgentManager,
    private readonly runnerHub: RunnerHub,
    private readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    mkdirSync(libraryRoot, { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS skill_library (
        name TEXT PRIMARY KEY COLLATE NOCASE,
        description TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        source_runner_id TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `);
  }

  async snapshot(): Promise<SkillLibrarySnapshot> {
    const runners = [
      { id: "local", name: "This machine", status: "online" as const },
      ...this.runnerHub.listRunners().map((runner) => ({
        id: runner.id,
        name: runner.name,
        status: runner.status,
      })),
    ];
    const discovered: DiscoveredRunnerSkill[] = [];
    const errors: Array<{ runnerId: string; message: string }> = [];
    await Promise.all(runners.filter((runner) => runner.status === "online").map(async (runner) => {
      try {
        const catalog = await this.userSkillCatalog(runner.id);
        for (const skill of catalog.skills.filter((item) => item.scope === "user" && isValidSkillName(item.name))) {
          discovered.push({
            ...skill,
            runnerId: runner.id,
            runnerName: runner.name,
            inLibrary: Boolean(this.getRow(skill.name)),
          });
        }
      } catch (error) {
        errors.push({ runnerId: runner.id, message: errorMessage(error) });
      }
    }));
    const library = this.listRows().map((row) => ({
      name: row.name,
      description: row.description,
      fingerprint: row.fingerprint,
      sourceRunnerId: row.source_runner_id,
      importedAt: row.imported_at,
      installedRunnerIds: discovered
        .filter((skill) => skill.name.toLowerCase() === row.name.toLowerCase())
        .map((skill) => skill.runnerId),
    }));
    return { library, discovered, runners, errors };
  }

  async importSkill(input: {
    runnerId: string;
    name: string;
    path: string;
    description?: string;
  }): Promise<SkillLibraryEntry> {
    if (this.getRow(input.name)) throw new Error(`Skill ${input.name} is already in the SquadAI library.`);
    const value = input.runnerId === "local"
      ? await exportUserSkill(input.path, {
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
        })
      : await this.runnerHub.execute(input.runnerId, "skills.export", "skill-library", {
          path: input.path,
          name: input.name,
          description: input.description ?? "",
        }, { timeoutMs: 60_000 });
    const skill = validateSkillPackage(value);
    const versionRoot = join(this.libraryRoot, skill.fingerprint);
    await installUserSkill(skill, { skillsDirectory: versionRoot });
    const importedAt = this.clock().toISOString();
    this.database.prepare(`
      INSERT INTO skill_library (name, description, fingerprint, source_runner_id, imported_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(skill.name, skill.description, skill.fingerprint, input.runnerId, importedAt);
    return {
      name: skill.name,
      description: skill.description,
      fingerprint: skill.fingerprint,
      sourceRunnerId: input.runnerId,
      importedAt,
      installedRunnerIds: [input.runnerId],
    };
  }

  async installSkill(name: string, runnerId: string): Promise<{ name: string; runnerId: string; path: string }> {
    const row = this.getRow(name);
    if (!row) throw new Error(`Unknown library skill: ${name}`);
    const skill = await this.loadPackage(row);
    const result = runnerId === "local"
      ? await installUserSkill(skill)
      : await this.runnerHub.execute(
          runnerId,
          "skills.install",
          "skill-library",
          { package: skill },
          { timeoutMs: 60_000 },
        );
    const path = result && typeof result === "object" && "path" in result
      ? String((result as { path: unknown }).path)
      : "";
    return { name: row.name, runnerId, path };
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private async userSkillCatalog(runnerId: string): Promise<AgentSkillCatalog> {
    if (runnerId === "local") {
      const catalog = await this.manager.listSkillOptions(process.cwd(), true, "local");
      return { ...catalog, skills: catalog.skills.filter((skill) => isPortableUserSkill(skill)) };
    }
    return await this.runnerHub.execute(
      runnerId,
      "skills.listUser",
      "skill-library",
      {},
      { timeoutMs: 15_000 },
    ) as AgentSkillCatalog;
  }

  private async loadPackage(row: LibraryRow): Promise<SkillPackage> {
    return exportUserSkill(
      join(this.libraryRoot, row.fingerprint, row.name, "SKILL.md"),
      {
        name: row.name,
        description: row.description,
        skillsDirectory: join(this.libraryRoot, row.fingerprint),
      },
    );
  }

  private listRows(): LibraryRow[] {
    return this.database.prepare(`
      SELECT name, description, fingerprint, source_runner_id, imported_at
      FROM skill_library ORDER BY name COLLATE NOCASE
    `).all() as LibraryRow[];
  }

  private getRow(name: string): LibraryRow | null {
    return this.database.prepare(`
      SELECT name, description, fingerprint, source_runner_id, imported_at
      FROM skill_library WHERE name = ? COLLATE NOCASE
    `).get(name) as LibraryRow | undefined ?? null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
