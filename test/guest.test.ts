import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { guestCommandEvidence, queueGuestCommand, waitForGuestCommand } from "../src/guest.js";
import { JobStore, reconcileJob, startJob } from "../src/jobs.js";
import { createTestWorkspace, enterExecutablePhase, writeExecutable } from "./fixture.js";

test("QEMU serial executor captures guest output and exact sentinel exit code", async () => {
  const located = await createTestWorkspace("pi-yocto-guest-");
  await mkdir(join(located.config.sourceDir, "scripts"), { recursive: true });
  await writeExecutable(join(located.config.sourceDir, "oe-init-build-env"), "cd \"$1\"\n");
  await writeExecutable(join(located.config.sourceDir, "scripts", "runqemu"), "#!/usr/bin/env bash\nprintf 'login: '\nIFS= read -r _\nprintf '# '\nIFS= read -r guest_line\neval \"$guest_line\"\nsleep 0.5\n");
  const task = await enterExecutablePhase(located, "guest command", "VERIFYING");
  const started = await startJob(located, { kind: "qemu", purpose: "qemu", taskId: task.id, iteration: 1, args: ["nographic"] });
  assert.deepEqual(started.job.args, ["nographic", "slirp"]);
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
