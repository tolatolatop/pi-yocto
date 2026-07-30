import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { newId, pathExists, readJson, sha256, withFileLock, writeJsonAtomic } from "./fs-utils.js";
import { TaskStore } from "./state.js";
import type { ApprovalRequest } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export function normalizeCommand(command: string | string[]): string[] {
  if (Array.isArray(command)) return command.map((part) => part.trim()).filter(Boolean);
  return command.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
}

function approvalScopeHash(taskId: string, action: string, normalizedCommand: string[] | undefined, files: string[], changeSetId: string | undefined, changeSetScopeHash: string | undefined): string {
  return sha256(JSON.stringify({ taskId, action, normalizedCommand: normalizedCommand ?? null, files, changeSetId: changeSetId ?? null, changeSetScopeHash: changeSetScopeHash ?? null }));
}

function legacyApprovalScopeHash(request: ApprovalRequest): string {
  return sha256(JSON.stringify({ taskId: request.taskId, action: request.action, normalizedCommand: request.normalizedCommand ?? null, files: request.files, changeSetId: request.changeSetId ?? null }));
}

export class ApprovalStore {
  constructor(private readonly located: LocatedConfig) {}
  path(id: string): string { return join(this.located.stateDir, "approvals", `${id}.json`); }

  async create(input: {
    taskId: string;
    action: string;
    command?: string | string[];
    files?: string[];
    changeSetId?: string;
    changeSetScopeHash?: string;
    impact: string;
    estimatedDuration?: string;
    risk: string;
    recovery: string;
    ttlMinutes?: number;
  }): Promise<ApprovalRequest> {
    await new TaskStore(this.located).load(input.taskId);
    if (Boolean(input.changeSetId) !== Boolean(input.changeSetScopeHash)) throw new Error("ChangeSet approvals require both changeSetId and changeSetScopeHash");
    const now = new Date();
    const normalizedCommand = input.command ? normalizeCommand(input.command) : undefined;
    const files = [...new Set((input.files ?? []).map((file) => resolve(file)))].sort();
    const scopeHash = approvalScopeHash(input.taskId, input.action, normalizedCommand, files, input.changeSetId, input.changeSetScopeHash);
    const request: ApprovalRequest = {
      schemaVersion: SCHEMA_VERSION,
      id: newId("approval"),
      taskId: input.taskId,
      action: input.action,
      ...(normalizedCommand ? { normalizedCommand } : {}),
      files,
      scopeHash,
      ...(input.changeSetId ? { changeSetId: input.changeSetId } : {}),
      ...(input.changeSetScopeHash ? { changeSetScopeHash: input.changeSetScopeHash } : {}),
      impact: input.impact,
      ...(input.estimatedDuration ? { estimatedDuration: input.estimatedDuration } : {}),
      risk: input.risk,
      recovery: input.recovery,
      status: "PENDING",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlMinutes ?? 30) * 60_000).toISOString()
    };
    await writeJsonAtomic(this.path(request.id), request);
    await new TaskStore(this.located).attachApproval(input.taskId, request.id);
    return request;
  }

  async load(id: string): Promise<ApprovalRequest> {
    if (!(await pathExists(this.path(id)))) throw new Error(`Unknown approval ${id}`);
    const raw = await readJson<ApprovalRequest>(this.path(id));
    const expectedHash = approvalScopeHash(raw.taskId, raw.action, raw.normalizedCommand, raw.files, raw.changeSetId, raw.changeSetScopeHash);
    let approval: ApprovalRequest;
    if (!raw.scopeHash) approval = { ...raw, scopeHash: expectedHash };
    else if (raw.scopeHash === expectedHash) approval = raw;
    else if (!raw.changeSetScopeHash && raw.scopeHash === legacyApprovalScopeHash(raw)) approval = { ...raw, scopeHash: expectedHash };
    else throw new Error(`Approval ${id} scope integrity check failed`);
    if (approval.scopeHash !== raw.scopeHash) await writeJsonAtomic(this.path(id), approval);
    if (["PENDING", "APPROVED"].includes(approval.status) && Date.parse(approval.expiresAt) <= Date.now()) {
      const expired = { ...approval, status: "EXPIRED" as const };
      await writeJsonAtomic(this.path(id), expired);
      return expired;
    }
    return approval;
  }

  async decide(id: string, approved: boolean): Promise<ApprovalRequest> {
    const request = await this.load(id);
    if (request.status !== "PENDING") throw new Error(`Approval ${id} is ${request.status}`);
    const updated: ApprovalRequest = { ...request, status: approved ? "APPROVED" : "DENIED", decidedAt: new Date().toISOString() };
    await writeJsonAtomic(this.path(id), updated);
    return updated;
  }

  async consume(id: string, binding: { taskId: string; action: string; command?: string | string[]; files?: string[]; changeSetId?: string; changeSetScopeHash?: string }): Promise<ApprovalRequest> {
    return withFileLock(`${this.path(id)}.lock`, async () => {
      const request = await this.load(id);
      if (request.status !== "APPROVED") throw new Error(`Approval ${id} is not approved (${request.status})`);
      const expectedCommand = binding.command ? normalizeCommand(binding.command) : undefined;
      const expectedFiles = [...new Set((binding.files ?? []).map((file) => resolve(file)))].sort();
      if (request.taskId !== binding.taskId || request.action !== binding.action) throw new Error("Approval task/action binding mismatch");
      if (JSON.stringify(request.normalizedCommand ?? null) !== JSON.stringify(expectedCommand ?? null)) throw new Error("Approval command binding mismatch");
      if (JSON.stringify(request.files) !== JSON.stringify(expectedFiles)) throw new Error("Approval file scope mismatch");
      if ((request.changeSetId ?? null) !== (binding.changeSetId ?? null) || (request.changeSetScopeHash ?? null) !== (binding.changeSetScopeHash ?? null)) throw new Error("Approval ChangeSet binding mismatch");
      const consumed: ApprovalRequest = {
        ...request,
        status: "CONSUMED",
        consumedAt: new Date().toISOString(),
        consumption: { taskId: binding.taskId, action: binding.action, ...(expectedCommand ? { normalizedCommand: expectedCommand } : {}), files: expectedFiles, ...(binding.changeSetId ? { changeSetId: binding.changeSetId } : {}), ...(binding.changeSetScopeHash ? { changeSetScopeHash: binding.changeSetScopeHash } : {}) }
      };
      await writeJsonAtomic(this.path(id), consumed);
      return consumed;
    });
  }

  async list(): Promise<ApprovalRequest[]> {
    const dir = join(this.located.stateDir, "approvals");
    const names = await readdir(dir).catch(() => []);
    const values = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(dir, name), "utf8").then((value) => JSON.parse(value) as ApprovalRequest)));
    return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
