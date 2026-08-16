import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { assertImageManifest } from "../src/artifact-assertion.js";
import { JobStore } from "../src/jobs.js";
import { TaskStore } from "../src/state.js";
import type { JobRecord } from "../src/types.js";
import { SCHEMA_VERSION } from "../src/types.js";
import { createTestWorkspace } from "./fixture.js";

test("image manifest assertion produces trusted semantic failure evidence for controlled replanning", async () => {
  const located = await createTestWorkspace("pi-yocto-manifest-assert-");
  const tasks = new TaskStore(located);
  let task = await tasks.create("remove one image package");
  await tasks.setVerificationContract(task.id, [{ id: "absence", description: "legacy package is absent", required: true, expectedDomain: "build", expectedClaimType: "behavior", expectedEvidenceSource: "bitbake:image-manifest-assertion" }]);
  for (const phase of ["INSPECTING", "PLANNING", "EXECUTING", "VERIFYING"] as const) task = await tasks.transition(task.id, phase);
  await tasks.checkpoint(task.id, { objective: task.objective, phase: "VERIFYING", modifiedFiles: [], evidenceIds: [], completedSteps: ["image metadata changed"], pendingSteps: ["assert manifest"], jobIds: [], logOffsets: {} });

  const jobId = "job-image-semantic";
  await tasks.reserveJob(task.id, { jobId, purpose: "verification", fingerprint: "manifest-job", inputFingerprint: "c".repeat(64), target: "validation-image", iteration: 1 });
  const deploy = join(located.config.buildDir, "tmp", "deploy", "images", located.config.machine);
  const manifest = join(deploy, `validation-image-${located.config.machine}.rootfs.manifest`);
  await mkdir(deploy, { recursive: true });
  await writeFile(manifest, "core-agent x86_64 1.0\nlegacy-diag x86_64 1.0\n", "utf8");
  const now = new Date().toISOString();
  const job: JobRecord = {
    schemaVersion: SCHEMA_VERSION,
    id: jobId,
    taskId: task.id,
    kind: "bitbake",
    purpose: "verification",
    iteration: 1,
    fingerprint: "manifest-job",
    executable: "bitbake",
    args: ["validation-image"],
    cwd: located.config.buildDir,
    status: "SUCCEEDED",
    createdAt: now,
    completedAt: now,
    exitCode: 0,
    logPath: new JobStore(located).logPath(jobId),
    logOffset: 1,
    artifacts: [manifest]
  };
  await mkdir(join(located.stateDir, "jobs"), { recursive: true });
  await writeFile(job.logPath, "ok\n", "utf8");
  await new JobStore(located).save(job);
  await tasks.updateJobStatus(task.id, job.id, "SUCCEEDED", now);

  const failed = await assertImageManifest(located, { taskId: task.id, jobId, package: "legacy-diag", expected: "absent" });
  assert.equal(failed.passed, false);
  assert.equal(failed.evidence[0]?.exitCode, 1);
  assert.equal(failed.evidence[0]?.source, "bitbake:image-manifest-assertion");
  await tasks.recordEvidence(task.id, failed.evidence);
  const evidenceId = failed.evidence[0]?.id as string;
  await tasks.updateVerification(task.id, "absence", "FAILED", [evidenceId], "semantic package membership mismatch");
  const replanning = await tasks.requestReplan(task.id, evidenceId);
  assert.equal(replanning.phase, "REPLANNING");

  const present = await assertImageManifest(located, { taskId: task.id, jobId, package: "core-agent", expected: "present" });
  assert.equal(present.passed, true);
  assert.equal(present.observed, "present");
});
