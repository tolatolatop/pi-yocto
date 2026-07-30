import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { pathExists, readJson, sha256 } from "./fs-utils.js";
import type { InputManifestEntry, ProjectContract } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

function within(path: string, root: string): boolean {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}/`);
}

export function workspaceIdentity(located: LocatedConfig): string {
  return sha256(`${resolve(located.rootDir)}\0${resolve(located.configPath)}`);
}

function assertContract(contract: ProjectContract, path: string): void {
  if (contract.schemaVersion !== SCHEMA_VERSION || !contract.id?.trim()) throw new Error(`Invalid project contract identity: ${path}`);
  if (!Array.isArray(contract.requirements) || !contract.requirements.length) throw new Error(`Project contract requires verification requirements: ${path}`);
  const requirementIds = new Set<string>();
  for (const requirement of contract.requirements) {
    if (!requirement.id?.trim() || requirementIds.has(requirement.id)) throw new Error(`Project contract requirement IDs must be unique: ${requirement.id}`);
    requirementIds.add(requirement.id);
  }
  const jobIds = new Set<string>();
  for (const job of contract.completion?.requiredJobs ?? []) {
    if (!job.id?.trim() || jobIds.has(job.id)) throw new Error(`Project contract job IDs must be unique: ${job.id}`);
    jobIds.add(job.id);
    if ((job.minCount ?? 1) < 1) throw new Error(`Project contract job ${job.id} has an invalid minCount`);
  }
  const inputIds = new Set<string>();
  for (const input of contract.inputs ?? []) {
    if (!input.id?.trim() || inputIds.has(input.id)) throw new Error(`Project contract input IDs must be unique: ${input.id}`);
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error(`Project contract input ${input.id} has an invalid SHA-256`);
    if (input.usage === "copy" && !input.destinationSuffix) throw new Error(`Copy input ${input.id} requires destinationSuffix`);
    inputIds.add(input.id);
  }
}

export async function loadProjectContract(located: LocatedConfig): Promise<ProjectContract | undefined> {
  const path = join(located.rootDir, ".pi", "yocto-contract.json");
  if (!(await pathExists(path))) return undefined;
  const raw = await readJson<ProjectContract>(path);
  assertContract(raw, path);
  const inputs: InputManifestEntry[] = [];
  for (const input of raw.inputs ?? []) {
    const absolute = resolve(located.rootDir, input.path);
    if (!within(absolute, located.rootDir)) throw new Error(`Project contract input escapes the workspace: ${input.path}`);
    const content = await readFile(absolute).catch(() => undefined);
    if (!content) throw new Error(`Project contract input is missing: ${absolute}`);
    const actual = sha256(content);
    if (actual !== input.sha256) throw new Error(`Project contract input checksum mismatch for ${input.id}: expected ${input.sha256}, got ${actual}`);
    inputs.push({ ...input, path: absolute });
  }
  return { ...raw, inputs };
}
