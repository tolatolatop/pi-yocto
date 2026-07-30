import { spawn } from "node:child_process";
import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocatedConfig } from "./config.js";
import { newId, pathExists, readJson, sha256, withFileLock, writeJsonAtomic } from "./fs-utils.js";
import { workspaceIdentity } from "./contracts.js";
import { readBootId, readProcessStartTicks } from "./process.js";
import { validateBitbakeJobArgs } from "./policy.js";
import { TaskStore } from "./state.js";
import type { Evidence, JobKind, JobPurpose, JobRecord } from "./types.js";
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
}

export interface StartJobResult { job: JobRecord; reused: boolean; }

export async function startJob(located: LocatedConfig, input: StartJobInput): Promise<StartJobResult> {
  let executable: string;
  let args = [...input.args];
  if (input.kind === "bitbake") {
    validateBitbakeJobArgs(args);
    executable = "bitbake";
  } else if (input.kind === "qemu") {
    if (!args.length || args.some((arg) => !/^[A-Za-z0-9+_.:@/-]+$/.test(arg))) throw new Error("QEMU job arguments must be simple runqemu tokens");
    // The harness guest executor communicates through the serial console and
    // must not require root-owned TAP setup. Supply safe defaults when the
    // caller only names an image (or omits one of the required modes).
    if (!args.includes("nographic")) args.push("nographic");
    if (!args.includes("slirp")) args.push("slirp");
    executable = join(located.config.sourceDir, "scripts", "runqemu");
  } else {
    if (!args.length) args = ["-p"];
    if (args.some((arg) => !["-p", "--parse-only", "--version"].includes(arg))) throw new Error("Check jobs only support BitBake parse/version arguments");
    executable = "bitbake";
  }
  if (input.kind === "qemu" && input.purpose !== "qemu") throw new Error("QEMU jobs require purpose=qemu");
  if (input.kind === "check" && input.purpose !== "parse") throw new Error("Check jobs require purpose=parse");
  if (input.kind === "bitbake" && ["parse", "qemu"].includes(input.purpose)) throw new Error(`BitBake jobs cannot use purpose=${input.purpose}`);
  const iterativePurpose = ["verification", "parse", "qemu"].includes(input.purpose);
  if (iterativePurpose && input.iteration === undefined) throw new Error(`${input.purpose} jobs require a verification iteration`);
  if (!iterativePurpose && input.iteration !== undefined) throw new Error(`${input.purpose} jobs do not accept a verification iteration`);
  const taskStore = new TaskStore(located);
  const task = await taskStore.load(input.taskId);
  const target = args.filter((arg) => !arg.startsWith("-")).join(" ");
  if (input.purpose === "incremental-confirmation" && !task.verificationAttempts.some((attempt) => attempt.target === target && attempt.status === "SUCCEEDED")) {
    throw new Error(`Incremental confirmation requires a successful verification job for ${target}`);
  }
  const fingerprint = sha256(JSON.stringify({ taskId: input.taskId, kind: input.kind, purpose: input.purpose, iteration: input.iteration ?? null, executable, args, cwd: located.config.buildDir }));
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
      await taskStore.reserveJob(input.taskId, { jobId: id, purpose: input.purpose, fingerprint, target, ...(input.iteration !== undefined ? { iteration: input.iteration } : {}) });
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
