import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { prepareChangeSet } from "../src/changes.js";
import { GuestCommandStore } from "../src/guest.js";
import { JobStore } from "../src/jobs.js";
import { sha256, writeJsonAtomic } from "../src/fs-utils.js";
import { TaskStore } from "../src/state.js";
import type { Evidence, GuestCommandRecord, JobRecord, ProjectContract } from "../src/types.js";
import { SCHEMA_VERSION } from "../src/types.js";
import { createTestWorkspace } from "./fixture.js";

async function writeContract(located: Awaited<ReturnType<typeof createTestWorkspace>>, contract: ProjectContract): Promise<void> {
  await writeJsonAtomic(join(located.rootDir, ".pi", "yocto-contract.json"), contract);
}

test("controller contract pins fixed inputs and the lowest-impact ChangeSet decision", async () => {
  const located = await createTestWorkspace("pi-yocto-contract-input-");
  const attachment = join(located.rootDir, "attachments", "tool");
  await mkdir(join(located.rootDir, "attachments"), { recursive: true });
  await writeFile(attachment, "#!/bin/sh\necho approved\n", "utf8");
  const destination = join(located.layerDir, "recipes-demo", "tool", "files", "tool");
  await writeContract(located, {
    schemaVersion: SCHEMA_VERSION,
    id: "fixed-input",
    requirements: [{ id: "proof", description: "proof", required: true }],
    completion: { requireDecisionAnalysis: true },
    inputs: [{ id: "approved-tool", path: "attachments/tool", sha256: sha256(await readFile(attachment)), required: true, purpose: "approved source", usage: "copy", destinationSuffix: "/files/tool" }]
  });
  const tasks = new TaskStore(located);
  let task = await tasks.create("use fixed input");
  assert.equal(task.contractId, "fixed-input");
  assert.equal(task.inputManifest?.[0]?.path, attachment);
  task = await tasks.transition(task.id, "INSPECTING");
  task = await tasks.transition(task.id, "PLANNING");
  await assert.rejects(() => prepareChangeSet(located, { taskId: task.id, objective: "generated replacement", changes: [{ kind: "write", path: destination, content: "generated\n" }] }), /copied byte-for-byte/);
  const approvedContent = await readFile(attachment, "utf8");
  await assert.rejects(() => prepareChangeSet(located, {
    taskId: task.id, objective: "wrong option", changes: [{ kind: "write", path: destination, content: approvedContent }],
    decisionAnalysis: { selectedId: "large", rationale: "wrong", options: [
      { id: "small", summary: "one file", files: [destination], affectedPackages: ["tool"], impactScore: 1 },
      { id: "large", summary: "many packages", files: [destination], affectedPackages: ["tool", "image"], impactScore: 5 }
    ] }
  }), /lowest declared product impactScore/);
  const prepared = await prepareChangeSet(located, {
    taskId: task.id, objective: "approved copy", changes: [{ kind: "write", path: destination, content: approvedContent }],
    decisionAnalysis: { selectedId: "small", rationale: "smallest file and package scope", options: [
      { id: "small", summary: "one file", files: [destination], affectedPackages: ["tool"], impactScore: 1 },
      { id: "large", summary: "change global image", files: [destination, join(located.config.buildDir, "conf", "local.conf")], affectedPackages: ["tool", "all-images"], impactScore: 9 }
    ] }
  });
  assert.deepEqual(prepared.inputIds, ["approved-tool"]);
  assert.equal(prepared.decisionAnalysis?.selectedId, "small");
});

test("completion policy rejects active jobs and accepts server-captured identity and offsets", async () => {
  const located = await createTestWorkspace("pi-yocto-contract-complete-");
  await writeContract(located, {
    schemaVersion: SCHEMA_VERSION,
    id: "completion-gate",
    requirements: [{ id: "proof", description: "proof", required: true }],
    completion: {
      requiredJobs: [{ id: "image", kind: "bitbake", purpose: "verification", target: "demo" }],
      requireReview: true, requireNoActiveJobs: true, requireNonzeroLogOffsets: true, requireJobIdentitySnapshots: true
    }
  });
  const tasks = new TaskStore(located);
  let task = await tasks.create("complete only after terminal evidence");
  for (const phase of ["INSPECTING", "PLANNING", "EXECUTING", "VERIFYING", "SUMMARIZING"] as const) task = await tasks.transition(task.id, phase);
  const now = new Date().toISOString();
  const logPath = new JobStore(located).logPath("job-demo");
  await mkdir(join(located.stateDir, "jobs"), { recursive: true });
  await writeFile(logPath, "offline=true\n", "utf8");
  const job: JobRecord = {
    schemaVersion: SCHEMA_VERSION, id: "job-demo", taskId: task.id, kind: "bitbake", purpose: "verification", iteration: 1,
    fingerprint: "demo", executable: "bitbake", args: ["demo"], cwd: located.config.buildDir, status: "RUNNING",
    pid: process.pid, processGroupId: process.pid, processStartTicks: "123", bootId: "boot", heartbeatAt: now,
    createdAt: now, startedAt: now, logPath, logOffset: 0, artifacts: []
  };
  await new JobStore(located).save(job);
  task = { ...task, jobIds: [job.id] };
  await tasks.save(task);
  const reviewEvidence: Evidence = { id: "ev-review", kind: "source", executionDomain: "source", claimType: "diagnosis", source: join(located.layerDir, "demo.bb"), fact: "review passed", confidence: "high", capturedAt: now };
  await tasks.recordReview(task.id, { files: [reviewEvidence.source], passed: true, evidenceIds: [reviewEvidence.id] }, [reviewEvidence]);
  const proof: Evidence = { id: "ev-proof", kind: "source", executionDomain: "source", claimType: "observation", source: located.layerDir, fact: "proof", confidence: "high", capturedAt: now };
  await tasks.checkpoint(task.id, { objective: task.objective, phase: "SUMMARIZING", modifiedFiles: [], evidenceIds: [proof.id], completedSteps: ["proof"], pendingSteps: [], jobIds: [job.id], logOffsets: {} }, [proof]);
  await tasks.updateVerification(task.id, "proof", "PASSED", [proof.id]);
  await assert.rejects(() => tasks.checkpoint(task.id, { objective: task.objective, phase: "COMPLETED", modifiedFiles: [], evidenceIds: [proof.id], completedSteps: ["proof"], pendingSteps: [], jobIds: [job.id], logOffsets: {}, finalSummary: "facts; assumptions: none; risks: none" }), /requires image|active jobs/);
  await new JobStore(located).save({ ...job, status: "SUCCEEDED", exitCode: 0, completedAt: now, logOffset: 13 });
  const completed = await tasks.checkpoint(task.id, { objective: task.objective, phase: "COMPLETED", modifiedFiles: [], evidenceIds: [proof.id], completedSteps: ["proof"], pendingSteps: [], jobIds: [job.id], logOffsets: {}, finalSummary: "facts; assumptions: none; risks: none" });
  assert.equal(completed.phase, "COMPLETED");
  assert.equal(completed.checkpoints.at(-1)?.logOffsets[job.id], 13);
  assert.equal(completed.checkpoints.at(-1)?.jobSnapshots?.[job.id]?.processGroupId, process.pid);
});

test("current-run evidence binding rejects another validation workspace", async () => {
  const located = await createTestWorkspace("pi-yocto-contract-evidence-");
  const tasks = new TaskStore(located);
  const task = await tasks.create("bind evidence");
  const evidence: Evidence = { id: "ev-other-run", kind: "log", executionDomain: "build", claimType: "diagnosis", source: "/tmp/.pi-yocto/validation/e2e-01/other-run/log.do_patch", fact: "old failure", confidence: "high", capturedAt: new Date().toISOString() };
  await assert.rejects(() => tasks.checkpoint(task.id, { objective: task.objective, phase: "INTAKE", modifiedFiles: [], evidenceIds: [evidence.id], completedSteps: [], pendingSteps: [], jobIds: [], logOffsets: {} }, [evidence]), /different validation run/);
});

test("package-split E2E contract requires current failure, metadata, and guest domains", async () => {
  const contract = JSON.parse(await readFile(join(process.cwd(), "validation", "contracts", "e2e-03.json"), "utf8")) as ProjectContract;
  const baseline = contract.completion?.requiredJobs?.find((job) => job.id === "baseline-rootfs");
  assert.deepEqual(baseline?.allowedStatuses, ["FAILED"]);
  assert.equal(baseline?.target, "validation-field-image");
  const requirements = new Map(contract.requirements.map((item) => [item.id, item]));
  assert.equal(requirements.get("S3-root-cause")?.expectedDomain, "build");
  assert.equal(requirements.get("S3-root-cause")?.expectedClaimType, "diagnosis");
  assert.equal(requirements.get("S3-ownership")?.expectedDomain, "metadata");
  assert.equal(requirements.get("S3-artifact-guest")?.expectedDomain, "guest");
});

test("binary guest output is artifacted instead of embedded in the command record", async () => {
  const located = await createTestWorkspace("pi-yocto-contract-binary-");
  const store = new GuestCommandStore(located);
  const record: GuestCommandRecord = { schemaVersion: SCHEMA_VERSION, id: "guest-binary", taskId: "task", jobId: "job", argv: ["cat", "/proc/config.gz"], status: "RUNNING", createdAt: new Date().toISOString(), timeoutMs: 3000, output: "" };
  await store.save(record);
  const completed = await store.complete(record.id, { status: "SUCCEEDED", output: `\0\ufffd${"binary".repeat(1000)}`, exitCode: 0 });
  assert.equal(completed.outputType, "binary");
  assert.equal(completed.outputTruncated, true);
  assert.match(completed.output, /stored as artifact/);
  assert.ok(completed.outputArtifact);
  assert.ok((await readFile(completed.outputArtifact ?? "")).length > 0);
});
