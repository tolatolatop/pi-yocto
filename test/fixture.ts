import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocatedConfig } from "../src/config.js";
import { writeJsonAtomic } from "../src/fs-utils.js";
import { JobStore } from "../src/jobs.js";
import { TaskStore } from "../src/state.js";
import type { JobRecord, TaskRecord, WorkspaceConfig } from "../src/types.js";
import { SCHEMA_VERSION } from "../src/types.js";

export interface TestWorkspace extends LocatedConfig {
  layerDir: string;
  binDir: string;
}

export async function createTestWorkspace(prefix = "pi-yocto-test-"): Promise<TestWorkspace> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  const sourceDir = join(rootDir, "poky");
  const buildDir = join(rootDir, "build");
  const layerDir = join(rootDir, "meta-test");
  const binDir = join(rootDir, "bin");
  await Promise.all([sourceDir, buildDir, layerDir, binDir, join(rootDir, ".pi")].map((path) => mkdir(path, { recursive: true })));
  const config: WorkspaceConfig = {
    schemaVersion: SCHEMA_VERSION,
    sourceDir,
    buildDir,
    machine: "qemux86-64",
    distro: "poky",
    layers: [layerDir],
    offline: { bitbakeNoNetwork: true, blockExplicitNetworkCommands: true },
    limits: { maxParallelAgents: 3, maxWorkflowDepth: 4, maxFixIterations: 2 }
  };
  const configPath = join(rootDir, ".pi", "yocto.json");
  await writeJsonAtomic(configPath, config);
  return { rootDir, configPath, stateDir: join(rootDir, ".pi-yocto"), config, layerDir, binDir };
}

export async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

export async function enterExecutablePhase(located: LocatedConfig, objective = "test task", phase: "EXECUTING" | "VERIFYING" = "EXECUTING"): Promise<TaskRecord> {
  const store = new TaskStore(located);
  let task = await store.create(objective);
  task = await store.transition(task.id, "INSPECTING");
  task = await store.transition(task.id, "PLANNING");
  task = await store.transition(task.id, "EXECUTING");
  if (phase === "VERIFYING") task = await store.transition(task.id, "VERIFYING");
  return store.checkpoint(task.id, { objective, phase, modifiedFiles: [], evidenceIds: [], completedSteps: ["prepared"], pendingSteps: ["verify"], jobIds: [], logOffsets: {}, resumeAction: "resume verification" });
}

export async function recordSuccessfulImageJob(located: LocatedConfig, taskId: string, target = "test-image"): Promise<JobRecord> {
  const deploy = join(located.config.tmpDir ?? join(located.config.buildDir, "tmp"), "deploy", "images", located.config.machine);
  const bootConfig = join(deploy, `${target}-${located.config.machine}.rootfs.qemuboot.conf`);
  await mkdir(deploy, { recursive: true });
  await writeFile(bootConfig, "QB_SYSTEM_NAME = qemu-system-x86_64\n", "utf8");
  const store = new JobStore(located);
  const now = new Date().toISOString();
  const id = `job-source-${target}`;
  const record: JobRecord = {
    schemaVersion: SCHEMA_VERSION,
    id,
    taskId,
    kind: "bitbake",
    purpose: "verification",
    iteration: 1,
    fingerprint: `fixture-${target}`,
    executable: "bitbake",
    args: [target],
    cwd: located.config.buildDir,
    status: "SUCCEEDED",
    createdAt: now,
    startedAt: now,
    completedAt: now,
    exitCode: 0,
    logPath: store.logPath(id),
    logOffset: 1,
    artifacts: [bootConfig]
  };
  await mkdir(join(located.stateDir, "jobs"), { recursive: true });
  await writeFile(record.logPath, "ok\n", "utf8");
  await store.save(record);
  const tasks = new TaskStore(located);
  const task = await tasks.load(taskId);
  await tasks.save({ ...task, jobIds: [...new Set([...task.jobIds, id])] });
  return record;
}
