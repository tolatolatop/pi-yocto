import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { LocatedConfig } from "./config.js";
import { newId, pathExists, readJson, sha256, withFileLock, writeJsonAtomic } from "./fs-utils.js";
import { JobStore, reconcileJob } from "./jobs.js";
import type { Evidence, GuestCommandRecord } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const deniedExecutables = new Set([
  "root", "rm", "dd", "mkfs", "reboot", "poweroff", "shutdown", "halt", "mount", "umount", "curl", "wget", "nc", "sh", "bash",
  "ash", "dash", "busybox", "env", "xargs", "find", "sed", "awk", "perl", "python", "python3", "ruby", "lua", "tee", "cp", "mv", "touch",
  "chmod", "chown", "kill", "pkill", "systemctl", "service", "modprobe", "insmod", "rmmod", "opkg", "rpm", "dnf", "apt", "apt-get"
]);

export function quoteGuestArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class GuestCommandStore {
  constructor(private readonly located: LocatedConfig) {}
  path(id: string): string { return join(this.located.stateDir, "guest", `${id}.json`); }
  async load(id: string): Promise<GuestCommandRecord> {
    if (!(await pathExists(this.path(id)))) throw new Error(`Unknown guest command ${id}`);
    return readJson<GuestCommandRecord>(this.path(id));
  }
  async save(record: GuestCommandRecord): Promise<void> { await writeJsonAtomic(this.path(record.id), record); }
  async list(): Promise<GuestCommandRecord[]> {
    const dir = join(this.located.stateDir, "guest");
    const names = await readdir(dir).catch(() => []);
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => this.load(name.slice(0, -5))));
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async claimNext(jobId: string): Promise<GuestCommandRecord | undefined> {
    return withFileLock(join(this.located.stateDir, `guest-${jobId}.lock`), async () => {
      const queued = (await this.list()).find((record) => record.jobId === jobId && record.status === "QUEUED");
      if (!queued) return undefined;
      const running: GuestCommandRecord = { ...queued, status: "RUNNING", startedAt: new Date().toISOString() };
      await this.save(running);
      return running;
    });
  }
  async complete(id: string, patch: Pick<GuestCommandRecord, "status" | "output"> & Partial<Pick<GuestCommandRecord, "exitCode" | "error">>): Promise<GuestCommandRecord> {
    return withFileLock(`${this.path(id)}.lock`, async () => {
      const record = await this.load(id);
      const raw = patch.output;
      const outputBytes = Buffer.byteLength(raw);
      const outputSha256 = sha256(raw);
      const controlCount = [...raw].filter((character) => character === "\ufffd" || (/\p{Cc}/u.test(character) && !["\n", "\r", "\t"].includes(character))).length;
      const binary = raw.includes("\0") || raw.includes("\ufffd") || controlCount > Math.max(1, raw.length * 0.02);
      const oversized = outputBytes > 64 * 1024;
      let output = raw;
      let outputArtifact: string | undefined;
      if (binary || oversized) {
        const directory = join(this.located.stateDir, "guest", "artifacts");
        await mkdir(directory, { recursive: true });
        outputArtifact = join(directory, `${id}.${binary ? "bin" : "txt"}`);
        await writeFile(outputArtifact, Buffer.from(raw, "utf8"));
        output = binary
          ? `[binary guest output stored as artifact; bytes=${outputBytes}; sha256=${outputSha256}]`
          : `${raw.slice(0, 32 * 1024)}\n[...truncated; full output: ${outputArtifact}]\n${raw.slice(-32 * 1024)}`;
      }
      const completed: GuestCommandRecord = {
        ...record, ...patch, output, outputType: binary ? "binary" : "text", outputBytes, outputSha256,
        ...(outputArtifact ? { outputArtifact } : {}), ...((binary || oversized) ? { outputTruncated: true } : {}),
        completedAt: new Date().toISOString()
      };
      await this.save(completed);
      return completed;
    });
  }
}

export async function queueGuestCommand(located: LocatedConfig, input: { taskId: string; jobId: string; argv: string[]; timeoutMs?: number }): Promise<GuestCommandRecord> {
  if (!input.argv.length || input.argv.length > 32) throw new Error("Guest command requires 1-32 argv entries");
  if (input.argv.some((argument) => !argument || argument.length > 4096 || /[\0\r\n]/.test(argument))) throw new Error("Guest command arguments must be non-empty, single-line strings");
  if (deniedExecutables.has(basename(input.argv[0] ?? ""))) throw new Error(`Guest executable is not allowed for verification: ${input.argv[0]}`);
  const jobs = new JobStore(located);
  const job = await reconcileJob(jobs, input.jobId);
  if (job.kind !== "qemu" || job.status !== "RUNNING") throw new Error(`Guest commands require a RUNNING QEMU job; ${job.id} is ${job.kind}/${job.status}`);
  if (job.taskId !== input.taskId) throw new Error("Guest command task/job binding mismatch");
  const record: GuestCommandRecord = {
    schemaVersion: SCHEMA_VERSION,
    id: newId("guest"),
    taskId: input.taskId,
    jobId: input.jobId,
    argv: input.argv,
    status: "QUEUED",
    createdAt: new Date().toISOString(),
    timeoutMs: Math.min(Math.max(input.timeoutMs ?? 120_000, 1_000), 300_000),
    output: ""
  };
  await new GuestCommandStore(located).save(record);
  return record;
}

export async function waitForGuestCommand(located: LocatedConfig, id: string, signal?: AbortSignal): Promise<GuestCommandRecord> {
  const store = new GuestCommandStore(located);
  const initial = await store.load(id);
  const deadline = Date.now() + initial.timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error(`Guest command ${id} was aborted`);
    const current = await store.load(id);
    if (["SUCCEEDED", "FAILED", "TIMED_OUT"].includes(current.status)) return current;
    if (Date.now() >= deadline) return store.complete(id, { status: "TIMED_OUT", output: current.output, error: `No guest sentinel before ${initial.timeoutMs}ms` });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function guestCommandEvidence(record: GuestCommandRecord): Evidence {
  const exitCode = record.exitCode ?? 124;
  return {
    id: `ev-${sha256(`${record.id}:${exitCode}:${record.output}`).slice(0, 16)}`,
    kind: "command",
    executionDomain: "guest",
    claimType: "execution",
    source: `guest-command:${record.id}`,
    locator: `qemu job ${record.jobId}`,
    fact: `Guest command ${JSON.stringify(record.argv)} completed with exit code ${exitCode}; output=${record.outputType ?? "text"}${record.outputArtifact ? ` artifact=${record.outputArtifact}` : ""}`,
    confidence: record.status === "SUCCEEDED" || record.status === "FAILED" ? "high" : "low",
    capturedAt: record.completedAt ?? new Date().toISOString(),
    sha256: record.outputSha256 ?? sha256(record.output),
    command: record.argv,
    exitCode,
    jobId: record.jobId
  };
}

export type GuestAssertionInput =
  | { kind: "file-exists" | "file-absent"; path: string }
  | { kind: "gzip-contains" | "symlink-target"; path: string; value: string }
  | { kind: "command-output"; argv: string[]; value: string; match?: "contains" | "equals" };

export function guestAssertionArgv(input: GuestAssertionInput): string[] {
  if ("path" in input && (!input.path.startsWith("/") || /[\0\r\n]/.test(input.path))) throw new Error("Guest assertion paths must be absolute single-line paths");
  switch (input.kind) {
    case "file-exists": return ["test", "-e", input.path];
    case "file-absent": return ["test", "!", "-e", input.path];
    case "gzip-contains":
      if (!input.value || /[\0\r\n]/.test(input.value)) throw new Error("gzip-contains requires a single-line fixed string");
      return ["zgrep", "-F", "-m", "1", input.value, input.path];
    case "symlink-target":
      if (!input.value || /[\0\r\n]/.test(input.value)) throw new Error("symlink-target requires an expected target");
      return ["readlink", input.path];
    case "command-output":
      if (!input.value || !input.argv.length) throw new Error("command-output requires argv and an expected value");
      return input.argv;
  }
}

export function guestAssertionEvidence(record: GuestCommandRecord, assertion: GuestAssertionInput): Evidence {
  const commandSucceeded = record.status === "SUCCEEDED" && record.exitCode === 0;
  const output = record.output.trimEnd();
  let passed = commandSucceeded;
  if (assertion.kind === "symlink-target") passed = commandSucceeded && output === assertion.value;
  if (assertion.kind === "command-output") passed = commandSucceeded && (assertion.match === "equals" ? output === assertion.value : output.includes(assertion.value));
  let expected: string;
  switch (assertion.kind) {
    case "file-exists": expected = `file exists: ${assertion.path}`; break;
    case "file-absent": expected = `file absent: ${assertion.path}`; break;
    case "gzip-contains": expected = `${assertion.path} gzip content includes ${JSON.stringify(assertion.value)}`; break;
    case "symlink-target": expected = `${assertion.path} points to ${JSON.stringify(assertion.value)}`; break;
    case "command-output": expected = `command output ${assertion.match === "equals" ? "equals" : "contains"} ${JSON.stringify(assertion.value)}`; break;
  }
  const exitCode = passed ? 0 : 1;
  return {
    id: `ev-${sha256(`${record.id}:${JSON.stringify(assertion)}:${exitCode}:${record.outputSha256 ?? sha256(record.output)}`).slice(0, 16)}`,
    kind: "command",
    executionDomain: "guest",
    claimType: "behavior",
    source: `guest-assertion:${record.id}`,
    locator: `qemu job ${record.jobId}`,
    fact: `Guest assertion ${expected} ${passed ? "PASSED" : "FAILED"}; command exit=${record.exitCode ?? "missing"}`,
    confidence: record.status === "SUCCEEDED" || record.status === "FAILED" ? "high" : "low",
    capturedAt: record.completedAt ?? new Date().toISOString(),
    sha256: record.outputSha256 ?? sha256(record.output),
    command: record.argv,
    exitCode,
    jobId: record.jobId
  };
}
