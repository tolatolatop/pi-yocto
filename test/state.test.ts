import assert from "node:assert/strict";
import { test } from "node:test";
import { canTransition, transitionTask } from "../src/state.js";
import { JobStore } from "../src/jobs.js";
import { TaskStore } from "../src/state.js";
import type { Evidence, JobRecord, TaskRecord } from "../src/types.js";
import { SCHEMA_VERSION } from "../src/types.js";
import { createTestWorkspace } from "./fixture.js";

test("task state machine accepts the fixed happy path and rejects skips", () => {
  const now = new Date().toISOString();
  let task: TaskRecord = { schemaVersion: SCHEMA_VERSION, id: "task-test", objective: "test", phase: "INTAKE", plan: [], checkpoints: [], evidence: [], jobIds: [], approvalIds: [], changeSetIds: [], currentFixIteration: 0, verificationAttempts: [], verificationContract: { createdAt: now, requirements: [{ id: "proof", description: "verified", required: true, status: "PASSED", evidenceIds: ["ev-proof"] }] }, createdAt: now, updatedAt: now, finalSummary: "verified result" };
  for (const phase of ["INSPECTING", "PLANNING", "WAITING_HUMAN", "EXECUTING", "VERIFYING", "SUMMARIZING", "COMPLETED"] as const) task = transitionTask(task, phase);
  assert.equal(task.phase, "COMPLETED");
  assert.equal(canTransition("INTAKE", "EXECUTING"), false);
  assert.equal(canTransition("FAILED", "INSPECTING"), false);
  assert.equal(canTransition("FAILED", "PAUSED"), false);
  assert.throws(() => transitionTask({ ...task, phase: "INTAKE" }, "EXECUTING"));
  assert.throws(() => transitionTask({ ...task, phase: "FAILED" }, "INSPECTING"));
});

test("failed current-run evidence enables one controlled REPLANNING transition", async () => {
  const located = await createTestWorkspace("pi-yocto-replan-");
  const tasks = new TaskStore(located);
  let task = await tasks.create("repair a failed build");
  for (const phase of ["INSPECTING", "PLANNING", "EXECUTING", "VERIFYING"] as const) task = await tasks.transition(task.id, phase);
  task = await tasks.checkpoint(task.id, { objective: task.objective, phase: "VERIFYING", modifiedFiles: [], evidenceIds: [], completedSteps: ["first change applied"], pendingSteps: ["verify"], jobIds: [], logOffsets: {} });
  await tasks.reserveJob(task.id, { jobId: "job-failed", purpose: "verification", fingerprint: "command", inputFingerprint: "a".repeat(64), target: "demo", iteration: 1 });
  const now = new Date().toISOString();
  const failed: JobRecord = {
    schemaVersion: SCHEMA_VERSION, id: "job-failed", taskId: task.id, kind: "bitbake", purpose: "verification", iteration: 1,
    fingerprint: "command", executable: "bitbake", args: ["demo"], cwd: located.config.buildDir, status: "FAILED", exitCode: 1,
    createdAt: now, completedAt: now, logPath: new JobStore(located).logPath("job-failed"), logOffset: 10, artifacts: []
  };
  await new JobStore(located).save(failed);
  await tasks.updateJobStatus(task.id, failed.id, "FAILED", now);
  const evidence: Evidence = { id: "ev-failed", kind: "command", executionDomain: "build", claimType: "build", source: failed.logPath, fact: "verification failed", confidence: "high", capturedAt: now, command: ["bitbake", "demo"], exitCode: 1, jobId: failed.id };
  await tasks.recordEvidence(task.id, [evidence]);
  const replanning = await tasks.requestReplan(task.id, evidence.id);
  assert.equal(replanning.phase, "REPLANNING");
  assert.ok(replanning.checkpoints.at(-1)?.pendingSteps.some((step) => step.includes("revised ChangeSet")));
  await assert.rejects(() => tasks.requestReplan(task.id, evidence.id), /currentPhase=REPLANNING/);
});

test("trusted failed semantic requirement enables controlled REPLANNING after a successful build", async () => {
  const located = await createTestWorkspace("pi-yocto-semantic-replan-");
  const tasks = new TaskStore(located);
  let task = await tasks.create("repair a guest semantic failure");
  await tasks.setVerificationContract(task.id, [{ id: "guest-mode", description: "guest reports size mode", required: true, expectedDomain: "guest", expectedClaimType: "execution" }]);
  for (const phase of ["INSPECTING", "PLANNING", "EXECUTING", "VERIFYING"] as const) task = await tasks.transition(task.id, phase);
  task = await tasks.checkpoint(task.id, { objective: task.objective, phase: "VERIFYING", modifiedFiles: [], evidenceIds: [], completedSteps: ["image build succeeded"], pendingSteps: ["guest assertion"], jobIds: [], logOffsets: {} });
  await tasks.reserveJob(task.id, { jobId: "job-qemu-semantic", purpose: "qemu", fingerprint: "qemu-command", inputFingerprint: "b".repeat(64), target: "demo-image", iteration: 1 });
  const now = new Date().toISOString();
  const qemu: JobRecord = {
    schemaVersion: SCHEMA_VERSION, id: "job-qemu-semantic", taskId: task.id, kind: "qemu", purpose: "qemu", iteration: 1,
    fingerprint: "qemu-command", executable: "runqemu", args: ["demo-image"], cwd: located.config.buildDir, status: "STOPPED",
    createdAt: now, completedAt: now, logPath: new JobStore(located).logPath("job-qemu-semantic"), logOffset: 10, artifacts: []
  };
  await new JobStore(located).save(qemu);
  const evidence: Evidence = { id: "ev-wrong-mode", kind: "command", executionDomain: "guest", claimType: "execution", source: "guest-command:mode", fact: "expected size but observed speed", confidence: "high", capturedAt: now, command: ["optimize-probe", "--mode"], exitCode: 1, jobId: qemu.id };
  await tasks.recordEvidence(task.id, [evidence]);
  await tasks.updateVerification(task.id, "guest-mode", "FAILED", [evidence.id], "semantic output mismatch");
  await assert.rejects(() => tasks.checkpoint(task.id, { objective: task.objective, phase: "FAILED", modifiedFiles: [], evidenceIds: [evidence.id], completedSteps: ["semantic assertion failed"], pendingSteps: ["repair metadata"], jobIds: [qemu.id], logOffsets: {} }), /Terminal FAILED cannot retain pending recovery steps/);
  await assert.rejects(() => tasks.checkpoint(task.id, { objective: task.objective, phase: "FAILED", modifiedFiles: [], evidenceIds: [evidence.id], completedSteps: ["semantic assertion failed"], pendingSteps: [], jobIds: [qemu.id], logOffsets: {} }), /remaining controlled repair iteration/);
  const replanning = await tasks.requestReplan(task.id, evidence.id);
  assert.equal(replanning.phase, "REPLANNING");
  assert.equal(replanning.evidence.find((item) => item.id === evidence.id)?.provenance, "harness-tool");
});

test("specialized verification requirements reject generic same-domain evidence", async () => {
  const located = await createTestWorkspace("pi-yocto-specialized-evidence-");
  const tasks = new TaskStore(located);
  const task = await tasks.create("prove effective compiler flags");
  await tasks.setVerificationContract(task.id, [{
    id: "effective-flags",
    description: "one effective optimization flag",
    required: true,
    expectedDomain: "metadata",
    expectedClaimType: "configuration",
    expectedEvidenceSource: "bitbake:optimization-assertion"
  }]);
  const capturedAt = new Date().toISOString();
  const generic: Evidence = { id: "ev-generic-env", kind: "metadata", executionDomain: "metadata", claimType: "configuration", source: "bitbake:environment", fact: "CFLAGS was printed", confidence: "high", capturedAt };
  const specialized: Evidence = { id: "ev-specialized-flags", kind: "metadata", executionDomain: "metadata", claimType: "configuration", source: "bitbake:optimization-assertion", fact: "compiler argv has exactly -Os", confidence: "high", capturedAt };
  await tasks.recordEvidence(task.id, [generic, specialized]);
  await assert.rejects(() => tasks.updateVerification(task.id, "effective-flags", "PASSED", [generic.id]), /requires trusted evidence from bitbake:optimization-assertion/);
  const updated = await tasks.updateVerification(task.id, "effective-flags", "PASSED", [specialized.id]);
  assert.equal(updated.verificationContract?.requirements[0]?.status, "PASSED");
});

test("completion status returns the exact yocto_job_stop call for active QEMU", async () => {
  const located = await createTestWorkspace("pi-yocto-qemu-next-action-");
  const tasks = new TaskStore(located);
  const task = await tasks.create("stop qemu safely");
  const now = new Date().toISOString();
  const qemu: JobRecord = {
    schemaVersion: SCHEMA_VERSION, id: "job-active-qemu", taskId: task.id, kind: "qemu", purpose: "qemu", iteration: 1,
    fingerprint: "active-qemu", executable: "runqemu", args: ["test-image"], cwd: located.config.buildDir, status: "RUNNING",
    pid: process.pid, processGroupId: process.pid, createdAt: now, startedAt: now, heartbeatAt: now,
    logPath: new JobStore(located).logPath("job-active-qemu"), logOffset: 1, artifacts: []
  };
  await new JobStore(located).save(qemu);
  await tasks.save({ ...task, jobIds: [qemu.id] });
  const status = await tasks.completionStatus(task.id);
  assert.ok(status.allowedNextActions.includes(`stop-active-qemu:${JSON.stringify({ tool: "yocto_job_stop", id: qemu.id, taskId: task.id })}`));
});

test("atomic finalization completes directly from VERIFYING after server-side gates pass", async () => {
  const located = await createTestWorkspace("pi-yocto-finalize-");
  const tasks = new TaskStore(located);
  let task = await tasks.create("finalize without fragile manual phase calls");
  await tasks.setVerificationContract(task.id, [{ id: "proof", description: "proof", required: true, expectedDomain: "source", expectedClaimType: "observation" }]);
  for (const phase of ["INSPECTING", "PLANNING", "EXECUTING", "VERIFYING"] as const) task = await tasks.transition(task.id, phase);
  const evidence: Evidence = { id: "ev-proof", kind: "source", executionDomain: "source", claimType: "observation", source: located.layerDir, fact: "source proof", confidence: "high", capturedAt: new Date().toISOString() };
  await tasks.recordEvidence(task.id, [evidence]);
  await tasks.updateVerification(task.id, "proof", "PASSED", [evidence.id]);
  const status = await tasks.completionStatus(task.id);
  assert.equal(status.ready, true);
  assert.ok(status.allowedNextActions.includes("finalize-task-atomically"));
  const completed = await tasks.finalize(task.id, "All required source evidence passed; no unresolved assumptions or active jobs.");
  assert.equal(completed.phase, "COMPLETED");
  assert.equal(completed.checkpoints.at(-1)?.pendingSteps.length, 0);
});

test("VERIFYING readiness lists exact missing controller jobs and legal tool calls", async () => {
  const located = await createTestWorkspace("pi-yocto-required-jobs-");
  const tasks = new TaskStore(located);
  const task = await tasks.create("surface parse and image gates early");
  await tasks.save({
    ...task,
    completionPolicy: {
      requiredJobs: [
        { id: "parse", kind: "check", purpose: "parse" },
        { id: "image", kind: "bitbake", purpose: "verification", target: "demo-image" },
        { id: "qemu", kind: "qemu", purpose: "qemu", allowedStatuses: ["STOPPED"] }
      ]
    }
  });
  const readiness = await tasks.requiredJobStatus(task.id);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing.map((item) => item.id), ["parse", "image", "qemu"]);
  assert.deepEqual(readiness.missing[0]?.suggestedCall, { tool: "yocto_job_start", kind: "check", purpose: "parse", args: ["-p"], iteration: 1 });
  assert.equal(readiness.missing[2]?.suggestedCall.blockedBy, "a successful verification image job with a qemuboot.conf artifact");
});
