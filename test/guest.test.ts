import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { guestAssertionArgv, guestAssertionEvidence, guestCommandEvidence, queueGuestCommand, waitForGuestCommand } from "../src/guest.js";
import { JobStore, reconcileJob, startJob } from "../src/jobs.js";
import { createTestWorkspace, enterExecutablePhase, recordSuccessfulImageJob, writeExecutable } from "./fixture.js";

test("QEMU serial executor captures guest output and exact sentinel exit code", async () => {
  const located = await createTestWorkspace("pi-yocto-guest-");
  await mkdir(join(located.config.sourceDir, "scripts"), { recursive: true });
  await writeExecutable(join(located.config.sourceDir, "oe-init-build-env"), "cd \"$1\"\n");
  await writeExecutable(join(located.config.sourceDir, "scripts", "runqemu"), "#!/usr/bin/env bash\nprintf 'login: '\nIFS= read -r _\nprintf '# '\nIFS= read -r guest_line\neval \"$guest_line\"\nsleep 0.5\n");
  const task = await enterExecutablePhase(located, "guest command", "VERIFYING");
  const source = await recordSuccessfulImageJob(located, task.id);
  const started = await startJob(located, { kind: "qemu", purpose: "qemu", taskId: task.id, iteration: 1, sourceJobId: source.id, args: ["test-image"] });
  assert.equal(started.job.args[0], source.artifacts[0]);
  assert.deepEqual(started.job.args.slice(1), ["nographic", "slirp"]);
  const jobs = new JobStore(located);
  let qemu = started.job;
  for (let attempt = 0; attempt < 50 && qemu.status !== "RUNNING"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    qemu = await reconcileJob(jobs, qemu.id);
  }
  assert.equal(qemu.status, "RUNNING");
  const queued = await queueGuestCommand(located, { taskId: task.id, jobId: qemu.id, argv: ["printf", "%s", "guest value 'quoted'"], timeoutMs: 3_000 });
  const completed = await waitForGuestCommand(located, queued.id);
  assert.equal(completed.status, "SUCCEEDED");
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.output, "guest value 'quoted'");
  const evidence = guestCommandEvidence(completed);
  assert.equal(evidence.executionDomain, "guest");
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.jobId, qemu.id);
  await assert.rejects(() => queueGuestCommand(located, { taskId: task.id, jobId: qemu.id, argv: ["/bin/rm", "-rf", "/"] }), /not allowed/);
});

test("structured guest assertions avoid shell pipes and report predicate failures", () => {
  assert.deepEqual(guestAssertionArgv({ kind: "gzip-contains", path: "/proc/config.gz", value: "CONFIG_TEST=y" }), ["zgrep", "-F", "-m", "1", "CONFIG_TEST=y", "/proc/config.gz"]);
  const now = new Date().toISOString();
  const record = {
    schemaVersion: "1.0.0" as const, id: "guest-assert", taskId: "task", jobId: "job", argv: ["readlink", "/usr/bin/tool"],
    status: "SUCCEEDED" as const, createdAt: now, completedAt: now, timeoutMs: 1000, output: "tool.full\n", exitCode: 0
  };
  assert.equal(guestAssertionEvidence(record, { kind: "symlink-target", path: "/usr/bin/tool", value: "tool.full" }).exitCode, 0);
  assert.equal(guestAssertionEvidence(record, { kind: "symlink-target", path: "/usr/bin/tool", value: "tool.minimal" }).exitCode, 1);
});
