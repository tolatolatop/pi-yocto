import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApprovalStore } from "./approval.js";
import { assertImageManifest } from "./artifact-assertion.js";
import { applyChangeSet, ChangeSetStore, prepareChangeSet } from "./changes.js";
import { findConfig, type LocatedConfig } from "./config.js";
import { guestAssertionArgv, guestAssertionEvidence, guestCommandEvidence, queueGuestCommand, waitForGuestCommand, type GuestAssertionInput } from "./guest.js";
import { jobEvidenceVariants, JobStore, reconcileJob, startJob, stopJob, tailJob } from "./jobs.js";
import { buildKnowledgeIndex, searchKnowledge } from "./knowledge.js";
import { analyzeLog } from "./log-analyzer.js";
import { queryMetadata, type MetadataAction } from "./metadata.js";
import { preflightFileMirror } from "./mirror.js";
import { inspectNativeCache } from "./native-cache.js";
import { assertTargetOptimization } from "./optimization.js";
import { classifyCommand, classifyFileWrite } from "./policy.js";
import { reviewYoctoFiles } from "./review.js";
import { TaskContextStore, TaskStore } from "./state.js";
import { captureTmuxPane, requireTmuxSession, sendTmuxKey, sendTmuxText, waitForTmuxOutput } from "./tmux.js";
import type { Evidence, JobKind, JobPurpose, TaskPhase } from "./types.js";
import { inspectWorkspace } from "./workspace.js";

const textResult = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: value });
const phaseSchema = Type.Union(["INTAKE", "INSPECTING", "PLANNING", "REPLANNING", "WAITING_HUMAN", "EXECUTING", "VERIFYING", "SUMMARIZING", "COMPLETED", "FAILED", "PAUSED"].map((phase) => Type.Literal(phase)));

async function locate(ctx: ExtensionContext): Promise<LocatedConfig> { return findConfig(ctx.cwd); }

function sessionId(ctx: ExtensionContext): string { return ctx.sessionManager.getSessionId(); }

async function requireActiveTask(located: LocatedConfig, ctx: ExtensionContext, requested?: string): Promise<string> {
  const active = await new TaskContextStore(located).active(sessionId(ctx));
  if (!active) throw new Error("No active Yocto task in this Pi session; call yocto_task_open first (pass taskId when resuming)");
  if (requested && requested !== active) throw new Error(`Task binding mismatch: active=${active}, requested=${requested}`);
  await new TaskStore(located).load(active);
  return active;
}

async function persistToolEvidence(located: LocatedConfig, ctx: ExtensionContext, evidence: Evidence[], options: { requireTask?: boolean; taskId?: string } = {}): Promise<string | undefined> {
  const taskId = options.taskId ?? await new TaskContextStore(located).active(sessionId(ctx));
  if (!taskId) {
    if (options.requireTask) throw new Error("Evidence-producing Yocto tools require an active task; call yocto_task_open first");
    return undefined;
  }
  if (options.taskId) await requireActiveTask(located, ctx, options.taskId);
  if (evidence.length) await new TaskStore(located).recordEvidence(taskId, evidence);
  return taskId;
}

async function promptApproval(located: LocatedConfig, ctx: ExtensionContext, input: {
  taskId: string; action: string; command?: string | string[]; files?: string[]; changeSetId?: string; changeSetScopeHash?: string; impact: string; risk: string; recovery: string; estimatedDuration?: string; ttlMinutes?: number;
}) {
  const store = new ApprovalStore(located);
  const request = await store.create(input);
  if (!ctx.hasUI) return request;
  const scope = request.normalizedCommand?.join(" ") ?? (request.files.join(", ") || request.action);
  const approved = await ctx.ui.confirm(`Yocto approval: ${request.action}`, `${scope}\n\nImpact: ${request.impact}\nRisk: ${request.risk}\nRecovery: ${request.recovery}\nExpires: ${request.expiresAt}`);
  return store.decide(request.id, approved);
}

async function consumeCommandApproval(located: LocatedConfig, taskId: string, action: string, command: string): Promise<boolean> {
  const store = new ApprovalStore(located);
  const normalized = command.trim().replace(/\s+/g, " ").split(" ");
  const approval = (await store.list()).find((candidate) => candidate.taskId === taskId && candidate.action === action && candidate.status === "APPROVED" && Date.parse(candidate.expiresAt) > Date.now() && JSON.stringify(candidate.normalizedCommand) === JSON.stringify(normalized) && candidate.files.length === 0);
  if (!approval) return false;
  await store.consume(approval.id, { taskId, action, command, files: [] });
  return true;
}

export default function piYoctoExtension(pi: ExtensionAPI): void {
  const announcedJobs = new Set<string>();

  pi.registerFlag?.("disable", { description: "Disable comma-separated tools (for example --disable bash)", type: "string" });
  pi.registerFlag?.("tmux-session", { description: "Bind yocto_tmux to one pre-created tmux session", type: "string" });

  const boundTmuxSession = (): string => {
    const value = pi.getFlag("tmux-session");
    if (typeof value !== "string" || !value.trim()) throw new Error("yocto_tmux requires --tmux-session <name>");
    return value.trim();
  };

  pi.registerTool({
    name: "yocto_tmux", label: "Operate bound tmux console",
    description: "Operate only the pre-created tmux session bound by --tmux-session. Use status/capture to inspect it, send to type literal console text, key for a small control-key allowlist, and wait to poll captured output. This replaces native bash when launched with --disable bash.",
    promptSnippet: "Operate the exact tmux console bound at agent launch: capture, send literal text, send an allowed key, or wait for output.",
    promptGuidelines: ["Use yocto_tmux only for the session bound by --tmux-session. Capture before sending, wait for a unique completion marker, and never assume a command completed from send alone."],
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Union(["status", "capture", "send", "key", "wait"].map((value) => Type.Literal(value))),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
      submit: Type.Optional(Type.Boolean()), key: Type.Optional(Type.Union(["C-c", "C-d", "Enter", "Escape", "Tab", "Up", "Down", "Left", "Right"].map((value) => Type.Literal(value)))),
      pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), regex: Type.Optional(Type.Boolean()), exactLine: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 300000 })), lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 }))
    }),
    async execute(_id, params, signal) {
      const session = boundTmuxSession();
      if (params.action === "status") { await requireTmuxSession(session, signal); return textResult(await captureTmuxPane(session, params.lines ?? 50, signal)); }
      if (params.action === "capture") return textResult(await captureTmuxPane(session, params.lines ?? 200, signal));
      if (params.action === "send") {
        if (!params.text) throw new Error("tmux send requires text");
        return textResult(await sendTmuxText(session, params.text, params.submit ?? true, signal));
      }
      if (params.action === "key") {
        if (!params.key) throw new Error("tmux key requires key");
        return textResult(await sendTmuxKey(session, params.key, signal));
      }
      if (!params.pattern) throw new Error("tmux wait requires pattern");
      return textResult(await waitForTmuxOutput(session, params.pattern, { ...(params.regex !== undefined ? { regex: params.regex } : {}), ...(params.exactLine !== undefined ? { exactLine: params.exactLine } : {}), ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}), ...(params.lines ? { lines: params.lines } : {}), ...(signal ? { signal } : {}) }));
    }
  });

  pi.registerTool({
    name: "yocto_task_open", label: "Open or resume Yocto task",
    description: "Create one persisted TaskRecord for this Pi session, or bind this session to an existing TaskRecord when resuming. Call once before approvals, changes, or jobs.",
    parameters: Type.Object({ taskId: Type.Optional(Type.String()), objective: Type.Optional(Type.String()), plan: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const tasks = new TaskStore(located); const contexts = new TaskContextStore(located); const active = await contexts.active(sessionId(ctx));
      if (active) {
        if (params.taskId && params.taskId !== active) throw new Error(`Pi session is already bound to TaskRecord ${active}`);
        const task = await tasks.load(active);
        if (!params.taskId && params.objective?.trim() && params.objective.trim() !== task.objective) throw new Error(`Pi session is already bound to TaskRecord ${active}; start a new Pi session for a different objective`);
        return textResult({ task, binding: await contexts.bind(sessionId(ctx), active) });
      }
      if (!params.taskId && !params.objective?.trim()) throw new Error("Creating a task requires a non-empty objective");
      const task = params.taskId ? await tasks.load(params.taskId) : await tasks.create(params.objective ?? "", params.plan ?? []);
      const binding = await contexts.bind(sessionId(ctx), task.id);
      return textResult({ task, binding });
    }
  });
  pi.registerTool({
    name: "yocto_task_status", label: "Inspect Yocto task",
    description: "List persisted tasks or load one exact task before choosing it for cross-session resume. Read-only.",
    parameters: Type.Object({ taskId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const store = new TaskStore(await locate(ctx));
      return textResult(params.taskId ? await store.load(params.taskId) : await store.list());
    }
  });
  pi.registerTool({
    name: "yocto_completion_status", label: "Check Yocto completion gates",
    description: "Return server-evaluated completion issues and allowed next actions. Use this before attempting finalization or after any phase/precondition error.",
    parameters: Type.Object({ taskId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      return textResult(await new TaskStore(located).completionStatus(taskId));
    }
  });
  pi.registerTool({
    name: "yocto_task_replan", label: "Replan after failed verification",
    description: "Enter controlled REPLANNING after a failed current verification job or trusted semantic assertion. Requires persisted non-zero current-iteration Evidence, no active jobs, and a remaining fix iteration.",
    parameters: Type.Object({ taskId: Type.Optional(Type.String()), failedEvidenceId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      return textResult(await new TaskStore(located).requestReplan(taskId, params.failedEvidenceId));
    }
  });
  pi.registerTool({
    name: "yocto_task_finalize", label: "Finalize Yocto task",
    description: "Atomically verify every controller completion gate, capture final job snapshots/log offsets, persist the auditable summary, and set COMPLETED from VERIFYING or SUMMARIZING.",
    parameters: Type.Object({ taskId: Type.Optional(Type.String()), finalSummary: Type.String({ minLength: 1 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      return textResult(await new TaskStore(located).finalize(taskId, params.finalSummary));
    }
  });

  pi.registerTool({
    name: "yocto_workspace_inspect", label: "Inspect Poky workspace",
    description: "Inspect configured Poky commit, dirty files, MACHINE/DISTRO, layers, caches and artifacts. Read-only.",
    parameters: Type.Object({ includeBitbake: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const result = await inspectWorkspace(located, params.includeBitbake ?? false);
      await persistToolEvidence(located, ctx, result.evidence);
      return textResult(result);
    }
  });

  pi.registerTool({
    name: "yocto_knowledge_search", label: "Search offline Yocto knowledge",
    description: "Search the deterministic local index of the configured Poky source, manuals and curated scarthgap workflows.",
    parameters: Type.Object({ query: Type.String(), release: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx);
      try { return textResult(await searchKnowledge(located, params.query, { ...(params.release ? { release: params.release } : {}), ...(params.limit ? { limit: params.limit } : {}) })); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("index missing")) throw error;
        await buildKnowledgeIndex(located);
        return textResult(await searchKnowledge(located, params.query, { ...(params.release ? { release: params.release } : {}), ...(params.limit ? { limit: params.limit } : {}) }));
      }
    }
  });

  pi.registerTool({
    name: "yocto_artifact_assert", label: "Assert Yocto build artifact semantics",
    description: "Assert that the stable manifest from one exact successful image JobRecord contains or omits an exact package. A failed assertion persists trusted non-zero semantic Evidence; mark the related requirement FAILED and pass that Evidence ID to yocto_task_replan instead of marking the task FAILED or cleaning sstate.",
    parameters: Type.Object({
      jobId: Type.String(), taskId: Type.Optional(Type.String()), package: Type.String(),
      expected: Type.Union([Type.Literal("present"), Type.Literal("absent")])
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      const result = await assertImageManifest(located, { taskId, jobId: params.jobId, package: params.package, expected: params.expected });
      await persistToolEvidence(located, ctx, result.evidence, { requireTask: true, taskId });
      return textResult(result);
    }
  });

  pi.registerTool({
    name: "yocto_metadata_query", label: "Query BitBake metadata",
    description: "Run a controlled, offline bitbake -e/-g/-p/listtasks or bitbake-layers query bound to the active task. The result persists observation/configuration/diagnosis Evidence variants (parse persists execution Evidence) so the contract-compatible ID can be used immediately by yocto_verification_update. Arbitrary flags are not accepted.",
    parameters: Type.Object({
      action: Type.Union(["environment", "parse", "graph", "layers", "recipes", "appends", "tasks"].map((value) => Type.Literal(value))),
      target: Type.Optional(Type.String()), variable: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600000 }))
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx);
      const result = await queryMetadata(located, params as { action: MetadataAction; target?: string; variable?: string; timeoutMs?: number });
      await persistToolEvidence(located, ctx, result.evidence as Evidence[], { requireTask: true, taskId });
      return textResult(result);
    }
  });

  pi.registerTool({
    name: "yocto_log_analyze", label: "Analyze Yocto failure log",
    description: "Find or read a log.do_* and return the first critical error, task, recipe, category, context and evidence hash.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const result = await analyzeLog(located, params.path);
      await persistToolEvidence(located, ctx, result.evidence);
      return textResult(result);
    }
  });

  pi.registerTool({
    name: "yocto_native_cache_inspect", label: "Inspect native sstate reuse",
    description: "Read effective BitBake cache/signature configuration for a -native recipe, parse the newest cooker Sstate summary, inspect an available task signature for target-side architecture dependencies, and return evidence-backed findings. This is read-only and never cleans or forces tasks.",
    parameters: Type.Object({ target: Type.Optional(Type.String()), logPath: Type.Optional(Type.String()), sigPath: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const result = await inspectNativeCache(located, params);
      await persistToolEvidence(located, ctx, result.evidence);
      return textResult(result);
    }
  });

  pi.registerTool({
    name: "yocto_optimization_assert", label: "Assert target optimization flags",
    description: "Run offline bitbake -e for one recipe, require exactly one expected -O flag, optionally inspect its expanded run.do_compile compiler argv, and fingerprint a non-target reference recipe to prove flags did not change globally. Capture the referenceFingerprint before changing metadata, then pass it as expectedReferenceFingerprint after the target build.",
    parameters: Type.Object({
      target: Type.String(), expectedFlag: Type.Union(["-O0", "-O1", "-O2", "-O3", "-Os", "-Oz", "-Og", "-Ofast"].map((flag) => Type.Literal(flag))),
      requireCompileCommand: Type.Optional(Type.Boolean()), compileCommandPath: Type.Optional(Type.String()),
      referenceTarget: Type.Optional(Type.String()), expectedReferenceFingerprint: Type.Optional(Type.String())
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx);
      const result = await assertTargetOptimization(located, params);
      await persistToolEvidence(located, ctx, result.evidence, { requireTask: true, taskId });
      return textResult(result);
    }
  });

  pi.registerTool({
    name: "yocto_job_start", label: "Start background Yocto job",
    description: "Start or reuse one detached offline job bound to the active task. Baseline and diagnostic jobs may run from checkpointed INSPECTING/PLANNING without consuming a fix iteration. Parse, verification, and QEMU require an iteration; QEMU also requires sourceJobId for the exact successful image job.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("bitbake"), Type.Literal("qemu"), Type.Literal("check")]),
      purpose: Type.Union([Type.Literal("baseline"), Type.Literal("diagnostic"), Type.Literal("parse"), Type.Literal("verification"), Type.Literal("incremental-confirmation"), Type.Literal("qemu")]),
      args: Type.Array(Type.String()), taskId: Type.Optional(Type.String()), iteration: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })), sourceJobId: Type.Optional(Type.String())
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      return textResult(await startJob(located, { kind: params.kind as JobKind, purpose: params.purpose as JobPurpose, args: params.args, taskId, ...(params.iteration !== undefined ? { iteration: params.iteration } : {}), ...(params.sourceJobId ? { sourceJobId: params.sourceJobId } : {}) }));
    }
  });
  pi.registerTool({
    name: "yocto_job_status", label: "Check background Yocto job",
    description: "Validate worker PID identity/boot ID and return the persisted job status.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx); const job = await reconcileJob(new JobStore(located), params.id);
      if (job.taskId !== taskId) throw new Error("Job belongs to a different TaskRecord");
      const evidence = jobEvidenceVariants(job);
      if (evidence.length) await persistToolEvidence(located, ctx, evidence, { requireTask: true, taskId });
      return textResult({ job, ...(evidence.length ? { evidence } : {}) });
    }
  });
  pi.registerTool({
    name: "yocto_job_tail", label: "Tail background Yocto job",
    description: "Read only new or recent bytes from a persisted job log.",
    parameters: Type.Object({ id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1048576 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx); const job = await new JobStore(located).load(params.id);
      if (job.taskId !== taskId) throw new Error("Job belongs to a different TaskRecord");
      return textResult(await tailJob(new JobStore(located), params.id, { ...(params.offset !== undefined ? { offset: params.offset } : {}), ...(params.bytes ? { bytes: params.bytes } : {}) }));
    }
  });
  pi.registerTool({
    name: "yocto_job_stop", label: "Stop background Yocto job",
    description: "The only valid way to stop a detached QEMU/job process group. Call this tool directly with the JobRecord ID and no approvalId: it creates the exact action=stop_job approval and asks the human internally. Never call yocto_approval_request first.",
    parameters: Type.Object({ id: Type.String(), taskId: Type.Optional(Type.String()), approvalId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId); const approvals = new ApprovalStore(located);
      const job = await new JobStore(located).load(params.id);
      if (job.taskId !== taskId) throw new Error("Job belongs to a different TaskRecord");
      let approvalId = params.approvalId;
      if (!approvalId) {
        const approval = await promptApproval(located, ctx, { taskId, action: "stop_job", command: ["stop", params.id], impact: "Terminates the complete job process group", risk: "Partial task output may remain in TMPDIR", recovery: "Run the recorded resume command as a new incremental job" });
        if (approval.status !== "APPROVED") throw new Error(`Stop not approved (${approval.status})`);
        approvalId = approval.id;
      }
      await approvals.consume(approvalId, { taskId, action: "stop_job", command: ["stop", params.id] });
      return textResult(await stopJob(new JobStore(located), params.id));
    }
  });

  pi.registerTool({
    name: "yocto_guest_exec", label: "Execute QEMU guest verification",
    description: "Run one argv-only, non-destructive command through the controlled serial channel of a RUNNING QEMU job. Returns guest-domain stdout and a sentinel-verified exit code.",
    parameters: Type.Object({ jobId: Type.String(), argv: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }), taskId: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000 })) }),
    async execute(_id, params, signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      const queued = await queueGuestCommand(located, { taskId, jobId: params.jobId, argv: params.argv, ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}) });
      const command = await waitForGuestCommand(located, queued.id, signal);
      const evidence = guestCommandEvidence(command);
      await persistToolEvidence(located, ctx, [evidence], { requireTask: true, taskId });
      return textResult({ command, evidence: [evidence] });
    }
  });
  pi.registerTool({
    name: "yocto_guest_assert", label: "Assert QEMU guest behavior",
    description: "Run a structured guest predicate without shell pipes/redirections: file existence/absence, gzip fixed-string content, symlink target, or command output matching. Persists guest behavior Evidence whose exitCode reflects the assertion result.",
    parameters: Type.Object({
      jobId: Type.String(), taskId: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000 })),
      kind: Type.Union([Type.Literal("file-exists"), Type.Literal("file-absent"), Type.Literal("gzip-contains"), Type.Literal("symlink-target"), Type.Literal("command-output")]),
      path: Type.Optional(Type.String()), value: Type.Optional(Type.String()), argv: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 32 })),
      match: Type.Optional(Type.Union([Type.Literal("contains"), Type.Literal("equals")]))
    }),
    async execute(_id, params, signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      const assertion = params.kind === "command-output"
        ? { kind: params.kind, argv: params.argv ?? [], value: params.value ?? "", ...(params.match ? { match: params.match } : {}) }
        : params.kind === "file-exists" || params.kind === "file-absent"
          ? { kind: params.kind, path: params.path ?? "" }
          : { kind: params.kind, path: params.path ?? "", value: params.value ?? "" } as GuestAssertionInput;
      const argv = guestAssertionArgv(assertion as GuestAssertionInput);
      const queued = await queueGuestCommand(located, { taskId, jobId: params.jobId, argv, ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}) });
      const command = await waitForGuestCommand(located, queued.id, signal);
      const evidence = guestAssertionEvidence(command, assertion as GuestAssertionInput);
      await persistToolEvidence(located, ctx, [evidence], { requireTask: true, taskId });
      return textResult({ passed: evidence.exitCode === 0, assertion, command, evidence: [evidence] });
    }
  });

  pi.registerTool({
    name: "yocto_checkpoint", label: "Checkpoint Yocto task",
    description: "Persist objective, phase, exact evidence and modified files outside the Pi conversation. Job log offsets, status, PID/PGID, start ticks, boot ID, heartbeat and resume command are captured from JobStore server-side; model-provided offsets cannot downgrade them. COMPLETED enforces the controller completionPolicy.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()), objective: Type.String(), phase: phaseSchema,
      modifiedFiles: Type.Array(Type.String()), evidence: Type.Optional(Type.Array(Type.Unknown())),
      completedSteps: Type.Array(Type.String()), pendingSteps: Type.Array(Type.String()), jobIds: Type.Optional(Type.Array(Type.String())),
      logOffsets: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))), resumeAction: Type.Optional(Type.String()), finalSummary: Type.Optional(Type.String())
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId); const store = new TaskStore(located); const task = await store.load(taskId); const latest = task.checkpoints.at(-1);
      const updated = await store.checkpoint(taskId, {
        objective: params.objective, phase: params.phase as TaskPhase, modifiedFiles: params.modifiedFiles,
        evidenceIds: ((params.evidence ?? []) as Evidence[]).map((item) => item.id), completedSteps: params.completedSteps, pendingSteps: params.pendingSteps,
        jobIds: params.jobIds ?? latest?.jobIds ?? task.jobIds, logOffsets: params.logOffsets ?? latest?.logOffsets ?? {},
        ...(params.resumeAction ? { resumeAction: params.resumeAction } : {}), ...(params.finalSummary ? { finalSummary: params.finalSummary } : {})
      }, (params.evidence ?? []) as Evidence[]);
      return textResult(params.phase === "VERIFYING" ? { ...updated, verificationReadiness: await store.requiredJobStatus(taskId) } : updated);
    }
  });

  pi.registerTool({
    name: "yocto_verification_plan", label: "Define verification contract",
    description: "Persist the ordered, machine-checkable completion requirements for the active task before implementation. COMPLETED is rejected until every required item passes.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()), requirements: Type.Array(Type.Object({
        id: Type.String(), description: Type.String(), required: Type.Boolean(),
        expectedDomain: Type.Optional(Type.Union(["host", "guest", "build", "metadata", "source", "documentation"].map((value) => Type.Literal(value)))),
        expectedClaimType: Type.Optional(Type.Union(["observation", "diagnosis", "configuration", "build", "artifact", "execution", "behavior"].map((value) => Type.Literal(value)))),
        expectedEvidenceSource: Type.Optional(Type.String({ minLength: 1 }))
      }), { minItems: 1 })
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      return textResult(await new TaskStore(located).setVerificationContract(taskId, params.requirements));
    }
  });
  pi.registerTool({
    name: "yocto_verification_update", label: "Record verification result",
    description: "Bind persisted evidence to one verification requirement. Evidence returned by metadata, terminal job-status, guest-exec, workspace, log, mirror and review tools is stored server-side automatically. Guest requirements only accept guest-domain evidence with an exact exit code.",
    parameters: Type.Object({ taskId: Type.Optional(Type.String()), requirementId: Type.String(), status: Type.Union([Type.Literal("PASSED"), Type.Literal("FAILED"), Type.Literal("SKIPPED")]), evidenceIds: Type.Array(Type.String()), note: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      return textResult(await new TaskStore(located).updateVerification(taskId, params.requirementId, params.status, params.evidenceIds, params.note));
    }
  });

  pi.registerTool({
    name: "yocto_review", label: "Review Yocto metadata",
    description: "Review recipes, appends, classes, layer config and patches for license, override, source pinning and offline reproducibility issues. The result is persisted on the active TaskRecord for completion gating.",
    parameters: Type.Object({ files: Type.Array(Type.String(), { minItems: 1 }), taskId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      const result = await reviewYoctoFiles(located, params.files);
      await new TaskStore(located).recordReview(taskId, { files: params.files.map((file) => resolve(file)), passed: result.passed, evidenceIds: result.evidence.map((item) => item.id) }, result.evidence);
      return textResult(result);
    }
  });

  pi.registerTool({
    name: "yocto_change_prepare", label: "Prepare approved Yocto change",
    description: "Prepare complete file contents or renames as one immutable ChangeSet. Controller-declared fixed inputs must be copied exactly, and tasks requiring design comparison must select the lowest-impact option. It hashes pre/post images, validates patches/metadata, and requests human approval for the exact scope.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()), objective: Type.String(), patchBaseDir: Type.Optional(Type.String()),
      changes: Type.Array(Type.Object({ kind: Type.Union([Type.Literal("write"), Type.Literal("rename")]), path: Type.String(), content: Type.Optional(Type.String()), destination: Type.Optional(Type.String()) }), { minItems: 1 }),
      decisionAnalysis: Type.Optional(Type.Object({
        selectedId: Type.String(), rationale: Type.String(),
        options: Type.Array(Type.Object({ id: Type.String(), summary: Type.String(), files: Type.Array(Type.String()), affectedPackages: Type.Array(Type.String()), impactScore: Type.Integer({ minimum: 0, maximum: 100 }) }), { minItems: 2 })
      }))
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      const changeSet = await prepareChangeSet(located, { taskId, objective: params.objective, changes: params.changes, ...(params.patchBaseDir ? { patchBaseDir: params.patchBaseDir } : {}), ...(params.decisionAnalysis ? { decisionAnalysis: params.decisionAnalysis } : {}) });
      const approval = await promptApproval(located, ctx, {
        taskId, action: "apply_change_set", command: ["apply-change-set", changeSet.id], files: changeSet.files, changeSetId: changeSet.id, changeSetScopeHash: changeSet.scopeHash,
        impact: `Apply immutable ChangeSet ${changeSet.id} to ${changeSet.files.length} exact paths`, risk: "Yocto metadata/source may fail parse or build despite passing static preflight",
        recovery: "Use the ChangeSet pre-image hashes and task checkpoint to restore only these exact paths"
      });
      const bound = approval.status === "APPROVED" ? await new ChangeSetStore(located).bindApproval(changeSet.id, approval.id) : changeSet;
      return textResult({ changeSet: bound, approval });
    }
  });
  pi.registerTool({
    name: "yocto_change_apply", label: "Apply approved Yocto change",
    description: "Atomically claim the exact approval and apply its immutable ChangeSet after rechecking every pre-image. Generic edit/write is intentionally blocked for protected Yocto paths.",
    parameters: Type.Object({ changeSetId: Type.String(), taskId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId); const changeSet = await new ChangeSetStore(located).load(params.changeSetId);
      if (changeSet.taskId !== taskId) throw new Error("ChangeSet belongs to a different TaskRecord");
      return textResult(await applyChangeSet(located, params.changeSetId));
    }
  });
  pi.registerTool({
    name: "yocto_mirror_preflight", label: "Preflight offline file mirror",
    description: "Verify an HTTP(S) source basename and SHA-256 against one local mirror file, then generate a scarthgap-compatible PREMIRRORS rule with the required newline separator. Read-only.",
    parameters: Type.Object({ sourceUri: Type.String(), mirrorFile: Type.String(), expectedSha256: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const result = await preflightFileMirror(located, params);
      await persistToolEvidence(located, ctx, result.evidence);
      return textResult(result);
    }
  });

  pi.registerTool({
    name: "yocto_approval_request", label: "Request Yocto approval",
    description: "Create an expiring approval for an otherwise unsupported high-risk action. Reserved actions apply_change_set and stop_job are rejected here because yocto_change_prepare and yocto_job_stop must create their own content/job-bound approvals.",
    parameters: Type.Object({ taskId: Type.String(), action: Type.String(), command: Type.Optional(Type.String()), files: Type.Optional(Type.Array(Type.String())), impact: Type.String(), estimatedDuration: Type.Optional(Type.String()), risk: Type.String(), recovery: Type.String(), ttlMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const located = await locate(ctx); const taskId = await requireActiveTask(located, ctx, params.taskId);
      if (["apply_change_set", "stop_job"].includes(params.action)) throw new Error(`Reserved approval action ${params.action}; call ${params.action === "stop_job" ? "yocto_job_stop with the exact JobRecord ID and no approvalId" : "yocto_change_prepare"} directly`);
      return textResult(await promptApproval(located, ctx, { taskId, action: params.action, ...(params.command ? { command: params.command } : {}), ...(params.files ? { files: params.files } : {}), impact: params.impact, ...(params.estimatedDuration ? { estimatedDuration: params.estimatedDuration } : {}), risk: params.risk, recovery: params.recovery, ...(params.ttlMinutes ? { ttlMinutes: params.ttlMinutes } : {}) }));
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    let located: LocatedConfig;
    try { located = await locate(ctx); } catch { return undefined; }
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? ""); const decision = classifyCommand(command, located.config.offline.blockExplicitNetworkCommands);
      if (/\b(?:bitbake(?:-layers)?|runqemu)\b/.test(command)) return { block: true, reason: "Direct BitBake/runqemu shell execution bypasses task budgets and checkpointing; use yocto_metadata_query or yocto_job_start" };
      if (/\b(?:kill|pkill|killall)\b/i.test(command)) return { block: true, reason: "Direct process termination cannot consume a JobRecord-bound approval; use yocto_job_stop for the exact job" };
      if (decision.category === "workspace-write") return { block: true, reason: `${decision.reason}; protected writes must use yocto_change_prepare followed by yocto_change_apply` };
      if (decision.requiresApproval) {
        const taskId = await requireActiveTask(located, ctx);
        if (!(await consumeCommandApproval(located, taskId, decision.category, command))) {
          const approval = await promptApproval(located, ctx, { taskId, action: decision.category, command, impact: "May change external state, caches, metadata, or Git history", risk: decision.reason, recovery: "Inspect persisted task/job records and restore only the exact affected paths", estimatedDuration: "unknown" });
          if (approval.status !== "APPROVED") return { block: true, reason: `${decision.reason}; approval ${approval.status.toLowerCase()}` };
          await new ApprovalStore(located).consume(approval.id, { taskId, action: decision.category, command, files: [] });
        }
      }
    }
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = String((event.input as { path?: unknown }).path ?? ""); const decision = classifyFileWrite(located, path);
      if (decision.requiresApproval) return { block: true, reason: `${decision.reason}; generic edit/write cannot consume a content-bound approval—use yocto_change_prepare and yocto_change_apply` };
    }
    return undefined;
  });

  const notifyCompleted = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) return;
    try {
      const located = await locate(ctx); const store = new JobStore(located);
      for (const job of await store.list()) {
        const current = await reconcileJob(store, job.id);
        if (["SUCCEEDED", "FAILED", "INTERRUPTED", "STOPPED"].includes(current.status) && !announcedJobs.has(current.id)) {
          announcedJobs.add(current.id); ctx.ui.notify(`Yocto job ${current.id}: ${current.status}`, current.status === "SUCCEEDED" ? "info" : "warning");
        }
      }
    } catch { /* project may not be initialized */ }
  };
  pi.on("session_start", async (_event, ctx) => {
    const disabled = String(pi.getFlag("disable") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    if (disabled.length) pi.setActiveTools(pi.getActiveTools().filter((name) => !disabled.includes(name)));
    if (typeof pi.getFlag("tmux-session") === "string") await requireTmuxSession(String(pi.getFlag("tmux-session")));
    await notifyCompleted(ctx);
  });
  pi.on("tool_execution_end", async (_event, ctx) => notifyCompleted(ctx));
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const located = await locate(ctx);
      const active = await new TaskContextStore(located).active(sessionId(ctx));
      const rules = [
        `Pi Yocto harness is configured at ${located.configPath}.`,
        active ? `The only active TaskRecord is ${active}; pass no different task ID.` : "No TaskRecord is active; call yocto_task_open before any evidence-producing query, approval, change, or job.",
        "BitBake is offline (BB_NO_NETWORK=1). Never replace a controller verification contract; satisfy every required input, review, decision, job, and verification gate.",
        "Protected changes require yocto_change_prepare/yocto_change_apply. The extension requests exact human approval for ChangeSets and job stops; ordinary offline diagnostic, parse, build, and QEMU tools need no extra approval.",
        "Normal flow is INTAKE -> INSPECTING -> PLANNING -> WAITING_HUMAN -> EXECUTING -> VERIFYING. A diagnostic job may reproduce a failure during INSPECTING without consuming an iteration. After failed verification, call yocto_task_replan with its non-zero current-run Evidence; never force VERIFYING back through generic checkpoints.",
        `Parse, verification, and QEMU use iterations up to ${located.config.limits.maxFixIterations}; an unchanged failed verification cannot be repeated.`,
        "A VERIFYING checkpoint returns verificationReadiness with every missing controller-required parse/image/QEMU/incremental Job and a suggested legal tool call; run those jobs before summary. Call yocto_completion_status before finishing and yocto_task_finalize for atomic summary/checkpoint/COMPLETED state instead of manually sequencing final phases.",
        "For QEMU, pass the image target plus sourceJobId of the exact successful image JobRecord. Use yocto_guest_assert for file, gzip, symlink, and output predicates; do not encode pipes or redirections as argv. To stop QEMU, call yocto_job_stop directly with its ID and no approvalId; that tool creates action=stop_job approval internally. Never call yocto_approval_request for a stop.",
        "After a successful image build, use yocto_artifact_assert for required package presence/absence. If the semantic assertion fails, bind its non-zero Evidence to the requirement as FAILED and call yocto_task_replan; do not transition the whole task to FAILED and do not clean or force BitBake.",
        "For a target-only optimization, call yocto_optimization_assert before the change to capture a non-target referenceFingerprint, then after the package build require the intended flag, compiler argv, and unchanged reference fingerprint; never infer success from build exit alone. Tool Evidence is persisted server-side; bind its exact ID with yocto_verification_update. Preserve pre-existing dirty files and never clean caches, force tasks, fetch, or promote host observations to guest evidence."
      ];
      return { systemPrompt: `${event.systemPrompt}\n\n${rules.join(" ")}` };
    } catch { return undefined; }
  });

  for (const name of ["diagnose", "fix-and-verify", "create-layer", "optimize-build", "long-build"]) {
    pi.registerCommand(`yocto-${name}`, {
      description: `Run the fixed Yocto ${name} workflow`,
      handler: async (args, ctx) => {
        const located = await findConfig(ctx.cwd);
        const workflow = JSON.parse(await readFile(join(located.rootDir, ".pi", "yocto-workflows", `${name}.json`), "utf8")) as { cwd?: string; flow: Record<string, unknown> };
        const goal = args || "inspect the configured workspace and ask the human for missing intent";
        const contexts = new TaskContextStore(located); const tasks = new TaskStore(located); const active = await contexts.active(sessionId(ctx));
        const task = active ? await tasks.load(active) : await tasks.create(goal);
        if (active && args && task.objective !== goal) throw new Error(`Pi session is already bound to TaskRecord ${active}; start a new Pi session for a different workflow objective`);
        if (!active) await contexts.bind(sessionId(ctx), task.id);
        const injectGoal = (node: Record<string, unknown>): void => {
          if (node.kind === "spawn") node.task = `TaskRecord: ${task.id}\nUser goal: ${goal}\n\n${String(node.task)}`;
          if (node.kind === "sequence") for (const step of node.steps as Array<Record<string, unknown>>) injectGoal(step);
          if (node.kind === "fork") for (const branch of Object.values(node.branches as Record<string, Record<string, unknown>>)) injectGoal(branch);
          if (node.kind === "loop") injectGoal(node.body as Record<string, unknown>);
          if (node.kind === "join" && node.reducer && (node.reducer as Record<string, unknown>).kind === "agent") {
            const reducer = node.reducer as Record<string, unknown>; reducer.task = `TaskRecord: ${task.id}\nUser goal: ${goal}\n\n${String(reducer.task)}`;
          }
        };
        injectGoal(workflow.flow); workflow.cwd = located.rootDir;
        pi.sendUserMessage(`Use only TaskRecord ${task.id}. Call the pi-agents workflow tool with this fixed, goal-hydrated parameter object. Do not broaden its budgets or file scope:\n\n${JSON.stringify(workflow)}`);
      }
    });
  }
  pi.registerCommand("yocto-jobs", { description: "Show persisted Yocto jobs", handler: async (_args, ctx) => { const located = await findConfig(ctx.cwd); ctx.ui.notify(JSON.stringify(await new JobStore(located).list(), null, 2), "info"); } });
}
