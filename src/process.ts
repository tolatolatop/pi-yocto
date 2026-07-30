import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceConfig } from "./types.js";

export interface CommandResult {
  command: string[];
  cwd: string;
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export async function runCommand(command: string, args: string[], options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  umask?: number;
}): Promise<CommandResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutput = options.maxOutputBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    // Node has no per-child umask option. The spawn itself is synchronous, so
    // temporarily changing the process umask here is atomic with respect to the
    // JavaScript event loop: the child inherits it at fork/exec and the caller's
    // restrictive umask is restored before any callback can run.
    const previousUmask = options.umask === undefined ? undefined : process.umask(options.umask);
    const child = (() => {
      try {
        return spawn(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false
        });
      } finally {
        if (previousUmask !== undefined) process.umask(previousUmask);
      }
    })();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string => {
      const joined = current + chunk.toString("utf8");
      return Buffer.byteLength(joined) > maxOutput ? joined.slice(-maxOutput) : joined;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        command: [command, ...args],
        cwd: options.cwd,
        code: code ?? 128,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut
      });
    });
  });
}

export async function captureBitbakeEnvironment(config: WorkspaceConfig): Promise<NodeJS.ProcessEnv> {
  const script = join(config.sourceDir, "oe-init-build-env");
  const snippet = 'set -a; source "$1" "$2" >/dev/null; env -0';
  const workspaceRoot = dirname(config.sourceDir);
  const privateLocale = join(workspaceRoot, "cache", "tools", "locale-root", "usr", "lib", "locale");
  const privateTools = join(workspaceRoot, "cache", "tools", "root", "usr", "bin");
  const bootstrapEnv: NodeJS.ProcessEnv = { ...process.env };
  const systemPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  if (existsSync(privateLocale)) {
    bootstrapEnv.LOCPATH = privateLocale;
    bootstrapEnv.LANG = "en_US.UTF-8";
    bootstrapEnv.LC_ALL = "en_US.UTF-8";
    bootstrapEnv.BB_ENV_PASSTHROUGH_ADDITIONS = `${bootstrapEnv.BB_ENV_PASSTHROUGH_ADDITIONS ? `${bootstrapEnv.BB_ENV_PASSTHROUGH_ADDITIONS} ` : ""}LOCPATH`.trim();
  }
  bootstrapEnv.PATH = existsSync(privateTools) ? `${privateTools}:${systemPath}` : systemPath;
  const result = await runCommand("bash", ["-c", snippet, "pi-yocto-env", script, config.buildDir], {
    cwd: config.sourceDir,
    env: bootstrapEnv,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024 * 1024,
    umask: 0o022
  });
  if (result.code !== 0) throw new Error(`Unable to load BitBake environment: ${result.stderr || result.stdout}`);
  const env: NodeJS.ProcessEnv = {};
  for (const item of result.stdout.split("\0")) {
    const separator = item.indexOf("=");
    if (separator > 0) env[item.slice(0, separator)] = item.slice(separator + 1);
  }
  if (config.offline.bitbakeNoNetwork) env.BB_NO_NETWORK = "1";
  env.PATCHRESOLVE = "noop";
  return env;
}

export async function readProcessStartTicks(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return tail[19];
  } catch {
    return undefined;
  }
}

export async function readBootId(): Promise<string | undefined> {
  return readFile("/proc/sys/kernel/random/boot_id", "utf8").then((value) => value.trim()).catch(() => undefined);
}
