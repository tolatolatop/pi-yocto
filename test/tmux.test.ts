import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piYoctoExtension from "../src/extension.js";
import { captureTmuxPane, sendTmuxKey, sendTmuxText, validateTmuxSessionName, waitForTmuxOutput } from "../src/tmux.js";

const execFileAsync = promisify(execFile);

test("tmux channel is exactly session-bound and supports send/capture/wait", async (t) => {
  const session = `pi-yocto-test-${process.pid}-${Date.now()}`;
  await execFileAsync("tmux", ["new-session", "-d", "-s", session, "-n", "console"]);
  t.after(async () => { await execFileAsync("tmux", ["kill-session", "-t", session]).catch(() => undefined); });
  const marker = `TMUX_OK_${Date.now()}`;
  await sendTmuxText(session, `printf '${marker}\\n'`);
  const waited = await waitForTmuxOutput(session, marker, { exactLine: true, timeoutMs: 5000 });
  assert.equal(waited.matched, true);
  assert.match((await captureTmuxPane(session)).output, new RegExp(marker));
});

test("tmux channel supports an allowlisted interrupt key", async (t) => {
  const session = `pi-yocto-key-${process.pid}-${Date.now()}`;
  await execFileAsync("tmux", ["new-session", "-d", "-s", session, "-n", "console"]);
  t.after(async () => { await execFileAsync("tmux", ["kill-session", "-t", session]).catch(() => undefined); });
  await sendTmuxText(session, "sleep 30");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await sendTmuxKey(session, "C-c");
  await sendTmuxText(session, "printf 'INTERRUPT_OK\\n'");
  assert.match((await waitForTmuxOutput(session, "INTERRUPT_OK", { timeoutMs: 5000 })).output, /\^C|INTERRUPT_OK/);
});

test("tmux session names reject target and shell metacharacters", () => {
  assert.equal(validateTmuxSessionName("safe.name-1"), "safe.name-1");
  for (const name of ["bad:1", "bad/name", "$(id)", "", "a".repeat(65)]) assert.throws(() => validateTmuxSessionName(name));
});

test("exact-line wait does not accept a marker embedded in shell command echo", async (t) => {
  const session = `pi-yocto-line-${process.pid}-${Date.now()}`;
  await execFileAsync("tmux", ["new-session", "-d", "-s", session, "-n", "console"]);
  t.after(async () => { await execFileAsync("tmux", ["kill-session", "-t", session]).catch(() => undefined); });
  await sendTmuxText(session, "printf 'prefix ECHO_ONLY suffix\\n'");
  await assert.rejects(() => waitForTmuxOutput(session, "ECHO_ONLY", { exactLine: true, timeoutMs: 200 }), /Timed out/);
});

test("--disable bash removes native bash while preserving the tmux tool", async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  let active = ["read", "bash", "yocto_tmux", "yocto_task_open"];
  const flags = new Map<string, string>([["disable", "bash"]]);
  const mock = {
    registerTool() {}, registerCommand() {}, registerFlag() {}, sendUserMessage() {},
    getFlag(name: string) { return flags.get(name); }, getActiveTools() { return active; }, setActiveTools(names: string[]) { active = names; },
    on(name: string, handler: (...args: unknown[]) => Promise<unknown>) { handlers.set(name, handler); }
  } as unknown as ExtensionAPI;
  piYoctoExtension(mock);
  const start = handlers.get("session_start");
  assert.ok(start);
  await start({}, { cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => "disable-bash" } });
  assert.equal(active.includes("bash"), false);
  assert.equal(active.includes("yocto_tmux"), true);
});
