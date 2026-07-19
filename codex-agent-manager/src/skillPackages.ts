import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_SKILL_FILES = 500;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;

export type SkillPackageFile = {
  path: string;
  content: string;
};

export type SkillPackage = {
  version: 1;
  name: string;
  description: string;
  fingerprint: string;
  files: SkillPackageFile[];
};

export function codexUserSkillsDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment.CODEX_HOME?.trim() || join(homedir(), ".codex"), "skills");
}

export function isPortableUserSkill(
  skill: { name: string; path: string },
  options: { skillsDirectory?: string } = {},
): boolean {
  if (!isValidSkillName(skill.name)) return false;
  const skillsDirectory = resolve(options.skillsDirectory ?? codexUserSkillsDirectory());
  const skillFile = resolve(skill.path);
  const skillDirectory = dirname(skillFile);
  return skillDirectory !== skillsDirectory
    && skillFile === join(skillDirectory, "SKILL.md")
    && pathIsInside(skillsDirectory, skillDirectory);
}

export async function exportUserSkill(
  skillPath: string,
  options: { name: string; description?: string; skillsDirectory?: string },
): Promise<SkillPackage> {
  validateSkillName(options.name);
  const skillsDirectory = await realpath(resolve(options.skillsDirectory ?? codexUserSkillsDirectory()));
  const skillDirectory = await realpath(resolve(dirname(skillPath)));
  assertInside(skillsDirectory, skillDirectory);
  const skillFile = await realpath(resolve(skillPath));
  if (skillFile !== join(skillDirectory, "SKILL.md")) {
    throw new Error("A skill package must be imported from its root SKILL.md file.");
  }

  const files: SkillPackageFile[] = [];
  let totalBytes = 0;
  await walk(skillDirectory, "");
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new Error(`Skill ${options.name} does not contain SKILL.md.`);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return packageWithFingerprint({
    version: 1,
    name: options.name,
    description: options.description?.trim() || "",
    files,
  });

  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      validatePackagePath(relativePath);
      const fullPath = join(directory, entry.name);
      const metadata = await lstat(fullPath);
      if (metadata.isSymbolicLink()) throw new Error(`Skill packages cannot contain symbolic links: ${relativePath}`);
      if (metadata.isDirectory()) {
        await walk(fullPath, relativePath);
        continue;
      }
      if (!metadata.isFile()) throw new Error(`Unsupported skill entry: ${relativePath}`);
      const content = await readFile(fullPath);
      totalBytes += content.byteLength;
      if (files.length + 1 > MAX_SKILL_FILES) throw new Error(`Skill exceeds ${MAX_SKILL_FILES} files.`);
      if (totalBytes > MAX_SKILL_BYTES) throw new Error("Skill exceeds the 5 MB package limit.");
      files.push({ path: relativePath, content: content.toString("base64") });
    }
  }
}

export async function installUserSkill(
  value: unknown,
  options: { skillsDirectory?: string; overwrite?: boolean } = {},
): Promise<{ path: string; fingerprint: string }> {
  const skill = validateSkillPackage(value);
  const skillsDirectory = resolve(options.skillsDirectory ?? codexUserSkillsDirectory());
  const target = join(skillsDirectory, skill.name);
  await mkdir(skillsDirectory, { recursive: true });
  if (!options.overwrite && await exists(target)) {
    throw new Error(`Skill ${skill.name} is already installed on this machine.`);
  }
  const temporary = join(skillsDirectory, `.${skill.name}.${randomUUID()}.tmp`);
  try {
    for (const file of skill.files) {
      const destination = join(temporary, ...file.path.split("/"));
      assertInside(temporary, destination);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.content, "base64"));
    }
    if (options.overwrite) await rm(target, { recursive: true, force: true });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { path: join(target, "SKILL.md"), fingerprint: skill.fingerprint };
}

export function validateSkillPackage(value: unknown): SkillPackage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid skill package.");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.name !== "string" || typeof record.description !== "string") {
    throw new Error("Invalid skill package metadata.");
  }
  validateSkillName(record.name);
  if (!Array.isArray(record.files)) throw new Error("Invalid skill package files.");
  if (record.files.length > MAX_SKILL_FILES) throw new Error(`Skill exceeds ${MAX_SKILL_FILES} files.`);
  let totalBytes = 0;
  const seen = new Set<string>();
  const files = record.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid skill package file.");
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.content !== "string") throw new Error("Invalid skill package file.");
    validatePackagePath(file.path);
    if (seen.has(file.path)) throw new Error(`Duplicate skill package path: ${file.path}`);
    seen.add(file.path);
    const content = decodeBase64(file.content);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_SKILL_BYTES) throw new Error("Skill exceeds the 5 MB package limit.");
    return { path: file.path, content: file.content };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!seen.has("SKILL.md")) throw new Error("Skill package is missing SKILL.md.");
  const normalized = packageWithFingerprint({
    version: 1,
    name: record.name,
    description: record.description,
    files,
  });
  if (record.fingerprint !== normalized.fingerprint) throw new Error("Skill package fingerprint does not match its contents.");
  return normalized;
}

function packageWithFingerprint(value: Omit<SkillPackage, "fingerprint">): SkillPackage {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ version: value.version, name: value.name, files: value.files }))
    .digest("hex");
  return { ...value, fingerprint };
}

export function isValidSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name);
}

function validateSkillName(name: string): void {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
}

function validatePackagePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe skill package path: ${path}`);
  }
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid base64 content in skill package.");
  }
  return Buffer.from(value, "base64");
}

function assertInside(parent: string, child: string): void {
  if (pathIsInside(parent, child)) return;
  throw new Error("Skill path is outside the allowed user skills directory.");
}

function pathIsInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
