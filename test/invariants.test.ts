import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { JobStore, reconcileJob, startJob } from "../src/jobs.js";
import { TaskContextStore, TaskStore } from "../src/state.js";
import type { Evidence, JobRecord } from "../src/types.js";
import { SCHEMA_VERSION } from "../src/types.js";
import { createTestWorkspace, enterExecutablePhase, writeExecutable } from "./fixture.js";

test("one Pi session cannot silently switch to a different TaskRecord", async () => {
  const located = await createTestWorkspace("pi-yocto-session-");
  const tasks = new TaskStore(located);
  const first = await tasks.create("first objective");
  const second = await tasks.create("second objective");
  const contexts = new TaskContextStore(located);
  const initial = await contexts.bind("session-one", first.id);
  assert.deepEqual(await contexts.bind("session-one", first.id), initial);
  await assert.rejects(() => contexts.bind("session-one", second.id), new RegExp(first.id));
  assert.equal(await contexts.active("session-one"), first.id);
});

test("required guest verification rejects host evidence and gates COMPLETED", async () => {
  const located = await createTestWorkspace("pi-yocto-verification-");
  const store = new TaskStore(located);
  let task = await store.create("verify guest behavior");
  await store.setVerificationContract(task.id, [{ id: "guest-smoke", description: "run self-test in guest", required: true, expectedDomain: "guest", expectedClaimType: "execution" }]);
  await store.setVerificationContract(task.id, [{ id: "guest-smoke", description: "run self-test in guest", required: true, expectedDomain: "guest", expectedClaimType: "execution" }]);
  const now = new Date().toISOString();
  const hostEvidence: Evidence = { id: "ev-host", kind: "command", executionDomain: "host", claimType: "execution", source: "/tmp/host.log", fact: "host command succeeded", confidence: "high", capturedAt: now, command: ["debugfs", "cat"], exitCode: 0 };
  task = await store.checkpoint(task.id, { objective: task.objective, phase: "INTAKE", modifiedFiles: [], evidenceIds: [hostEvidence.id], completedSteps: [], pendingSteps: ["guest smoke"], jobIds: [], logOffsets: {} }, [hostEvidence]);
  await assert.rejects(() => store.updateVerification(task.id, "guest-smoke", "PASSED", [hostEvidence.id]), /requires guest evidence/);
  for (const phase of ["INSPECTING", "PLANNING", "EXECUTING", "VERIFYING", "SUMMARIZING"] as const) task = await store.transition(task.id, phase);
  await assert.rejects(() => store.setVerificationContract(task.id, [{ id: "weaker", description: "host file exists", required: true, expectedDomain: "host" }]), /immutable after planning/);
  await assert.rejects(() => store.transition(task.id, "COMPLETED"), /required verification/);

  const guestJob: JobRecord = {
    schemaVersion: SCHEMA_VERSION, id: "job-qemu", taskId: task.id, kind: "qemu", purpose: "qemu", iteration: 1,
    fingerprint: "guest-fixture", executable: "runqemu", args: ["fixture"], cwd: located.config.buildDir, status: "STOPPED",
    createdAt: now, completedAt: now, logPath: new JobStore(located).logPath("job-qemu"), logOffset: 42, artifacts: []
  };
  await new JobStore(located).save(guestJob);
  const guestEvidence: Evidence = { id: "ev-guest", kind: "command", executionDomain: "guest", claimType: "execution", source: "guest-command:test", fact: "guest self-test succeeded", confidence: "high", capturedAt: now, command: ["validation-health", "--self-test"], exitCode: 0, jobId: "job-qemu" };
  task = await store.checkpoint(task.id, { objective: task.objective, phase: "SUMMARIZING", modifiedFiles: [], evidenceIds: [guestEvidence.id], completedSteps: ["guest smoke"], pendingSteps: [], jobIds: ["job-qemu"], logOffsets: { "job-qemu": 42 } }, [guestEvidence]);
  await store.updateVerification(task.id, "guest-smoke", "PASSED", [guestEvidence.id]);
  const completed = await store.checkpoint(task.id, { objective: task.objective, phase: "COMPLETED", modifiedFiles: [], evidenceIds: [guestEvidence.id], completedSteps: ["guest smoke", "summary"], pendingSteps: [], jobIds: ["job-qemu"], logOffsets: { "job-qemu": 42 }, finalSummary: "Guest self-test passed with exact command, output, and exit code evidence." });
  assert.equal(completed.phase, "COMPLETED");
  assert.match(completed.finalSummary ?? "", /exit code evidence/);
});

test("job fingerprints deduplicate recovery and fix iterations are enforced per target", async () => {
  const located = await createTestWorkspace("pi-yocto-job-budget-");
  await writeExecutable(join(located.config.sourceDir, "oe-init-build-env"), `export PATH="${located.binDir}:$PATH"\ncd "$1"\n`);
  await writeExecutable(join(located.binDir, "bitbake"), "#!/usr/bin/env bash\necho BB_NO_NETWORK=$BB_NO_NETWORK target=\"$*\"\nsleep 0.2\n");
  const task = await enterExecutablePhase(located, "bounded verification", "VERIFYING");
  await assert.rejects(() => startJob(located, { kind: "bitbake", purpose: "verification", taskId: task.id, args: ["demo"] }), /require a verification iteration/);
  await assert.rejects(() => startJob(located, { kind: "bitbake", purpose: "baseline", taskId: task.id, iteration: 1, args: ["demo"] }), /do not accept a verification iteration/);
  await assert.rejects(() => startJob(located, { kind: "bitbake", purpose: "verification", taskId: task.id, iteration: 2, args: ["demo"] }), /skips required iteration 1/);
  const first = await startJob(located, { kind: "bitbake", purpose: "verification", taskId: task.id, iteration: 1, args: ["demo"] });
  const duplicate = await startJob(located, { kind: "bitbake", purpose: "verification", taskId: task.id, iteration: 1, args: ["demo"] });
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.job.id, first.job.id);
  await assert.rejects(() => startJob(located, { kind: "bitbake", purpose: "verification", taskId: task.id, iteration: 1, args: ["demo", "-v"] }), /already recorded/);
  const jobs = new JobStore(located);
  let current = first.job;
  for (let attempt = 0; attempt < 50 && current.status !== "SUCCEEDED"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = await reconcileJob(jobs, first.job.id);
  }
  assert.equal(current.status, "SUCCEEDED");
  const confirmation = await startJob(located, { kind: "bitbake", purpose: "incremental-confirmation", taskId: task.id, args: ["demo"] });
  assert.equal(confirmation.reused, false);
  await assert.rejects(() => startJob(located, { kind: "bitbake", purpose: "verification", taskId: task.id, iteration: 3, args: ["demo"] }), /between 1 and 2/);
});
