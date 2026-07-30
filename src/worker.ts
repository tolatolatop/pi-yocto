#!/usr/bin/env node
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { findConfig } from "./config.js";
import { GuestCommandStore, quoteGuestArg } from "./guest.js";
import { JobStore } from "./jobs.js";
import { captureBitbakeEnvironment, readBootId, readProcessStartTicks } from "./process.js";
import type { JobRecord } from "./types.js";
import type { GuestCommandRecord } from "./types.js";
import { inspectWorkspace } from "./workspace.js";
import { TaskStore } from "./state.js";

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  // BitBake's sanity checker requires files produced by the worker to remain
  // traversable by the build group.  Detached workers must not inherit a
  // caller-specific restrictive umask (for example 0077 from a secret setup).
  process.umask(0o022);
  const located = await findConfig(arg("--root"));
  const store = new JobStore(located);
  let job = await store.load(arg("--job"));
  const log = await open(job.logPath, "a");
  let child: ReturnType<typeof spawn> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let guestPoll: NodeJS.Timeout | undefined;
  let stopping = false;
  const guestStore = new GuestCommandStore(located);
  let activeGuest: GuestCommandRecord | undefined;
  let guestStage: "idle" | "await-prompt" | "command" = "idle";
  let serialBuffer = "";
  const save = async (patch: Partial<JobRecord>): Promise<void> => {
    job = { ...job, ...patch };
    await store.save(job);
  };
  const write = async (message: string): Promise<void> => { await log.write(message); };
  const shutdown = async (): Promise<void> => {
    stopping = true;
    child?.kill("SIGTERM");
    const completedAt = new Date().toISOString();
    await write(`\n[pi-yocto] completed status=STOPPED signal=SIGTERM\n`).catch(() => undefined);
    const logOffset = await log.stat().then((info) => info.size).catch(() => job.logOffset);
    await save({ status: "STOPPED", completedAt, heartbeatAt: completedAt, signal: "SIGTERM", logOffset }).catch(() => undefined);
    await new TaskStore(located).updateJobStatus(job.taskId, job.id, "STOPPED", completedAt).catch(() => undefined);
    if (activeGuest) await guestStore.complete(activeGuest.id, { status: "FAILED", output: serialBuffer, error: "QEMU job stopped before command completion" }).catch(() => undefined);
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
  try {
    const env = await captureBitbakeEnvironment(located.config);
    const processStartTicks = await readProcessStartTicks(process.pid);
    const bootId = await readBootId();
    await save({
      status: "RUNNING",
      pid: process.pid,
      processGroupId: process.pid,
      ...(processStartTicks ? { processStartTicks } : {}),
      ...(bootId ? { bootId } : {}),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    });
    await new TaskStore(located).updateJobStatus(job.taskId, job.id, "RUNNING").catch(() => undefined);
    await write(`[pi-yocto] ${job.startedAt} cwd=${job.cwd} offline=${env.BB_NO_NETWORK === "1"} command=${JSON.stringify([job.executable, ...job.args])}\n`);
    heartbeat = setInterval(() => { void save({ heartbeatAt: new Date().toISOString() }); }, 5_000);
    child = spawn(job.executable, job.args, { cwd: job.cwd, env, stdio: [job.kind === "qemu" ? "pipe" : "ignore", "pipe", "pipe"], shell: false });
    const sendGuestCommand = (): void => {
      if (!activeGuest || !child?.stdin) return;
      const begin = `__PI_YOCTO_${activeGuest.id.replace(/[^A-Za-z0-9]/g, "_")}_BEGIN__`;
      const exit = `__PI_YOCTO_${activeGuest.id.replace(/[^A-Za-z0-9]/g, "_")}_EXIT__`;
      const command = activeGuest.argv.map(quoteGuestArg).join(" ");
      child.stdin.write(`printf '\\n${begin}\\n'; ${command}; pi_yocto_rc=$?; printf '\\n${exit}=%s\\n' "$pi_yocto_rc"\n`);
      guestStage = "command";
      serialBuffer = "";
    };
    const processSerial = async (chunk: Buffer): Promise<void> => {
      await log.write(chunk);
      if (job.kind !== "qemu") return;
      serialBuffer = `${serialBuffer}${chunk.toString("utf8").replace(/\r/g, "")}`.slice(-2_000_000);
      if (!activeGuest) return;
      if (guestStage === "await-prompt") {
        if (/(?:^|\n)[^\n]*login:\s*$/i.test(serialBuffer)) {
          child?.stdin?.write("root\n");
          serialBuffer = "";
          return;
        }
        if (/(?:^|\n)[^\n]*Password:\s*$/i.test(serialBuffer)) {
          await guestStore.complete(activeGuest.id, { status: "FAILED", output: serialBuffer, error: "Guest root login requested a password" });
          activeGuest = undefined;
          guestStage = "idle";
          return;
        }
        if (/(?:^|\n)[^\n]*[#$]\s*$/.test(serialBuffer)) sendGuestCommand();
        return;
      }
      if (guestStage === "command") {
        const token = activeGuest.id.replace(/[^A-Za-z0-9]/g, "_");
        const begin = `__PI_YOCTO_${token}_BEGIN__`;
        const exit = `__PI_YOCTO_${token}_EXIT__`;
        const beginMatch = serialBuffer.match(new RegExp(`(?:^|\\n)${begin}\\n`));
        const exitMatch = serialBuffer.match(new RegExp(`(?:^|\\n)${exit}=(\\d+)(?:\\n|$)`));
        if (beginMatch?.index !== undefined && exitMatch?.index !== undefined && exitMatch.index > beginMatch.index) {
          const outputStart = beginMatch.index + beginMatch[0].length;
          const output = serialBuffer.slice(outputStart, exitMatch.index).replace(/^\n|\n$/g, "");
          const exitCode = Number(exitMatch[1]);
          await guestStore.complete(activeGuest.id, { status: exitCode === 0 ? "SUCCEEDED" : "FAILED", output, exitCode, ...(exitCode === 0 ? {} : { error: `Guest command exited ${exitCode}` }) });
          activeGuest = undefined;
          guestStage = "idle";
          serialBuffer = serialBuffer.slice(exitMatch.index + exitMatch[0].length);
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => { void processSerial(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { void log.write(chunk); });
    if (job.kind === "qemu") {
      let polling = false;
      guestPoll = setInterval(() => {
        if (polling) return;
        polling = true;
        void (async () => {
          if (activeGuest) {
            const startedAt = Date.parse(activeGuest.startedAt ?? activeGuest.createdAt);
            if (Date.now() - startedAt > activeGuest.timeoutMs) {
              await guestStore.complete(activeGuest.id, { status: "TIMED_OUT", output: serialBuffer, error: `Guest command timed out after ${activeGuest.timeoutMs}ms` });
              activeGuest = undefined;
              guestStage = "idle";
            }
            return;
          }
          activeGuest = await guestStore.claimNext(job.id);
          if (activeGuest) {
            guestStage = "await-prompt";
            serialBuffer = "";
            child?.stdin?.write("\n");
          }
        })().finally(() => { polling = false; });
      }, 250);
    }
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child?.once("error", reject);
      child?.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (stopping) return;
    const status = result.code === 0 ? "SUCCEEDED" : "FAILED";
    await write(`\n[pi-yocto] completed status=${status} exit=${result.code ?? "null"} signal=${result.signal ?? "none"}\n`);
    const logOffset = (await log.stat()).size;
    const artifacts = status === "SUCCEEDED" ? (await inspectWorkspace(located, false)).artifacts : [];
    await save({ status, exitCode: result.code ?? 128, ...(result.signal ? { signal: result.signal } : {}), completedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), logOffset, artifacts });
    await new TaskStore(located).updateJobStatus(job.taskId, job.id, status, job.completedAt).catch(() => undefined);
    if (activeGuest) await guestStore.complete(activeGuest.id, { status: "FAILED", output: serialBuffer, error: `QEMU exited before guest command completed (${result.code ?? result.signal ?? "unknown"})` }).catch(() => undefined);
  } catch (error) {
    await write(`\n[pi-yocto] worker error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`).catch(() => undefined);
    await save({ status: "FAILED", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() }).catch(() => undefined);
    await new TaskStore(located).updateJobStatus(job.taskId, job.id, "FAILED", job.completedAt).catch(() => undefined);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (guestPoll) clearInterval(guestPoll);
    await log.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
