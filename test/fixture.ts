import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocatedConfig } from "../src/config.js";
import { writeJsonAtomic } from "../src/fs-utils.js";
import { TaskStore } from "../src/state.js";
import type { TaskRecord, WorkspaceConfig } from "../src/types.js";
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
