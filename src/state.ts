import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { loadProjectContract, workspaceIdentity } from "./contracts.js";
import { newId, pathExists, readJson, sha256, withFileLock, writeJsonAtomic } from "./fs-utils.js";
import type { ChangeSetRecord, Checkpoint, Evidence, JobPurpose, JobRecord, JobSnapshot, JobStatus, ReviewRecord, TaskPhase, TaskRecord, VerificationRequirement } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const transitions: Record<TaskPhase, TaskPhase[]> = {
  INTAKE: ["INSPECTING", "PAUSED", "FAILED"],
  INSPECTING: ["PLANNING", "PAUSED", "FAILED"],
  PLANNING: ["WAITING_HUMAN", "EXECUTING", "PAUSED", "FAILED"],
  WAITING_HUMAN: ["EXECUTING", "PAUSED", "FAILED"],
  EXECUTING: ["VERIFYING", "PAUSED", "FAILED"],
  VERIFYING: ["EXECUTING", "SUMMARIZING", "PAUSED", "FAILED"],
  SUMMARIZING: ["COMPLETED", "PAUSED", "FAILED"],
  COMPLETED: [],
  FAILED: ["INSPECTING", "PLANNING", "EXECUTING", "VERIFYING", "PAUSED"],
  PAUSED: ["INSPECTING", "PLANNING", "WAITING_HUMAN", "EXECUTING", "VERIFYING", "SUMMARIZING"]
};

export function canTransition(from: TaskPhase, to: TaskPhase): boolean {
  return transitions[from].includes(to);
}

export function transitionTask(task: TaskRecord, phase: TaskPhase): TaskRecord {
  if (task.phase === phase) return task;
  if (!canTransition(task.phase, phase)) throw new Error(`Invalid task transition ${task.phase} -> ${phase}`);
  if (phase === "COMPLETED") {
    const required = task.verificationContract?.requirements.filter((item) => item.required) ?? [];
    if (!task.verificationContract || required.some((item) => item.status !== "PASSED")) throw new Error("Task cannot complete until every required verification item has PASSED evidence");
    if (!task.finalSummary?.trim()) throw new Error("Task cannot complete without an auditable final summary");
  }
  return { ...task, phase, updatedAt: new Date().toISOString() };
}

function normalizeEvidence(evidence: Evidence): Evidence {
  if (evidence.executionDomain && evidence.claimType) return evidence;
  const executionDomain: Evidence["executionDomain"] = evidence.kind === "metadata" ? "metadata"
    : evidence.kind === "documentation" || evidence.kind === "case" ? "documentation"
      : evidence.kind === "source" ? "source"
        : evidence.kind === "log" ? "build" : "host";
  return { ...evidence, executionDomain, claimType: evidence.kind === "log" ? "diagnosis" : "observation" };
}

function normalizeTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    checkpoints: (task.checkpoints ?? []).map((checkpoint) => ({
      ...checkpoint,
      jobIds: checkpoint.jobIds ?? [],
      logOffsets: checkpoint.logOffsets ?? {},
      jobSnapshots: checkpoint.jobSnapshots ?? {}
    })),
    evidence: (task.evidence ?? []).map(normalizeEvidence),
    jobIds: task.jobIds ?? [],
    approvalIds: task.approvalIds ?? [],
    changeSetIds: task.changeSetIds ?? [],
    currentFixIteration: task.currentFixIteration ?? 0,
    verificationAttempts: task.verificationAttempts ?? [],
    reviews: task.reviews ?? []
  };
}

export function assertEvidence(evidence: Evidence): void {
  if (!evidence.id || !evidence.source || !evidence.fact || !evidence.capturedAt) throw new Error("Evidence is missing an identity, source, fact, or timestamp");
  if (!evidence.executionDomain || !evidence.claimType) throw new Error(`Evidence ${evidence.id} must declare executionDomain and claimType`);
  if (["build", "execution", "behavior"].includes(evidence.claimType)) {
    if (!evidence.command?.length || !Number.isInteger(evidence.exitCode)) throw new Error(`Build/behavior/execution evidence ${evidence.id} requires command and exitCode`);
  }
  if (evidence.executionDomain === "guest") {
    if (!evidence.jobId || !evidence.command?.length || !Number.isInteger(evidence.exitCode)) throw new Error(`Guest evidence ${evidence.id} requires jobId, command, and exitCode`);
  }
}

function within(path: string, root: string): boolean {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}/`);
}

function jobTarget(job: JobRecord): string {
  return job.args.filter((argument) => !argument.startsWith("-")).join(" ");
}

async function loadTaskJobs(located: LocatedConfig, task: TaskRecord): Promise<JobRecord[]> {
  const jobs: JobRecord[] = [];
  for (const id of task.jobIds) {
    const path = join(located.stateDir, "jobs", `${id}.json`);
    if (await pathExists(path)) jobs.push(await readJson<JobRecord>(path));
  }
  return jobs;
}

async function captureJobSnapshot(located: LocatedConfig, job: JobRecord): Promise<JobSnapshot> {
  const fileSize = await stat(job.logPath).then((info) => info.size).catch(() => 0);
  return {
    jobId: job.id,
    status: job.status,
    logOffset: Math.max(job.logOffset, fileSize),
    ...(job.pid !== undefined ? { pid: job.pid } : {}),
    ...(job.processGroupId !== undefined ? { processGroupId: job.processGroupId } : {}),
    ...(job.processStartTicks ? { processStartTicks: job.processStartTicks } : {}),
    ...(job.bootId ? { bootId: job.bootId } : {}),
    ...(job.heartbeatAt ? { heartbeatAt: job.heartbeatAt } : {}),
    capturedAt: new Date().toISOString()
  };
}

async function hydrateCheckpoint(located: LocatedConfig, task: TaskRecord, input: Omit<Checkpoint, "createdAt">): Promise<Omit<Checkpoint, "createdAt">> {
  const jobIds = [...new Set(input.jobIds.length ? input.jobIds : task.jobIds)];
  const snapshots: Record<string, JobSnapshot> = {};
  const offsets = { ...input.logOffsets };
  for (const id of jobIds) {
    const path = join(located.stateDir, "jobs", `${id}.json`);
    if (!(await pathExists(path))) continue;
    const job = await readJson<JobRecord>(path);
    if (job.taskId !== task.id) throw new Error(`Checkpoint job ${id} belongs to a different TaskRecord`);
    const snapshot = await captureJobSnapshot(located, job);
    snapshots[id] = snapshot;
    offsets[id] = snapshot.logOffset;
  }
  const resumable = [...jobIds].reverse().find((id) => snapshots[id]);
  return {
    ...input,
    jobIds,
    logOffsets: offsets,
    jobSnapshots: snapshots,
    ...(resumable ? { resumeAction: `pi-yocto job status ${resumable}; pi-yocto job logs ${resumable} --offset ${offsets[resumable] ?? 0}` } : input.resumeAction ? { resumeAction: input.resumeAction } : {})
  };
}

async function countTaskSessions(located: LocatedConfig, taskId: string): Promise<number> {
  const directory = join(located.stateDir, "sessions");
  const names = await readdir(directory).catch(() => []);
  let count = 0;
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const binding = await readJson<{ taskId?: string }>(join(directory, name)).catch((): { taskId?: string } => ({}));
    if (binding.taskId === taskId) count += 1;
  }
  return count;
}

async function assertCompletionPolicy(located: LocatedConfig, task: TaskRecord, checkpoint?: Omit<Checkpoint, "createdAt"> | Checkpoint): Promise<void> {
  const policy = task.completionPolicy;
  if (!policy) return;
  const jobs = await loadTaskJobs(located, task);
  for (const requirement of policy.requiredJobs ?? []) {
    const allowed = requirement.allowedStatuses ?? (requirement.purpose === "qemu" ? ["STOPPED"] : ["SUCCEEDED"]);
    const matches = jobs.filter((job) =>
      job.purpose === requirement.purpose
      && (!requirement.kind || job.kind === requirement.kind)
      && (!requirement.target || jobTarget(job) === requirement.target)
      && allowed.includes(job.status));
    if (matches.length < (requirement.minCount ?? 1)) throw new Error(`Completion policy requires ${requirement.id}: ${requirement.purpose} ${requirement.target ?? "*"} in ${allowed.join("/")}`);
  }
  if (policy.requireNoActiveJobs) {
    const active = jobs.filter((job) => ["QUEUED", "RUNNING", "STOPPING"].includes(job.status));
    if (active.length) throw new Error(`Task cannot complete with active jobs: ${active.map((job) => `${job.id}:${job.status}`).join(", ")}`);
  }
  if (policy.requireReview && !(task.reviews ?? []).some((review) => review.passed)) throw new Error("Completion policy requires a persisted passing yocto_review result");
  if (policy.requireNonzeroLogOffsets) {
    const missing = jobs.filter((job) => job.status !== "INTERRUPTED" && (checkpoint?.logOffsets[job.id] ?? 0) <= 0);
    if (missing.length) throw new Error(`Completion policy requires non-zero checkpoint log offsets: ${missing.map((job) => job.id).join(", ")}`);
  }
  if (policy.requireJobIdentitySnapshots) {
    const snapshots = checkpoint?.jobSnapshots ?? {};
    const requiredIds = new Set((policy.requiredJobs ?? []).flatMap((requirement) => jobs
      .filter((job) => job.purpose === requirement.purpose && (!requirement.kind || job.kind === requirement.kind) && (!requirement.target || jobTarget(job) === requirement.target))
      .map((job) => job.id)));
    const missing = [...requiredIds].filter((id) => {
      const snapshot = snapshots[id];
      return !snapshot?.pid || !snapshot.processGroupId || !snapshot.processStartTicks || !snapshot.bootId || !snapshot.heartbeatAt;
    });
    if (missing.length) throw new Error(`Completion policy requires PID/PGID/start-ticks/boot-id/heartbeat snapshots: ${missing.join(", ")}`);
  }
  if (policy.requireDecisionAnalysis) {
    const changesDir = join(located.stateDir, "changes");
    const names = await readdir(changesDir).catch(() => []);
    const changes = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson<ChangeSetRecord>(join(changesDir, name))));
    if (!changes.some((change) => change.taskId === task.id && change.status === "APPLIED" && change.decisionAnalysis && change.decisionAnalysis.options.length >= 2)) {
      throw new Error("Completion policy requires an applied ChangeSet with a persisted multi-option decision analysis");
    }
  }
  const requiredInputs = (task.inputManifest ?? []).filter((input) => input.required && input.usage === "copy");
  if (requiredInputs.length) {
    const changesDir = join(located.stateDir, "changes");
    const names = await readdir(changesDir).catch(() => []);
    const changes = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson<ChangeSetRecord>(join(changesDir, name))));
    const consumed = new Set(changes.filter((change) => change.taskId === task.id && change.status === "APPLIED").flatMap((change) => change.inputIds ?? []));
    const missing = requiredInputs.filter((input) => !consumed.has(input.id));
    if (missing.length) throw new Error(`Completion policy requires fixed inputs to be consumed: ${missing.map((input) => input.id).join(", ")}`);
  }
  if ((policy.minimumSessionBindings ?? 0) > 0 && await countTaskSessions(located, task.id) < (policy.minimumSessionBindings ?? 0)) {
    throw new Error(`Completion policy requires at least ${policy.minimumSessionBindings} distinct Pi session bindings`);
  }
}

export class TaskStore {
  constructor(private readonly located: LocatedConfig) {}

  path(id: string): string { return join(this.located.stateDir, "tasks", `${id}.json`); }

  async create(objective: string, plan: string[] = []): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const projectContract = await loadProjectContract(this.located);
    const record: TaskRecord = {
      schemaVersion: SCHEMA_VERSION,
      id: newId("task"),
      workspaceId: workspaceIdentity(this.located),
      ...(projectContract ? { contractId: projectContract.id } : {}),
      objective,
      phase: "INTAKE",
      plan,
      checkpoints: [],
      evidence: [],
      jobIds: [],
      approvalIds: [],
      changeSetIds: [],
      currentFixIteration: 0,
      verificationAttempts: [],
      ...(projectContract ? {
        verificationContract: {
          createdAt: now,
          requirements: projectContract.requirements.map((item) => ({ ...item, status: "PENDING", evidenceIds: [] }))
        },
        completionPolicy: projectContract.completion,
        inputManifest: projectContract.inputs ?? []
      } : {}),
      reviews: [],
      createdAt: now,
      updatedAt: now
    };
    await this.save(record);
    return record;
  }

  async load(id: string): Promise<TaskRecord> {
    const path = this.path(id);
    if (!(await pathExists(path))) throw new Error(`Unknown task ${id}`);
    return normalizeTask(await readJson<TaskRecord>(path));
  }

  async save(task: TaskRecord): Promise<void> { await writeJsonAtomic(this.path(task.id), task); }

  async transition(id: string, phase: TaskPhase): Promise<TaskRecord> {
    const current = await this.load(id);
    if (phase === "COMPLETED") await assertCompletionPolicy(this.located, current, current.checkpoints.at(-1));
    const task = transitionTask(current, phase);
    await this.save(task);
    return task;
  }

  async checkpoint(id: string, input: Omit<Checkpoint, "createdAt"> & { finalSummary?: string }, evidence: Evidence[] = []): Promise<TaskRecord> {
    return withFileLock(`${this.path(id)}.lock`, async () => {
      const task = await this.load(id);
      if (task.objective !== input.objective) throw new Error(`Checkpoint objective does not match task ${id}`);
      if (task.phase !== input.phase && !canTransition(task.phase, input.phase)) throw new Error(`Invalid task transition ${task.phase} -> ${input.phase}`);
      const workspaceId = task.workspaceId ?? workspaceIdentity(this.located);
      const boundEvidence = evidence.map((item) => ({ ...normalizeEvidence(item), workspaceId: item.workspaceId ?? workspaceId }));
      for (const item of boundEvidence) {
        if (item.workspaceId !== workspaceId) throw new Error(`Evidence ${item.id} belongs to a different workspace/run`);
        if (isAbsolute(item.source) && item.source.includes("/.pi-yocto/validation/") && !within(item.source, this.located.rootDir)) {
          throw new Error(`Evidence ${item.id} references a different validation run: ${item.source}`);
        }
        if (item.jobId) {
          const path = join(this.located.stateDir, "jobs", `${item.jobId}.json`);
          if (!(await pathExists(path)) || (await readJson<JobRecord>(path)).taskId !== task.id) throw new Error(`Evidence ${item.id} job binding is not part of TaskRecord ${task.id}`);
        }
        assertEvidence(item);
      }
      const known = new Set(task.evidence.map((item) => item.id));
      const appended = boundEvidence.filter((item) => !known.has(item.id));
      const { finalSummary, ...rawCheckpoint } = input;
      const checkpoint = await hydrateCheckpoint(this.located, task, rawCheckpoint);
      if (input.phase === "COMPLETED") {
        const required = task.verificationContract?.requirements.filter((item) => item.required) ?? [];
        if (!task.verificationContract || required.some((item) => item.status !== "PASSED")) throw new Error("Task cannot complete until every required verification item has PASSED evidence");
        if (input.pendingSteps.length) throw new Error("Task cannot complete with pending steps");
        if (!input.finalSummary?.trim()) throw new Error("Task cannot complete without an auditable final summary");
        await assertCompletionPolicy(this.located, { ...task, workspaceId, evidence: [...task.evidence, ...appended] }, checkpoint);
      }
      const next: TaskRecord = {
        ...task,
        workspaceId,
        phase: input.phase,
        evidence: [...task.evidence, ...appended],
        checkpoints: [...task.checkpoints, { ...checkpoint, createdAt: new Date().toISOString() }],
        ...(finalSummary ? { finalSummary } : {}),
        updatedAt: new Date().toISOString()
      };
      await this.save(next);
      return next;
    });
  }

  async attachApproval(id: string, approvalId: string): Promise<TaskRecord> {
    return this.mutate(id, (task) => ({ ...task, approvalIds: [...new Set([...task.approvalIds, approvalId])] }));
  }

  async attachChangeSet(id: string, changeSetId: string): Promise<TaskRecord> {
    return this.mutate(id, (task) => ({ ...task, changeSetIds: [...new Set([...task.changeSetIds, changeSetId])] }));
  }

  async recordReview(id: string, review: Omit<ReviewRecord, "createdAt">, evidence: Evidence[]): Promise<TaskRecord> {
    return withFileLock(`${this.path(id)}.lock`, async () => {
      const task = await this.load(id);
      const workspaceId = task.workspaceId ?? workspaceIdentity(this.located);
      const normalized = evidence.map((item) => ({ ...normalizeEvidence(item), workspaceId: item.workspaceId ?? workspaceId }));
      for (const item of normalized) assertEvidence(item);
      const known = new Set(task.evidence.map((item) => item.id));
      const next: TaskRecord = {
        ...task,
        workspaceId,
        evidence: [...task.evidence, ...normalized.filter((item) => !known.has(item.id))],
        reviews: [...(task.reviews ?? []), { ...review, createdAt: new Date().toISOString() }],
        updatedAt: new Date().toISOString()
      };
      await this.save(next);
      return next;
    });
  }

  async refreshJobCheckpoint(id: string, jobId: string): Promise<TaskRecord> {
    return withFileLock(`${this.path(id)}.lock`, async () => {
      const task = await this.load(id);
      const latest = task.checkpoints.at(-1);
      if (!latest) throw new Error(`Task ${id} has no checkpoint to refresh`);
      const path = join(this.located.stateDir, "jobs", `${jobId}.json`);
      const job = await readJson<JobRecord>(path);
      if (job.taskId !== id) throw new Error(`Job ${jobId} belongs to a different TaskRecord`);
      const snapshot = await captureJobSnapshot(this.located, job);
      const checkpoints = [...task.checkpoints];
      checkpoints[checkpoints.length - 1] = {
        ...latest,
        jobIds: [...new Set([...latest.jobIds, jobId])],
        logOffsets: { ...latest.logOffsets, [jobId]: snapshot.logOffset },
        jobSnapshots: { ...(latest.jobSnapshots ?? {}), [jobId]: snapshot },
        resumeAction: `pi-yocto job status ${jobId}; pi-yocto job logs ${jobId} --offset ${snapshot.logOffset}`
      };
      const next = { ...task, checkpoints, updatedAt: new Date().toISOString() };
      await this.save(next);
      return next;
    });
  }

  async reserveJob(id: string, input: { jobId: string; purpose: JobPurpose; fingerprint: string; target: string; iteration?: number }): Promise<TaskRecord> {
    return this.mutate(id, (task) => {
      if (!task.checkpoints.length || !["EXECUTING", "VERIFYING"].includes(task.phase)) throw new Error(`Task ${id} must checkpoint into EXECUTING/VERIFYING before starting a job`);
      let currentFixIteration = task.currentFixIteration;
      const attempts = [...task.verificationAttempts];
      if (input.iteration !== undefined) {
        if (input.iteration < 1 || input.iteration > this.located.config.limits.maxFixIterations) throw new Error(`Verification iteration must be between 1 and ${this.located.config.limits.maxFixIterations}`);
        if (input.iteration > currentFixIteration + 1) throw new Error(`Verification iteration ${input.iteration} skips required iteration ${currentFixIteration + 1}`);
        if (input.iteration < currentFixIteration) throw new Error(`Verification iteration ${input.iteration} is older than current iteration ${currentFixIteration}`);
        currentFixIteration = Math.max(currentFixIteration, input.iteration);
      }
      if (input.purpose === "verification") {
        if (!input.iteration) throw new Error("Verification jobs require an iteration");
        const same = attempts.find((attempt) => attempt.target === input.target && attempt.iteration === input.iteration);
        if (same) throw new Error(`Verification job for ${input.target} is already recorded as ${same.jobId} for iteration ${input.iteration}`);
        attempts.push({ iteration: input.iteration, jobId: input.jobId, fingerprint: input.fingerprint, target: input.target, status: "QUEUED", createdAt: new Date().toISOString() });
      }
      const latest = task.checkpoints.at(-1);
      const jobIds = [...new Set([...task.jobIds, input.jobId])];
      const checkpoint: Checkpoint = {
        objective: task.objective,
        phase: task.phase,
        modifiedFiles: latest?.modifiedFiles ?? [],
        evidenceIds: latest?.evidenceIds ?? [],
        completedSteps: latest?.completedSteps ?? [],
        pendingSteps: [...new Set([...(latest?.pendingSteps ?? []), `monitor ${input.jobId}`])],
        jobIds,
        logOffsets: { ...(latest?.logOffsets ?? {}), [input.jobId]: 0 },
        resumeAction: `pi-yocto job status ${input.jobId}; pi-yocto job logs ${input.jobId} --offset 0`,
        createdAt: new Date().toISOString()
      };
      return { ...task, jobIds, currentFixIteration, verificationAttempts: attempts, checkpoints: [...task.checkpoints, checkpoint] };
    });
  }

  async updateJobStatus(id: string, jobId: string, status: JobStatus, completedAt?: string): Promise<TaskRecord> {
    return this.mutate(id, (task) => ({
      ...task,
      verificationAttempts: task.verificationAttempts.map((attempt) => attempt.jobId === jobId ? { ...attempt, status, ...(completedAt ? { completedAt } : {}) } : attempt)
    }));
  }

  async setVerificationContract(id: string, requirements: Array<Omit<VerificationRequirement, "status" | "evidenceIds">>): Promise<TaskRecord> {
    if (!requirements.length) throw new Error("Verification contract requires at least one item");
    const ids = new Set<string>();
    for (const item of requirements) {
      if (!item.id || ids.has(item.id)) throw new Error(`Verification requirement IDs must be unique: ${item.id}`);
      ids.add(item.id);
    }
    return this.mutate(id, (task) => {
      if (task.verificationContract) {
        const current = task.verificationContract.requirements.map(({ status: _status, evidenceIds: _evidenceIds, note: _note, updatedAt: _updatedAt, ...item }) => item);
        if (JSON.stringify(current) === JSON.stringify(requirements)) return task;
        if (task.contractId) throw new Error(`Verification contract ${task.contractId} is controller-defined and cannot be replaced`);
      }
      if (!["INTAKE", "INSPECTING", "PLANNING"].includes(task.phase)) throw new Error(`Verification contract is immutable after planning; task ${id} is ${task.phase}`);
      return { ...task, verificationContract: { createdAt: new Date().toISOString(), requirements: requirements.map((item) => ({ ...item, status: "PENDING", evidenceIds: [] })) } };
    });
  }

  async updateVerification(id: string, requirementId: string, status: "PASSED" | "FAILED" | "SKIPPED", evidenceIds: string[], note?: string): Promise<TaskRecord> {
    return this.mutate(id, (task) => {
      const contract = task.verificationContract;
      if (!contract) throw new Error(`Task ${id} has no verification contract`);
      const requirement = contract.requirements.find((item) => item.id === requirementId);
      if (!requirement) throw new Error(`Unknown verification requirement ${requirementId}`);
      if (requirement.required && status === "SKIPPED") throw new Error(`Required verification ${requirementId} cannot be skipped`);
      const evidence = evidenceIds.map((evidenceId) => task.evidence.find((item) => item.id === evidenceId) ?? (() => { throw new Error(`Unknown evidence ${evidenceId}`); })());
      if (status === "PASSED" && !evidence.length) throw new Error(`PASSED verification ${requirementId} requires evidence`);
      if (status === "PASSED" && requirement.expectedDomain && evidence.some((item) => item.executionDomain !== requirement.expectedDomain)) throw new Error(`Verification ${requirementId} requires ${requirement.expectedDomain} evidence`);
      if (status === "PASSED" && requirement.expectedClaimType && evidence.some((item) => item.claimType !== requirement.expectedClaimType)) throw new Error(`Verification ${requirementId} requires ${requirement.expectedClaimType} evidence`);
      if (status === "PASSED" && evidence.some((item) => ["execution", "behavior", "build"].includes(item.claimType) && item.exitCode !== 0)) throw new Error(`Verification ${requirementId} contains a non-zero exit code`);
      return {
        ...task,
        verificationContract: {
          ...contract,
          requirements: contract.requirements.map((item) => item.id === requirementId ? { ...item, status, evidenceIds, ...(note ? { note } : {}), updatedAt: new Date().toISOString() } : item)
        }
      };
    });
  }

  private async mutate(id: string, update: (task: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    return withFileLock(`${this.path(id)}.lock`, async () => {
      const task = await this.load(id);
      const next = { ...update(task), updatedAt: new Date().toISOString() };
      await this.save(next);
      return next;
    });
  }

  async list(): Promise<TaskRecord[]> {
    const dir = join(this.located.stateDir, "tasks");
    const names = await readdir(dir).catch(() => []);
    const tasks = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readFile(join(dir, name), "utf8").then((value) => normalizeTask(JSON.parse(value) as TaskRecord))));
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export class TaskContextStore {
  constructor(private readonly located: LocatedConfig) {}

  private path(sessionId: string): string { return join(this.located.stateDir, "sessions", `${sha256(sessionId).slice(0, 24)}.json`); }

  async bind(sessionId: string, taskId: string): Promise<{ sessionId: string; taskId: string; boundAt: string }> {
    await new TaskStore(this.located).load(taskId);
    return withFileLock(`${this.path(sessionId)}.lock`, async () => {
      if (await pathExists(this.path(sessionId))) {
        const existing = await readJson<{ sessionId: string; taskId: string; boundAt: string }>(this.path(sessionId));
        if (existing.taskId !== taskId) throw new Error(`Pi session is already bound to TaskRecord ${existing.taskId}`);
        return existing;
      }
      const context = { sessionId, taskId, boundAt: new Date().toISOString() };
      await writeJsonAtomic(this.path(sessionId), context);
      return context;
    });
  }

  async active(sessionId: string): Promise<string | undefined> {
    if (!(await pathExists(this.path(sessionId)))) return undefined;
    return (await readJson<{ taskId: string }>(this.path(sessionId))).taskId;
  }
}

export function exportTaskMarkdown(task: TaskRecord): string {
  const last = task.checkpoints.at(-1);
  const evidence = task.evidence.map((item) => `- [${item.confidence}] ${item.fact} — \`${item.source}${item.locator ? ` (${item.locator})` : ""}\``).join("\n");
  const verification = task.verificationContract?.requirements.map((item) => `- ${item.status} ${item.id}: ${item.description} (${item.evidenceIds.join(", ") || "no evidence"})`).join("\n") ?? "No verification contract recorded.";
  const snapshots = Object.values(last?.jobSnapshots ?? {}).map((snapshot) => `- ${snapshot.jobId}: ${snapshot.status}, pid=${snapshot.pid ?? "n/a"}, pgid=${snapshot.processGroupId ?? "n/a"}, startTicks=${snapshot.processStartTicks ?? "n/a"}, bootId=${snapshot.bootId ?? "n/a"}, heartbeat=${snapshot.heartbeatAt ?? "n/a"}, offset=${snapshot.logOffset}`).join("\n");
  const inputs = (task.inputManifest ?? []).map((input) => `- ${input.required ? "required" : "optional"} ${input.id}: ${input.path} (${input.sha256}, ${input.usage})`).join("\n");
  return `# ${task.id}\n\nObjective: ${task.objective}\n\nPhase: ${task.phase}\n\nWorkspace: ${task.workspaceId ?? "legacy"}\n\nContract: ${task.contractId ?? "agent-defined"}\n\nJobs: ${task.jobIds.join(", ") || "none"}\n\nApprovals: ${task.approvalIds.join(", ") || "none"}\n\n## Plan\n\n${task.plan.map((step) => `- ${step}`).join("\n") || "No plan recorded."}\n\n## Inputs\n\n${inputs || "No fixed inputs."}\n\n## Latest checkpoint\n\n${last ? `Completed: ${last.completedSteps.join(", ") || "none"}\n\nPending: ${last.pendingSteps.join(", ") || "none"}\n\nJobs: ${last.jobIds.join(", ") || "none"}\n\nResume: ${last.resumeAction ?? "not recorded"}\n\nIdentity snapshots:\n${snapshots || "none"}` : "No checkpoint recorded."}\n\n## Evidence\n\n${evidence || "No evidence recorded."}\n\n## Verification\n\n${verification}\n\n## Summary\n\n${task.finalSummary ?? "Not completed."}\n`;
}
