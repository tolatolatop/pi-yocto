import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { ApprovalStore } from "./approval.js";
import { newId, pathExists, readJson, sha256, withFileLock, writeJsonAtomic, writeTextAtomic } from "./fs-utils.js";
import { runCommand } from "./process.js";
import { TaskStore } from "./state.js";
import type { ChangeOperation, ChangeSetRecord, DecisionAnalysis } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export interface ProposedChange {
  kind: "write" | "rename";
  path: string;
  content?: string;
  destination?: string;
}

export function computeChangeSetScopeHash(operations: ChangeOperation[], inputIds: string[] = [], decisionAnalysis?: DecisionAnalysis): string {
  return sha256(JSON.stringify({
    operations: operations.map((operation) => operation.kind === "write"
      ? { kind: operation.kind, path: operation.path, beforeSha256: operation.beforeSha256 ?? null, afterSha256: operation.afterSha256 }
      : operation),
    inputIds: [...inputIds].sort(),
    decisionAnalysis: decisionAnalysis ?? null
  }));
}

function assertChangeSetIntegrity(record: ChangeSetRecord): void {
  if (computeChangeSetScopeHash(record.operations, record.inputIds ?? [], record.decisionAnalysis) !== record.scopeHash) throw new Error(`Change set ${record.id} content changed after preparation`);
  for (const operation of record.operations) {
    if (operation.kind === "write" && sha256(operation.content) !== operation.afterSha256) throw new Error(`Change set ${record.id} write content does not match its approved hash: ${operation.path}`);
  }
}

function within(path: string, root: string): boolean {
  const absoluteRoot = resolve(root);
  return path === absoluteRoot || path.startsWith(`${absoluteRoot}/`);
}

function validateChangePath(located: LocatedConfig, path: string): string {
  const absolute = resolve(path);
  const roots = [located.config.sourceDir, located.config.buildDir, ...located.config.layers];
  if (!roots.some((root) => within(absolute, root))) throw new Error(`Change path is outside the configured Poky workspace/layers: ${absolute}`);
  if (within(absolute, located.stateDir) || absolute.includes("/.git/")) throw new Error(`Change path is internal or Git metadata: ${absolute}`);
  return absolute;
}

async function validatePatch(content: string, path: string, baseDir?: string): Promise<ChangeSetRecord["preflight"]> {
  const results: ChangeSetRecord["preflight"] = [];
  if (!/^Upstream-Status:\s*\S+/m.test(content)) results.push({ kind: "metadata-review", path, passed: false, detail: "Patch is missing an Upstream-Status header" });
  else results.push({ kind: "metadata-review", path, passed: true, detail: "Patch has an Upstream-Status header" });
  const temporary = await mkdtemp(join(tmpdir(), "pi-yocto-patch-"));
  const patchPath = join(temporary, "candidate.patch");
  try {
    await writeTextAtomic(patchPath, content);
    const syntax = await runCommand("git", ["apply", "--numstat", patchPath], { cwd: baseDir ?? temporary, timeoutMs: 10_000 });
    results.push({ kind: "patch-syntax", path, passed: syntax.code === 0, detail: syntax.code === 0 ? syntax.stdout.trim() || "git apply parsed the patch" : (syntax.stderr || syntax.stdout).trim() });
    if (baseDir) {
      const applicability = await runCommand("git", ["apply", "--check", "--unsafe-paths", patchPath], { cwd: resolve(baseDir), timeoutMs: 10_000 });
      results.push({ kind: "patch-applicability", path, passed: applicability.code === 0, detail: applicability.code === 0 ? `Patch applies under ${resolve(baseDir)}` : (applicability.stderr || applicability.stdout).trim() });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return results;
}

function validateMetadata(content: string, path: string): ChangeSetRecord["preflight"] {
  const failures: string[] = [];
  if (content.includes("\0")) failures.push("contains NUL bytes");
  if (/^(?:<{7}|={7}|>{7})/m.test(content)) failures.push("contains merge conflict markers");
  if (extname(path) === ".bb" && !/^LICENSE\s*(?:\?|\+|:)?=/m.test(content)) failures.push("recipe does not declare LICENSE");
  return [{ kind: "metadata-review", path, passed: failures.length === 0, detail: failures.join("; ") || "Basic metadata preflight passed" }];
}

export class ChangeSetStore {
  constructor(private readonly located: LocatedConfig) {}
  path(id: string): string { return join(this.located.stateDir, "changes", `${id}.json`); }
  async load(id: string): Promise<ChangeSetRecord> {
    if (!(await pathExists(this.path(id)))) throw new Error(`Unknown change set ${id}`);
    return readJson<ChangeSetRecord>(this.path(id));
  }
  async save(record: ChangeSetRecord): Promise<void> { await writeJsonAtomic(this.path(record.id), record); }
  async list(): Promise<ChangeSetRecord[]> {
    const dir = join(this.located.stateDir, "changes");
    const names = await readdir(dir).catch(() => []);
    return Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson<ChangeSetRecord>(join(dir, name))));
  }
  async bindApproval(id: string, approvalId: string): Promise<ChangeSetRecord> {
    return withFileLock(`${this.path(id)}.lock`, async () => {
      const record = await this.load(id);
      if (record.status !== "PREPARED") throw new Error(`Change set ${id} is ${record.status}`);
      assertChangeSetIntegrity(record);
      const approval = await new ApprovalStore(this.located).load(approvalId);
      if (approval.status !== "APPROVED" || approval.taskId !== record.taskId || approval.changeSetId !== record.id || approval.changeSetScopeHash !== record.scopeHash) throw new Error(`Approval ${approvalId} is not bound to the exact ChangeSet content`);
      const updated: ChangeSetRecord = { ...record, status: "APPROVED", approvalId };
      await this.save(updated);
      return updated;
    });
  }
}

export async function prepareChangeSet(located: LocatedConfig, input: { taskId: string; objective: string; changes: ProposedChange[]; patchBaseDir?: string; decisionAnalysis?: DecisionAnalysis }): Promise<ChangeSetRecord> {
  if (!input.changes.length) throw new Error("A change set requires at least one operation");
  const task = await new TaskStore(located).load(input.taskId);
  if (!["PLANNING", "WAITING_HUMAN"].includes(task.phase)) throw new Error(`Task ${input.taskId} must be in PLANNING/WAITING_HUMAN before preparing a ChangeSet`);
  const operations: ChangeOperation[] = [];
  const preflight: ChangeSetRecord["preflight"] = [];
  const seen = new Set<string>();
  for (const proposed of input.changes) {
    const path = validateChangePath(located, proposed.path);
    if (seen.has(path)) throw new Error(`A path can only appear once in a change set: ${path}`);
    seen.add(path);
    if (proposed.kind === "write") {
      if (proposed.content === undefined) throw new Error(`Write operation requires content: ${path}`);
      const before = await readFile(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      operations.push({ kind: "write", path, content: proposed.content, ...(before ? { beforeSha256: sha256(before) } : {}), afterSha256: sha256(proposed.content) });
      if ([".patch", ".diff"].includes(extname(path))) preflight.push(...await validatePatch(proposed.content, path, input.patchBaseDir));
      else if ([".bb", ".bbappend", ".inc", ".conf", ".bbclass", ".cfg"].includes(extname(path))) preflight.push(...validateMetadata(proposed.content, path));
    } else {
      if (!proposed.destination) throw new Error(`Rename operation requires destination: ${path}`);
      const destination = validateChangePath(located, proposed.destination);
      if (seen.has(destination)) throw new Error(`A path can only appear once in a change set: ${destination}`);
      seen.add(destination);
      if (!(await pathExists(path))) throw new Error(`Rename source does not exist: ${path}`);
      if (await pathExists(destination)) throw new Error(`Rename destination already exists: ${destination}`);
      operations.push({ kind: "rename", path, destination, beforeSha256: sha256(await readFile(path)) });
    }
  }
  const blocking = preflight.filter((item) => !item.passed);
  if (blocking.length) throw new Error(`Change set preflight failed: ${blocking.map((item) => `${item.path}: ${item.detail}`).join("; ")}`);
  const files = [...new Set(operations.flatMap((operation) => operation.kind === "rename" ? [operation.path, operation.destination] : [operation.path]))].sort();
  const inputIds: string[] = [];
  for (const manifest of (task.inputManifest ?? []).filter((item) => item.required && item.usage === "copy")) {
    const expected = await readFile(manifest.path, "utf8");
    const match = operations.find((operation) => operation.kind === "write" && operation.path.endsWith(manifest.destinationSuffix ?? "") && operation.content === expected);
    if (!match) throw new Error(`Required fixed input ${manifest.id} must be copied byte-for-byte to *${manifest.destinationSuffix}`);
    inputIds.push(manifest.id);
  }
  if (task.completionPolicy?.requireDecisionAnalysis) {
    const analysis = input.decisionAnalysis;
    if (!analysis || analysis.options.length < 2) throw new Error("This task requires at least two persisted decision alternatives before preparing a ChangeSet");
    const ids = new Set(analysis.options.map((option) => option.id));
    if (ids.size !== analysis.options.length || !ids.has(analysis.selectedId)) throw new Error("Decision alternatives require unique IDs and a valid selectedId");
    const selected = analysis.options.find((option) => option.id === analysis.selectedId);
    const minimum = Math.min(...analysis.options.map((option) => option.impactScore));
    if (!selected || selected.impactScore !== minimum) throw new Error("Selected decision must have the lowest declared product impactScore");
    const selectedFiles = new Set(selected.files.map((file) => resolve(file)));
    if (files.some((file) => !selectedFiles.has(file))) throw new Error("Selected decision file set does not cover the proposed ChangeSet");
  }
  const scopeHash = computeChangeSetScopeHash(operations, inputIds, input.decisionAnalysis);
  const record: ChangeSetRecord = {
    schemaVersion: SCHEMA_VERSION, id: newId("change"), taskId: input.taskId, objective: input.objective, operations, files, scopeHash,
    ...(inputIds.length ? { inputIds } : {}), ...(input.decisionAnalysis ? { decisionAnalysis: input.decisionAnalysis } : {}),
    status: "PREPARED", preflight, createdAt: new Date().toISOString()
  };
  await new ChangeSetStore(located).save(record);
  await new TaskStore(located).attachChangeSet(input.taskId, record.id);
  return record;
}

export async function applyChangeSet(located: LocatedConfig, id: string): Promise<ChangeSetRecord> {
  const store = new ChangeSetStore(located);
  return withFileLock(join(located.stateDir, "change-apply.lock"), async () => {
    const record = await store.load(id);
    if (record.status !== "APPROVED" || !record.approvalId) throw new Error(`Change set ${id} is not approved`);
    const task = await new TaskStore(located).load(record.taskId);
    if (task.phase !== "EXECUTING") throw new Error(`Task ${record.taskId} must be in EXECUTING before applying a ChangeSet`);
    assertChangeSetIntegrity(record);
    for (const operation of record.operations) {
      if (operation.kind === "write") {
        const current = await readFile(operation.path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        const currentHash = current ? sha256(current) : undefined;
        if (currentHash !== operation.beforeSha256) throw new Error(`Pre-image changed since approval: ${operation.path}`);
      } else {
        if (sha256(await readFile(operation.path)) !== operation.beforeSha256 || await pathExists(operation.destination)) throw new Error(`Rename scope changed since approval: ${operation.path}`);
      }
    }
    await new ApprovalStore(located).consume(record.approvalId, { taskId: record.taskId, action: "apply_change_set", command: ["apply-change-set", record.id], files: record.files, changeSetId: record.id, changeSetScopeHash: record.scopeHash });
    const backups = new Map<string, string | undefined>();
    for (const operation of record.operations) {
      if (operation.kind === "write") backups.set(operation.path, await readFile(operation.path, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error)));
    }
    const applied: ChangeOperation[] = [];
    try {
      for (const operation of record.operations) {
        if (operation.kind === "write") await writeTextAtomic(operation.path, operation.content);
        else {
          await mkdir(dirname(operation.destination), { recursive: true });
          await rename(operation.path, operation.destination);
        }
        applied.push(operation);
      }
      const updated: ChangeSetRecord = { ...record, status: "APPLIED", appliedAt: new Date().toISOString() };
      await store.save(updated);
      return updated;
    } catch (error) {
      for (const operation of applied.reverse()) {
        if (operation.kind === "rename" && await pathExists(operation.destination)) await rename(operation.destination, operation.path).catch(() => undefined);
        if (operation.kind === "write") {
          const before = backups.get(operation.path);
          if (before === undefined) await unlink(operation.path).catch(() => undefined);
          else await writeTextAtomic(operation.path, before).catch(() => undefined);
        }
      }
      const failed: ChangeSetRecord = { ...record, status: "FAILED", error: error instanceof Error ? error.message : String(error) };
      await store.save(failed);
      throw error;
    }
  });
}
