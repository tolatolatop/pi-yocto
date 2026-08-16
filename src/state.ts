import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { loadProjectContract, workspaceIdentity } from "./contracts.js";
import { newId, pathExists, readJson, sha256, withFileLock, writeJsonAtomic } from "./fs-utils.js";
import type { ChangeSetRecord, Checkpoint, Evidence, JobPurpose, JobRecord, JobSnapshot, JobStatus, RequiredJob, ReviewRecord, TaskPhase, TaskRecord, VerificationRequirement } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const transitions: Record<TaskPhase, TaskPhase[]> = {
  INTAKE: ["INSPECTING", "PAUSED", "FAILED"],
  INSPECTING: ["PLANNING", "PAUSED", "FAILED"],
  PLANNING: ["WAITING_HUMAN", "EXECUTING", "PAUSED", "FAILED"],
  REPLANNING: ["WAITING_HUMAN", "PAUSED", "FAILED"],
  WAITING_HUMAN: ["EXECUTING", "PAUSED", "FAILED"],
  EXECUTING: ["VERIFYING", "PAUSED", "FAILED"],
  VERIFYING: ["EXECUTING", "SUMMARIZING", "PAUSED", "FAILED"],
  SUMMARIZING: ["COMPLETED", "PAUSED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  PAUSED: ["INSPECTING", "PLANNING", "REPLANNING", "WAITING_HUMAN", "EXECUTING", "VERIFYING", "SUMMARIZING"]
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

function requiredJobMatches(job: JobRecord, requirement: RequiredJob): boolean {
  return job.purpose === requirement.purpose
    && (!requirement.kind || job.kind === requirement.kind)
    && (!requirement.target || jobTarget(job) === requirement.target);
}

function allowedRequiredJobStatuses(requirement: RequiredJob): JobStatus[] {
  return requirement.allowedStatuses ?? (requirement.purpose === "qemu" ? ["STOPPED"] : ["SUCCEEDED"]);
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
    const allowed = allowedRequiredJobStatuses(requirement);
    const matches = jobs.filter((job) => requiredJobMatches(job, requirement) && allowed.includes(job.status));
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
      .filter((job) => requiredJobMatches(job, requirement))
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

  async requiredJobStatus(id: string): Promise<{
    ready: boolean;
    missing: Array<{ id: string; kind: string; purpose: JobPurpose; target?: string; requiredCount: number; satisfiedCount: number; allowedStatuses: JobStatus[]; suggestedCall: Record<string, unknown> }>;
    satisfied: Array<{ id: string; jobIds: string[] }>;
  }> {
    const task = await this.load(id);
    const jobs = await loadTaskJobs(this.located, task);
    const missing: Array<{ id: string; kind: string; purpose: JobPurpose; target?: string; requiredCount: number; satisfiedCount: number; allowedStatuses: JobStatus[]; suggestedCall: Record<string, unknown> }> = [];
    const satisfied: Array<{ id: string; jobIds: string[] }> = [];
    const iteration = Math.max(1, task.currentFixIteration || 1);
    for (const requirement of task.completionPolicy?.requiredJobs ?? []) {
      const allowedStatuses = allowedRequiredJobStatuses(requirement);
      const matches = jobs.filter((job) => requiredJobMatches(job, requirement) && allowedStatuses.includes(job.status));
      const requiredCount = requirement.minCount ?? 1;
      if (matches.length >= requiredCount) {
        satisfied.push({ id: requirement.id, jobIds: matches.map((job) => job.id) });
        continue;
      }
      const kind = requirement.kind ?? (requirement.purpose === "qemu" ? "qemu" : requirement.purpose === "parse" ? "check" : "bitbake");
      const suggestedCall: Record<string, unknown> = {
        tool: "yocto_job_start",
        kind,
        purpose: requirement.purpose,
        args: requirement.purpose === "parse" ? ["-p"] : requirement.target ? [requirement.target] : []
      };
      if (["parse", "verification", "qemu"].includes(requirement.purpose)) suggestedCall.iteration = iteration;
      if (requirement.purpose === "qemu") {
        const source = [...jobs].reverse().find((job) => job.kind === "bitbake" && job.purpose === "verification" && job.status === "SUCCEEDED" && job.artifacts.some((artifact) => artifact.endsWith(".qemuboot.conf")));
        if (source) {
          suggestedCall.sourceJobId = source.id;
          suggestedCall.args = requirement.target ? [requirement.target] : [jobTarget(source)];
        } else suggestedCall.blockedBy = "a successful verification image job with a qemuboot.conf artifact";
      }
      missing.push({
        id: requirement.id,
        kind,
        purpose: requirement.purpose,
        ...(requirement.target ? { target: requirement.target } : {}),
        requiredCount,
        satisfiedCount: matches.length,
        allowedStatuses,
        suggestedCall
      });
    }
    return { ready: missing.length === 0, missing, satisfied };
  }

  async completionStatus(id: string): Promise<{ taskId: string; currentPhase: TaskPhase; ready: boolean; issues: string[]; allowedNextActions: string[] }> {
    const task = await this.load(id);
    const issues: string[] = [];
    if (!["VERIFYING", "SUMMARIZING"].includes(task.phase)) issues.push(`Finalization requires VERIFYING or SUMMARIZING; current phase is ${task.phase}`);
    const required = task.verificationContract?.requirements.filter((item) => item.required) ?? [];
    if (!task.verificationContract) issues.push("No verification contract is recorded");
    for (const requirement of required.filter((item) => item.status !== "PASSED")) issues.push(`Required verification ${requirement.id} is ${requirement.status}`);
    const latest = task.checkpoints.at(-1);
    const checkpoint = latest ? await hydrateCheckpoint(this.located, task, {
      objective: latest.objective,
      phase: task.phase,
      modifiedFiles: latest.modifiedFiles,
      evidenceIds: latest.evidenceIds,
      completedSteps: latest.completedSteps,
      pendingSteps: [],
      jobIds: task.jobIds,
      logOffsets: latest.logOffsets,
      ...(latest.resumeAction ? { resumeAction: latest.resumeAction } : {})
    }) : undefined;
    try { await assertCompletionPolicy(this.located, task, checkpoint); }
    catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    const jobs = await loadTaskJobs(this.located, task);
    const requiredJobs = await this.requiredJobStatus(id);
    const active = jobs.filter((job) => ["QUEUED", "RUNNING", "STOPPING"].includes(job.status));
    const failed = jobs.some((job) => job.status === "FAILED" && job.iteration === task.currentFixIteration && task.evidence.some((item) => item.jobId === job.id && (item.exitCode ?? 0) !== 0));
    const semanticFailure = task.verificationContract?.requirements.some((requirement) => requirement.status === "FAILED" && requirement.evidenceIds.some((evidenceId) => {
      const evidence = task.evidence.find((item) => item.id === evidenceId);
      return evidence?.provenance === "harness-tool" && Number.isInteger(evidence.exitCode) && evidence.exitCode !== 0;
    })) ?? false;
    const allowedNextActions: string[] = [];
    for (const job of active) {
      allowedNextActions.push(job.kind === "qemu"
        ? `stop-active-qemu:${JSON.stringify({ tool: "yocto_job_stop", id: job.id, taskId: task.id })}`
        : `monitor-active-job:${JSON.stringify({ tool: "yocto_job_status", id: job.id })}`);
    }
    if (required.some((item) => item.status !== "PASSED")) allowedNextActions.push("record-required-verification-results");
    for (const requirement of requiredJobs.missing) allowedNextActions.push(`run-required-job:${requirement.id}:${JSON.stringify(requirement.suggestedCall)}`);
    if ((failed || semanticFailure) && task.currentFixIteration < this.located.config.limits.maxFixIterations && !active.length) allowedNextActions.push("request-controlled-replan");
    if (!issues.length) allowedNextActions.push("finalize-task-atomically");
    return { taskId: id, currentPhase: task.phase, ready: issues.length === 0, issues: [...new Set(issues)], allowedNextActions };
  }

  async requestReplan(id: string, failedEvidenceId: string): Promise<TaskRecord> {
    return withFileLock(`${this.path(id)}.lock`, async () => {
      const task = await this.load(id);
      if (!["EXECUTING", "VERIFYING"].includes(task.phase)) throw new Error(`Controlled replanning requires EXECUTING/VERIFYING; currentPhase=${task.phase}; allowedNextActions=inspect-task-status`);
      if (task.currentFixIteration >= this.located.config.limits.maxFixIterations) throw new Error(`Fix iteration limit ${this.located.config.limits.maxFixIterations} is exhausted; currentPhase=${task.phase}; allowedNextActions=pause-or-fail-task`);
      const jobs = await loadTaskJobs(this.located, task);
      const active = jobs.filter((job) => ["QUEUED", "RUNNING", "STOPPING"].includes(job.status));
      if (active.length) throw new Error(`Cannot replan with active jobs: ${active.map((job) => `${job.id}:${job.status}`).join(", ")}; currentPhase=${task.phase}; allowedNextActions=monitor-or-stop-active-jobs`);
      const evidence = task.evidence.find((item) => item.id === failedEvidenceId);
      if (!evidence || !Number.isInteger(evidence.exitCode) || evidence.exitCode === 0) throw new Error(`Controlled replanning requires persisted non-zero current-run evidence; currentPhase=${task.phase}; allowedNextActions=record-failed-verification-evidence`);
      const evidenceJob = evidence.jobId ? jobs.find((job) => job.id === evidence.jobId) : undefined;
      const failedJobEvidence = evidenceJob?.status === "FAILED" && evidenceJob.iteration === task.currentFixIteration;
      const failedRequirement = task.verificationContract?.requirements.find((requirement) => requirement.status === "FAILED" && requirement.evidenceIds.includes(failedEvidenceId));
      const currentIterationJobs = jobs.filter((job) => job.iteration === task.currentFixIteration);
      const iterationStartedAt = currentIterationJobs.map((job) => Date.parse(job.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      const currentSemanticEvidence = Boolean(
        failedRequirement
        && evidence.provenance === "harness-tool"
        && ["execution", "behavior", "build", "configuration", "diagnosis"].includes(evidence.claimType)
        && currentIterationJobs.length
        && (evidenceJob ? evidenceJob.iteration === task.currentFixIteration : iterationStartedAt !== undefined && Date.parse(evidence.capturedAt) >= iterationStartedAt)
      );
      if (!failedJobEvidence && !currentSemanticEvidence) throw new Error(`Evidence ${failedEvidenceId} is neither a failed current verification Job nor trusted FAILED requirement evidence from the current iteration; currentPhase=${task.phase}; allowedNextActions=record-failed-verification-evidence`);
      const latest = task.checkpoints.at(-1);
      const checkpoint = await hydrateCheckpoint(this.located, task, {
        objective: task.objective,
        phase: "REPLANNING",
        modifiedFiles: latest?.modifiedFiles ?? [],
        evidenceIds: [...new Set([...(latest?.evidenceIds ?? []), failedEvidenceId])],
        completedSteps: [...new Set([...(latest?.completedSteps ?? []), `verification iteration ${task.currentFixIteration} failed with ${failedEvidenceId}`])],
        pendingSteps: ["prepare a revised ChangeSet", `run verification iteration ${task.currentFixIteration + 1}`],
        jobIds: task.jobIds,
        logOffsets: latest?.logOffsets ?? {},
        resumeAction: "Prepare one evidence-driven revised ChangeSet, obtain approval, apply it, then run the next verification iteration"
      });
      const next: TaskRecord = {
        ...task,
        phase: "REPLANNING",
        checkpoints: [...task.checkpoints, { ...checkpoint, createdAt: new Date().toISOString() }],
        updatedAt: new Date().toISOString()
      };
      await this.save(next);
      return next;
    });
  }

  async finalize(id: string, finalSummary: string): Promise<TaskRecord> {
    if (!finalSummary.trim()) throw new Error("Atomic finalization requires an auditable final summary");
    return withFileLock(`${this.path(id)}.lock`, async () => {
      const task = await this.load(id);
      if (!["VERIFYING", "SUMMARIZING"].includes(task.phase)) throw new Error(`Atomic finalization requires VERIFYING/SUMMARIZING; currentPhase=${task.phase}; allowedNextActions=complete-current-phase`);
      const required = task.verificationContract?.requirements.filter((item) => item.required) ?? [];
      if (!task.verificationContract || required.some((item) => item.status !== "PASSED")) throw new Error(`Task cannot finalize until every required verification item has PASSED evidence; currentPhase=${task.phase}; allowedNextActions=record-required-verification-results`);
      const latest = task.checkpoints.at(-1);
      const checkpoint = await hydrateCheckpoint(this.located, task, {
        objective: task.objective,
        phase: "COMPLETED",
        modifiedFiles: latest?.modifiedFiles ?? [],
        evidenceIds: [...new Set(task.evidence.map((item) => item.id))],
        completedSteps: [...new Set([...(latest?.completedSteps ?? []), "all required verification passed", "auditable summary finalized"])],
        pendingSteps: [],
        jobIds: task.jobIds,
        logOffsets: latest?.logOffsets ?? {}
      });
      await assertCompletionPolicy(this.located, task, checkpoint);
      const completed: TaskRecord = {
        ...task,
        phase: "COMPLETED",
        finalSummary: finalSummary.trim(),
        checkpoints: [...task.checkpoints, { ...checkpoint, createdAt: new Date().toISOString() }],
        updatedAt: new Date().toISOString()
      };
      await this.save(completed);
      return completed;
    });
  }

  async checkpoint(id: string, input: Omit<Checkpoint, "createdAt"> & { finalSummary?: string }, evidence: Evidence[] = []): Promise<TaskRecord> {
    return withFileLock(`${this.path(id)}.lock`, async () => {
      const task = await this.load(id);
      if (task.objective !== input.objective) throw new Error(`Checkpoint objective does not match task ${id}`);
      if (task.phase !== input.phase && !canTransition(task.phase, input.phase)) throw new Error(`Invalid task transition ${task.phase} -> ${input.phase}`);
      const workspaceId = task.workspaceId ?? workspaceIdentity(this.located);
      const boundEvidence = evidence.map((item) => ({ ...normalizeEvidence(item), workspaceId: item.workspaceId ?? workspaceId, provenance: "checkpoint" as const }));
      for (const item of boundEvidence) {
        assertEvidence(item);
        if (item.workspaceId !== workspaceId) throw new Error(`Evidence ${item.id} belongs to a different workspace/run`);
        if (isAbsolute(item.source) && item.source.includes("/.pi-yocto/validation/") && !within(item.source, this.located.rootDir)) {
          throw new Error(`Evidence ${item.id} references a different validation run: ${item.source}`);
        }
        if (item.jobId) {
          const path = join(this.located.stateDir, "jobs", `${item.jobId}.json`);
          if (!(await pathExists(path)) || (await readJson<JobRecord>(path)).taskId !== task.id) throw new Error(`Evidence ${item.id} job binding is not part of TaskRecord ${task.id}`);
        }
      }
      const known = new Set(task.evidence.map((item) => item.id));
      const appended = boundEvidence.filter((item) => !known.has(item.id));
      const { finalSummary, ...rawCheckpoint } = input;
      if (input.phase === "FAILED") {
        if (input.pendingSteps.length) throw new Error("Terminal FAILED cannot retain pending recovery steps; use PAUSED, or record trusted failed semantic Evidence and call yocto_task_replan");
        const allEvidence = [...task.evidence, ...appended];
        const repairableEvidence = task.verificationContract?.requirements.flatMap((requirement) => requirement.status === "FAILED"
          ? requirement.evidenceIds.filter((evidenceId) => {
            const item = allEvidence.find((candidate) => candidate.id === evidenceId);
            return item?.provenance === "harness-tool" && Number.isInteger(item.exitCode) && item.exitCode !== 0;
          })
          : [])[0];
        const failedAttempt = task.verificationAttempts.some((attempt) => attempt.iteration === task.currentFixIteration && attempt.status === "FAILED");
        if (task.currentFixIteration < this.located.config.limits.maxFixIterations && (repairableEvidence || failedAttempt)) {
          throw new Error(`Task has a remaining controlled repair iteration; call yocto_task_replan${repairableEvidence ? ` with failedEvidenceId=${repairableEvidence}` : " with current failed-job Evidence"} instead of terminal FAILED`);
        }
      }
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

  /**
   * Persist evidence produced by a trusted harness tool as soon as the tool has
   * finished.  Keeping this operation in TaskStore makes the task binding,
   * workspace binding, and de-duplication atomic; callers no longer have to ask
   * the model to copy an Evidence object through a later checkpoint call.
   */
  async recordEvidence(id: string, evidence: Evidence[]): Promise<TaskRecord> {
    return withFileLock(`${this.path(id)}.lock`, async () => {
      const task = await this.load(id);
      const workspaceId = task.workspaceId ?? workspaceIdentity(this.located);
      const boundEvidence = evidence.map((item) => ({ ...normalizeEvidence(item), workspaceId: item.workspaceId ?? workspaceId, provenance: "harness-tool" as const }));
      for (const item of boundEvidence) {
        assertEvidence(item);
        if (item.workspaceId !== workspaceId) throw new Error(`Evidence ${item.id} belongs to a different workspace/run`);
        if (isAbsolute(item.source) && item.source.includes("/.pi-yocto/validation/") && !within(item.source, this.located.rootDir)) {
          throw new Error(`Evidence ${item.id} references a different validation run: ${item.source}`);
        }
        if (item.jobId) {
          const path = join(this.located.stateDir, "jobs", `${item.jobId}.json`);
          if (!(await pathExists(path)) || (await readJson<JobRecord>(path)).taskId !== task.id) throw new Error(`Evidence ${item.id} job binding is not part of TaskRecord ${task.id}`);
        }
      }
      const known = new Set(task.evidence.map((item) => item.id));
      const appended = boundEvidence.filter((item) => !known.has(item.id));
      if (!appended.length && task.workspaceId) return task;
      const next: TaskRecord = {
        ...task,
        workspaceId,
        evidence: [...task.evidence, ...appended],
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
      const normalized = evidence.map((item) => ({ ...normalizeEvidence(item), workspaceId: item.workspaceId ?? workspaceId, provenance: "harness-tool" as const }));
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

  async reserveJob(id: string, input: { jobId: string; purpose: JobPurpose; fingerprint: string; inputFingerprint?: string; target: string; iteration?: number }): Promise<TaskRecord> {
    return this.mutate(id, (task) => {
      const allowedPhases = input.purpose === "baseline" || input.purpose === "diagnostic"
        ? ["INSPECTING", "PLANNING", "EXECUTING", "VERIFYING"]
        : ["EXECUTING", "VERIFYING"];
      if (!task.checkpoints.length || !allowedPhases.includes(task.phase)) {
        throw new Error(input.purpose === "baseline" || input.purpose === "diagnostic"
          ? `Task ${id} must checkpoint into INSPECTING/PLANNING before a ${input.purpose} job (legacy EXECUTING/VERIFYING is also accepted)`
          : `Task ${id} must checkpoint into EXECUTING/VERIFYING before starting a ${input.purpose} job`);
      }
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
        const previous = attempts.filter((attempt) => attempt.target === input.target).sort((a, b) => b.iteration - a.iteration)[0];
        if (previous && previous.status === "FAILED" && previous.inputFingerprint && previous.inputFingerprint === input.inputFingerprint) {
          throw new Error(`Verification input is unchanged since failed job ${previous.jobId}; currentPhase=${task.phase}; allowedNextActions=prepare-and-apply-a-revised-ChangeSet`);
        }
        attempts.push({ iteration: input.iteration, jobId: input.jobId, fingerprint: input.fingerprint, ...(input.inputFingerprint ? { inputFingerprint: input.inputFingerprint } : {}), target: input.target, status: "QUEUED", createdAt: new Date().toISOString() });
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
      if (status === "PASSED" && requirement.expectedEvidenceSource && evidence.some((item) => item.source !== requirement.expectedEvidenceSource || item.provenance !== "harness-tool")) {
        throw new Error(`Verification ${requirementId} requires trusted evidence from ${requirement.expectedEvidenceSource}`);
      }
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
