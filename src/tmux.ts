import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SESSION_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_CAPTURE_BYTES = 256 * 1024;

export type TmuxKey = "C-c" | "C-d" | "Enter" | "Escape" | "Tab" | "Up" | "Down" | "Left" | "Right";

export interface TmuxPaneState {
  session: string;
  target: string;
  window: string;
  pane: string;
  command: string;
  cwd: string;
  dead: boolean;
  output: string;
}

export function validateTmuxSessionName(name: string): string {
  if (!SESSION_RE.test(name)) throw new Error("tmux session name must match [A-Za-z0-9_.-]{1,64}");
  return name;
}

function targetFor(session: string): string { return `${validateTmuxSessionName(session)}:0.0`; }

async function tmux(args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tmux", args, {
      encoding: "utf8", maxBuffer: MAX_CAPTURE_BYTES, ...(signal ? { signal } : {})
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`tmux ${args[0] ?? "command"} failed: ${detail}`);
  }
}

export async function requireTmuxSession(session: string, signal?: AbortSignal): Promise<string> {
  const target = targetFor(session);
  await tmux(["has-session", "-t", session], signal);
  await tmux(["display-message", "-p", "-t", target, "#{pane_id}"], signal);
  return target;
}

export async function captureTmuxPane(session: string, lines = 200, signal?: AbortSignal): Promise<TmuxPaneState> {
  if (!Number.isInteger(lines) || lines < 1 || lines > 2000) throw new Error("capture lines must be an integer from 1 to 2000");
  const target = await requireTmuxSession(session, signal);
  const metadata = (await tmux(["display-message", "-p", "-t", target,
    "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_dead}"], signal)).trimEnd().split("\t");
  const output = await tmux(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", target], signal);
  return {
    session: metadata[0] ?? session, target, window: metadata[1] ?? "0", pane: metadata[2] ?? "0",
    command: metadata[3] ?? "", cwd: metadata[4] ?? "", dead: metadata[5] === "1", output
  };
}

export async function sendTmuxText(session: string, text: string, submit = true, signal?: AbortSignal): Promise<TmuxPaneState> {
  if (!text || text.length > 16384 || text.includes("\0")) throw new Error("tmux text must contain 1..16384 characters and no NUL");
  const target = await requireTmuxSession(session, signal);
  await tmux(["send-keys", "-t", target, "-l", "--", text], signal);
  if (submit) await tmux(["send-keys", "-t", target, "Enter"], signal);
  return captureTmuxPane(session, 200, signal);
}

export async function sendTmuxKey(session: string, key: TmuxKey, signal?: AbortSignal): Promise<TmuxPaneState> {
  const target = await requireTmuxSession(session, signal);
  await tmux(["send-keys", "-t", target, key], signal);
  return captureTmuxPane(session, 200, signal);
}

export async function waitForTmuxOutput(session: string, pattern: string, options: {
  regex?: boolean; exactLine?: boolean; timeoutMs?: number; lines?: number; signal?: AbortSignal;
} = {}): Promise<TmuxPaneState & { matched: true; pattern: string }> {
  if (!pattern || pattern.length > 256) throw new Error("wait pattern must contain 1..256 characters");
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error("timeoutMs must be an integer from 100 to 300000");
  let matcher: (value: string) => boolean;
  if (options.exactLine) matcher = (value) => value.split(/\r?\n/).some((line) => line === pattern);
  else if (options.regex) {
    let expression: RegExp;
    try { expression = new RegExp(pattern, "m"); } catch { throw new Error("invalid wait regex"); }
    matcher = (value) => expression.test(value);
  } else matcher = (value) => value.includes(pattern);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("tmux wait aborted");
    const state = await captureTmuxPane(session, options.lines ?? 500, options.signal);
    if (matcher(state.output)) return { ...state, matched: true, pattern };
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for tmux output: ${pattern}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal?.reason ?? new Error("tmux wait aborted")); }, { once: true });
    });
  }
}
