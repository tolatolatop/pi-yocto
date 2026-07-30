import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { findConfig } from "../src/config.js";
import { writeJsonAtomic } from "../src/fs-utils.js";
import { JobStore, reconcileJob, startJob, stopJob, tailJob } from "../src/jobs.js";
import { readBootId, runCommand } from "../src/process.js";
import { TaskStore } from "../src/state.js";
import type { JobRecord, WorkspaceConfig } from "../src/types.js";
import { SCHEMA_VERSION } from "../src/types.js";

async function fixture(): Promise<ReturnType<typeof findConfig>> {
  const root = await mkdtemp(join(tmpdir(), "pi-yocto-job-"));
  const sourceDir = join(root, "poky"); const buildDir = join(root, "build"); const binDir = join(root, "bin");
  await mkdir(join(root, ".pi"), { recursive: true }); await mkdir(join(root, ".pi-yocto", "jobs"), { recursive: true });
  await mkdir(sourceDir); await mkdir(buildDir); await mkdir(binDir);
  const init = join(sourceDir, "oe-init-build-env"); const fake = join(binDir, "bitbake");
  await writeFile(init, `export PATH="${binDir}:$PATH"\ncd "$1"\n`, "utf8");
  await writeFile(fake, "#!/usr/bin/env bash\necho fake-bitbake BB_NO_NETWORK=$BB_NO_NETWORK args=\"$*\" umask=\"$(umask)\"\nsleep 0.2\n", "utf8");
  await chmod(fake, 0o755);
  const config: WorkspaceConfig = { schemaVersion: SCHEMA_VERSION, sourceDir, buildDir, machine: "qemux86-64", distro: "poky", layers: [], offline: { bitbakeNoNetwork: true, blockExplicitNetworkCommands: true }, limits: { maxParallelAgents: 3, maxWorkflowDepth: 4, maxFixIterations: 2 } };
  await writeJsonAtomic(join(root, ".pi", "yocto.json"), config);
  return findConfig(root);
}

test("detached job survives launcher and is recovered from persisted identity/log", async () => {
  const located = await fixture();
  const taskStore = new TaskStore(located);
  let task = await taskStore.create("run detached smoke build");
  task = await taskStore.transition(task.id, "INSPECTING");
  task = await taskStore.transition(task.id, "PLANNING");
  task = await taskStore.transition(task.id, "EXECUTING");
  await taskStore.checkpoint(task.id, { objective: task.objective, phase: "EXECUTING", modifiedFiles: [], evidenceIds: [], completedSteps: ["prepared fake workspace"], pendingSteps: ["run build"], jobIds: [], logOffsets: {}, resumeAction: "resume smoke build" });
  const previousUmask = process.umask(0o077);
  const { job } = await startJob(located, { kind: "bitbake", purpose: "baseline", taskId: task.id, args: ["smoke"] }).finally(() => process.umask(previousUmask));
  const store = new JobStore(located);
  let current = job;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = await reconcileJob(store, job.id);
    if (["SUCCEEDED", "FAILED", "INTERRUPTED"].includes(current.status)) break;
  }
  assert.equal(current.status, "SUCCEEDED");
  assert.ok(current.logOffset > 0);
  const tailed = await tailJob(store, job.id);
  assert.match(tailed.text, /BB_NO_NETWORK=1/);
  assert.match(tailed.text, /args=smoke/);
  assert.match(tailed.text, /umask=0022/);
});

test("requested child umask is normalized without weakening the caller", async () => {
  const located = await fixture();
  const previous = process.umask(0o077);
  try {
    const result = await runCommand("bash", ["-c", "umask"], { cwd: located.rootDir, umask: 0o022 });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "0022");
    const observed = process.umask();
    assert.equal(observed, 0o077);
  } finally {
    process.umask(previous);
  }
});

test("a rejected reservation leaves no fake failed job and can retry iteration one", async () => {
  const located = await fixture();
  const tasks = new TaskStore(located);
  let task = await tasks.create("retry parse after phase correction");
  await assert.rejects(
    () => startJob(located, { kind: "check", purpose: "parse", taskId: task.id, iteration: 1, args: ["-p"] }),
    /must checkpoint into EXECUTING\/VERIFYING/
  );
  assert.deepEqual(await new JobStore(located).list(), []);
  for (const phase of ["INSPECTING", "PLANNING", "EXECUTING", "VERIFYING"] as const) task = await tasks.transition(task.id, phase);
  await tasks.checkpoint(task.id, { objective: task.objective, phase: "VERIFYING", modifiedFiles: [], evidenceIds: [], completedSteps: ["phase corrected"], pendingSteps: ["parse"], jobIds: [], logOffsets: {} });
  const { job } = await startJob(located, { kind: "check", purpose: "parse", taskId: task.id, iteration: 1, args: ["-p"] });
  const store = new JobStore(located);
  let current = job;
  for (let attempt = 0; attempt < 50 && !["SUCCEEDED", "FAILED", "INTERRUPTED"].includes(current.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = await reconcileJob(store, job.id);
  }
  assert.equal(current.status, "SUCCEEDED");
  assert.equal((await tasks.load(task.id)).currentFixIteration, 1);
});

test("PID reuse/start-tick mismatch is marked interrupted", async () => {
  const located = await fixture(); const store = new JobStore(located); const now = new Date().toISOString();
  const bootId = await readBootId();
  assert.ok(bootId);
  const record: JobRecord = { schemaVersion: SCHEMA_VERSION, id: "job-stale", taskId: "legacy-unbound", kind: "check", purpose: "parse", fingerprint: "stale-fingerprint", executable: "bitbake", args: ["--version"], cwd: located.config.buildDir, status: "RUNNING", pid: process.pid, processGroupId: process.pid, processStartTicks: "definitely-wrong", bootId, createdAt: now, startedAt: now, heartbeatAt: now, logPath: store.logPath("job-stale"), logOffset: 0, artifacts: [] };
  await store.save(record);
  assert.equal((await reconcileJob(store, record.id)).status, "INTERRUPTED");
});

test("stopping a worker persists STOPPED in both JobRecord and verification attempt", async () => {
  const located = await fixture();
  const fake = join(located.rootDir, "bin", "bitbake");
  await writeFile(fake, "#!/usr/bin/env bash\ntrap 'exit 143' TERM\necho running\nsleep 10\n", "utf8");
  await chmod(fake, 0o755);
  const tasks = new TaskStore(located);
  let task = await tasks.create("stop bounded verification");
  for (const phase of ["INSPECTING", "PLANNING", "EXECUTING", "VERIFYING"] as const) task = await tasks.transition(task.id, phase);
  await tasks.checkpoint(task.id, { objective: task.objective, phase: "VERIFYING", modifiedFiles: [], evidenceIds: [], completedSteps: ["prepared"], pendingSteps: ["stop job"], jobIds: [], logOffsets: {} });
  const started = await startJob(located, { kind: "bitbake", purpose: "verification", taskId: task.id, iteration: 1, args: ["smoke"] });
  const store = new JobStore(located);
  let current = started.job;
  for (let attempt = 0; attempt < 50 && current.status !== "RUNNING"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = await reconcileJob(store, current.id);
  }
  assert.equal(current.status, "RUNNING");
  await stopJob(store, current.id);
  for (let attempt = 0; attempt < 50 && !["STOPPED", "INTERRUPTED"].includes(current.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = await reconcileJob(store, current.id);
  }
  assert.equal(current.status, "STOPPED");
  assert.equal((await tasks.load(task.id)).verificationAttempts[0]?.status, "STOPPED");
});
