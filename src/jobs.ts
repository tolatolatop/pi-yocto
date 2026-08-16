import { spawn } from "node:child_process";
import { mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocatedConfig } from "./config.js";
import { newId, pathExists, readJson, sha256, withFileLock, writeJsonAtomic } from "./fs-utils.js";
import { workspaceIdentity } from "./contracts.js";
import { readBootId, readProcessStartTicks } from "./process.js";
import { validateBitbakeJobArgs } from "./policy.js";
import { TaskStore } from "./state.js";
import type { ChangeSetRecord, Evidence, JobKind, JobPurpose, JobRecord, TaskRecord } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class JobStore {
  constructor(readonly located: LocatedConfig) {}
  path(id: string): string { return join(this.located.stateDir, "jobs", `${id}.json`); }
  logPath(id: string): string { return join(this.located.stateDir, "jobs", `${id}.log`); }
  async load(id: string): Promise<JobRecord> {
    if (!(await pathExists(this.path(id)))) throw new Error(`Unknown job ${id}`);
    const raw = await readJson<JobRecord>(this.path(id));
    return {
      ...raw,
      taskId: raw.taskId ?? "legacy-unbound",
      purpose: raw.purpose ?? (raw.kind === "qemu" ? "qemu" : raw.kind === "check" ? "parse" : "verification"),
      fingerprint: raw.fingerprint ?? sha256(JSON.stringify({ taskId: raw.taskId ?? "legacy-unbound", kind: raw.kind, args: raw.args, cwd: raw.cwd }))
    };
  }
  async save(job: JobRecord): Promise<void> { await writeJsonAtomic(this.path(job.id), job); }
  async list(): Promise<JobRecord[]> {
    const dir = join(this.located.stateDir, "jobs");
    const names = await readdir(dir).catch(() => []);
    const jobs = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => this.load(name.slice(0, -5))));
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

function workerScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "worker.js");
}

export interface StartJobInput {
  kind: JobKind;
  args: string[];
  taskId: string;
  purpose: JobPurpose;
  iteration?: number;
  retryInterrupted?: boolean;
  sourceJobId?: string;
}

export interface StartJobResult { job: JobRecord; reused: boolean; }

const qemuModes = new Set(["nographic", "slirp", "kvm", "kvm-vhost", "serial", "snapshot"]);

function within(path: string, root: string): boolean {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}/`);
}

/** Resolve a recipe/image token to the deploy tree's current qemuboot.conf. */
export async function normalizeQemuArgs(located: LocatedConfig, input: string[]): Promise<string[]> {
  if (!input.length || input.some((argument) => !/^[A-Za-z0-9+_.:@/-]+$/.test(argument))) throw new Error("QEMU job arguments must be simple runqemu tokens");
  const deployDir = resolve(located.config.tmpDir ?? join(located.config.buildDir, "tmp"), "deploy", "images", located.config.machine);
  const modes = input.filter((argument) => qemuModes.has(argument));
  const selectors = input.filter((argument) => !qemuModes.has(argument) && argument !== located.config.machine);
  if (selectors.length > 1) throw new Error(`QEMU job accepts one image target or qemuboot.conf, not: ${selectors.join(", ")}`);

  let bootConfig: string | undefined;
  const selector = selectors[0];
  if (selector?.endsWith(".qemuboot.conf")) {
    const candidate = resolve(selector.includes("/") ? located.config.buildDir : deployDir, selector);
    if (!within(candidate, deployDir) || !(await pathExists(candidate))) throw new Error(`QEMU boot config is missing or outside ${deployDir}: ${candidate}`);
    const canonical = await realpath(candidate);
    if (!within(canonical, deployDir)) throw new Error(`QEMU boot config resolves outside ${deployDir}: ${candidate}`);
    bootConfig = candidate;
  } else if (selector) {
    const names = (await readdir(deployDir).catch(() => []))
      .filter((name) => name.startsWith(`${selector}-${located.config.machine}`) && name.endsWith(".qemuboot.conf"))
      .sort();
    const stableNames = names.filter((name) => name === `${selector}-${located.config.machine}.rootfs.qemuboot.conf` || name === `${selector}-${located.config.machine}.qemuboot.conf`);
    if (stableNames.length === 1) {
      const stable = join(deployDir, stableNames[0] as string);
      const canonical = await realpath(stable);
      if (!within(canonical, deployDir)) throw new Error(`QEMU boot config resolves outside ${deployDir}: ${stable}`);
      bootConfig = stable;
    } else {
      const canonical = new Map<string, string[]>();
      for (const name of names) {
        const path = join(deployDir, name);
        const target = await realpath(path).catch(() => path);
        canonical.set(target, [...(canonical.get(target) ?? []), path]);
      }
      if (canonical.size === 1) bootConfig = [...canonical.keys()][0];
      else {
        const detail = names.length ? names.map((name) => join(deployDir, name)).join(", ") : "none";
        throw new Error(`Expected one qemuboot.conf for image target ${selector} (${located.config.machine}); candidates: ${detail}`);
      }
    }
  }

  // A modes-only invocation remains supported for controlled test doubles and
  // legacy workspaces.  When a target was supplied, replace all guessed image
  // tokens (including MACHINE) with the exact deploy configuration.
  const normalized = bootConfig ? [bootConfig, ...modes] : [...input.filter((argument) => !qemuModes.has(argument)), ...modes];
  if (!normalized.includes("nographic")) normalized.push("nographic");
  if (!normalized.includes("slirp")) normalized.push("slirp");
  return normalized;
}

function bitbakeTargets(args: string[]): string[] {
  return args.filter((argument) => !argument.startsWith("-"));
}

/** Return only deploy artifacts whose basename is produced for this job's targets. */
export async function collectJobArtifacts(located: LocatedConfig, job: Pick<JobRecord, "kind" | "args">): Promise<string[]> {
  if (job.kind !== "bitbake") return [];
  const targets = bitbakeTargets(job.args);
  if (!targets.length) return [];
  const deploy = resolve(located.config.tmpDir ?? join(located.config.buildDir, "tmp"), "deploy");
  if (!(await pathExists(deploy))) return [];
  const matches: string[] = [];
  const pending = [deploy];
  while (pending.length && matches.length < 200) {
    const directory = pending.pop() as string;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if ((entry.isFile() || entry.isSymbolicLink()) && targets.some((target) => entry.name === target || entry.name.startsWith(`${target}-`) || entry.name.startsWith(`${target}_`) || entry.name.startsWith(`${target}.`))) matches.push(path);
    }
  }
  return matches.sort();
}

async function taskInputFingerprint(located: LocatedConfig, task: TaskRecord): Promise<string> {
  const applied: string[] = [];
  for (const id of task.changeSetIds) {
    const path = join(located.stateDir, "changes", `${id}.json`);
    if (!(await pathExists(path))) continue;
    const change = await readJson<ChangeSetRecord>(path);
    if (change.taskId === task.id && change.status === "APPLIED") applied.push(`${change.id}:${change.scopeHash}`);
  }
  return sha256(JSON.stringify({ applied: applied.sort(), inputs: (task.inputManifest ?? []).map((item) => `${item.id}:${item.sha256}`).sort() }));
}

export async function startJob(located: LocatedConfig, input: StartJobInput): Promise<StartJobResult> {
  const taskStore = new TaskStore(located);
  const task = await taskStore.load(input.taskId);
  let executable: string;
  let args = [...input.args];
  if (input.kind === "bitbake") {
    validateBitbakeJobArgs(args);
    executable = "bitbake";
  } else if (input.kind === "qemu") {
    if (!input.sourceJobId) throw new Error("QEMU jobs require sourceJobId bound to a successful image build JobRecord");
    const source = await reconcileJob(new JobStore(located), input.sourceJobId);
    if (source.taskId !== input.taskId || source.kind !== "bitbake" || source.purpose !== "verification" || source.status !== "SUCCEEDED") throw new Error(`QEMU source job must be a successful verification BitBake job in TaskRecord ${input.taskId}`);
    if (!task.jobIds.includes(source.id)) throw new Error(`QEMU source job ${source.id} is not attached to TaskRecord ${input.taskId}`);
    args = await normalizeQemuArgs(located, args);
    const bootConfig = args.find((argument) => argument.endsWith(".qemuboot.conf"));
    if (!bootConfig) throw new Error("QEMU jobs must resolve an exact qemuboot.conf from the source image job");
    const bootCanonical = await realpath(bootConfig).catch(() => resolve(bootConfig));
    const artifactCanonicals = new Set(await Promise.all(source.artifacts.map((artifact) => realpath(artifact).catch(() => resolve(artifact)))));
    if (!artifactCanonicals.has(bootCanonical)) throw new Error(`QEMU boot config is not an artifact of source job ${source.id}: ${bootConfig}`);
    const sourceTargets = bitbakeTargets(source.args);
    if (!sourceTargets.some((target) => bootConfig.split("/").at(-1)?.startsWith(`${target}-`))) throw new Error(`QEMU boot config does not match source job ${source.id} targets: ${sourceTargets.join(", ")}`);
    executable = join(located.config.sourceDir, "scripts", "runqemu");
  } else {
    if (!args.length) args = ["-p"];
    if (args.some((arg) => !["-p", "--parse-only", "--version"].includes(arg))) throw new Error("Check jobs only support BitBake parse/version arguments");
    executable = "bitbake";
  }
  if (input.kind === "qemu" && input.purpose !== "qemu") throw new Error("QEMU jobs require purpose=qemu");
  if (input.kind !== "qemu" && input.sourceJobId) throw new Error("sourceJobId is only valid for QEMU jobs");
  if (input.kind === "check" && input.purpose !== "parse") throw new Error("Check jobs require purpose=parse");
  if (input.kind === "bitbake" && ["parse", "qemu"].includes(input.purpose)) throw new Error(`BitBake jobs cannot use purpose=${input.purpose}`);
  const iterativePurpose = ["verification", "parse", "qemu"].includes(input.purpose);
  if (iterativePurpose && input.iteration === undefined) throw new Error(`${input.purpose} jobs require a verification iteration`);
  if (!iterativePurpose && input.iteration !== undefined) throw new Error(`${input.purpose} jobs do not accept a verification iteration`);
  const target = args.filter((arg) => !arg.startsWith("-")).join(" ");
  if (input.purpose === "incremental-confirmation") {
    let succeeded = false;
    const jobs = new JobStore(located);
    for (const attempt of task.verificationAttempts.filter((candidate) => candidate.target === target)) {
      const current = await reconcileJob(jobs, attempt.jobId);
      if (current.status === "SUCCEEDED") { succeeded = true; break; }
    }
    if (!succeeded) throw new Error(`Incremental confirmation requires a successful verification job for ${target}`);
  }
  const inputFingerprint = await taskInputFingerprint(located, task);
  const fingerprint = sha256(JSON.stringify({ taskId: input.taskId, kind: input.kind, purpose: input.purpose, iteration: input.iteration ?? null, sourceJobId: input.sourceJobId ?? null, executable, args, cwd: located.config.buildDir }));
  return withFileLock(join(located.stateDir, "job-start.lock"), async () => {
    const store = new JobStore(located);
    for (const candidate of (await store.list()).filter((job) => job.fingerprint === fingerprint)) {
      const current = await reconcileJob(store, candidate.id);
      if (current.status !== "INTERRUPTED" || !input.retryInterrupted) return { job: current, reused: true };
    }
    const id = newId("job");
    const now = new Date().toISOString();
    await mkdir(dirname(store.logPath(id)), { recursive: true });
    const record: JobRecord = {
      schemaVersion: SCHEMA_VERSION,
      id,
      workspaceId: workspaceIdentity(located),
      taskId: input.taskId,
      kind: input.kind,
      purpose: input.purpose,
      ...(input.sourceJobId ? { sourceJobId: input.sourceJobId } : {}),
      ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
      fingerprint,
      executable,
      args,
      cwd: located.config.buildDir,
      status: "QUEUED",
      createdAt: now,
      logPath: store.logPath(id),
      logOffset: 0,
      artifacts: [],
      resumeCommand: `pi-yocto job status ${id}; pi-yocto job logs ${id} --offset 0`
    };
    await store.save(record);
    try {
      await taskStore.reserveJob(input.taskId, { jobId: id, purpose: input.purpose, fingerprint, inputFingerprint, target, ...(input.iteration !== undefined ? { iteration: input.iteration } : {}) });
    } catch (error) {
      // A reservation rejection means the command never started. Do not leave a
      // synthetic FAILED JobRecord behind: it would be mistaken for a real
      // verification iteration and poison a later valid retry.
      await rm(store.path(id), { force: true });
      throw error;
    }
    const child = spawn(process.execPath, [workerScript(), "--root", located.rootDir, "--job", id], {
      cwd: located.rootDir,
      detached: true,
      stdio: "ignore",
      env: process.env,
      shell: false
    });
    child.unref();
    if (child.pid !== undefined) {
      record.pid = child.pid;
      record.processGroupId = child.pid;
      const ticks = await readProcessStartTicks(child.pid);
      const boot = await readBootId();
      if (ticks) record.processStartTicks = ticks;
      if (boot) record.bootId = boot;
    }
    await store.save(record);
    await taskStore.refreshJobCheckpoint(input.taskId, id);
    return { job: record, reused: false };
  });
}

export async function reconcileJob(store: JobStore, id: string): Promise<JobRecord> {
  const job = await store.load(id);
  if (["SUCCEEDED", "FAILED", "STOPPED", "INTERRUPTED"].includes(job.status) || !job.pid) return job;
  const bootId = await readBootId();
  const ticks = await readProcessStartTicks(job.pid);
  const sameProcess = bootId === job.bootId && ticks === job.processStartTicks && isAlive(job.pid);
  if (!sameProcess) {
    const interrupted: JobRecord = {
      ...job,
      status: "INTERRUPTED",
      completedAt: new Date().toISOString(),
      error: "Worker identity no longer matches (process exit, PID reuse, or host reboot). The job was not restarted automatically."
    };
    await store.save(interrupted);
    if (job.taskId !== "legacy-unbound") await new TaskStore(store.located).updateJobStatus(job.taskId, job.id, "INTERRUPTED", interrupted.completedAt).catch(() => undefined);
    return interrupted;
  }
  return job;
}

export async function tailJob(store: JobStore, id: string, options: { offset?: number; bytes?: number } = {}): Promise<{ job: JobRecord; offset: number; text: string }> {
  const job = await reconcileJob(store, id);
  const handle = await open(job.logPath, "r").catch(() => undefined);
  if (!handle) return { job, offset: 0, text: "" };
  try {
    const info = await handle.stat();
    const start = Math.min(options.offset ?? Math.max(0, info.size - (options.bytes ?? 64 * 1024)), info.size);
    const length = Math.min(info.size - start, options.bytes ?? 1024 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { job, offset: start + length, text: buffer.toString("utf8") };
  } finally { await handle.close(); }
}

export async function stopJob(store: JobStore, id: string): Promise<JobRecord> {
  const job = await reconcileJob(store, id);
  if (!job.pid || !job.processGroupId || !["QUEUED", "RUNNING"].includes(job.status)) return job;
  const stopping = { ...job, status: "STOPPING" as const };
  await store.save(stopping);
  try { process.kill(-job.processGroupId, "SIGTERM"); } catch (error) {
    const failed = { ...stopping, status: "INTERRUPTED" as const, error: error instanceof Error ? error.message : String(error) };
    await store.save(failed);
    return failed;
  }
  return stopping;
}

export function jobEvidence(job: JobRecord): Evidence | undefined {
  const exitCode = job.exitCode;
  if (exitCode === undefined || !Number.isInteger(exitCode) || !["SUCCEEDED", "FAILED"].includes(job.status)) return undefined;
  const command = [job.executable, ...job.args];
  return {
    id: `ev-${sha256(`${job.id}:${exitCode}:${job.logOffset}`).slice(0, 16)}`,
    kind: "command",
    executionDomain: job.kind === "qemu" ? "host" : "build",
    claimType: job.kind === "qemu" ? "execution" : "build",
    source: job.logPath,
    locator: `offset 0-${job.logOffset}`,
    fact: `${command.join(" ")} completed with status ${job.status} and exit code ${exitCode}`,
    confidence: "high",
    capturedAt: job.completedAt ?? new Date().toISOString(),
    command,
    exitCode,
    jobId: job.id,
    ...(job.workspaceId ? { workspaceId: job.workspaceId } : {})
  };
}

export function jobEvidenceVariants(job: JobRecord): Evidence[] {
  const primary = jobEvidence(job);
  if (!primary) return [];
  if (job.purpose !== "baseline") return [primary];
  return [primary, ...(["observation", "diagnosis"] as const).map((claimType) => ({
    ...primary,
    id: `ev-${sha256(`${job.id}:${job.exitCode}:${job.logOffset}:${claimType}`).slice(0, 16)}`,
    claimType,
    fact: `Baseline ${primary.command?.join(" ")} completed with status ${job.status} and exit code ${job.exitCode}; persisted log and artifacts support ${claimType}`
  }))];
}
