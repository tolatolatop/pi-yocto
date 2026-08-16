#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scenarioDir = resolve(dirname(fileURLToPath(import.meta.url)));
const runRoot = resolve(process.argv[2] ?? "");
if (!runRoot.startsWith(join(scenarioDir, "runs") + "/")) throw new Error("run root must be under this scenario's runs directory");
const manifest = JSON.parse(await readFile(join(runRoot, "manifest.json"), "utf8"));
const results = [];
const check = (id, ok, detail) => results.push({ id, ok: Boolean(ok), detail });
const normalizeTerminalRecord = (value) => value
  // npm's TTY spinner clears and rewrites its current line before printing the
  // success marker. Retain only the final visible content of such a line.
  .split("\n").map((line) => line.split("\x1b[1G\x1b[0K").at(-1)).join("\n")
  // Remove OSC metadata (for example CurrentDir) and CSI styling/mode bytes,
  // while keeping the immutable raw pipe-pane file for forensic inspection.
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\r/g, "");
const regexEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const scenario of manifest.scenarios) {
  const transcript = await readFile(join(runRoot, `${scenario.id}.agent.jsonl`), "utf8").catch(() => "");
  const pane = await readFile(join(runRoot, `${scenario.id}.pane.log`), "utf8").catch(() => "");
  const tmuxLog = typeof scenario.tmuxLog === "string"
    ? await readFile(scenario.tmuxLog, "utf8").catch(() => "")
    : "";
  const terminal = normalizeTerminalRecord(tmuxLog);
  const calls = new Map();
  for (const line of transcript.split("\n")) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "message_end") continue;
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.type === "toolCall" && value.id) calls.set(value.id, { name: value.name, arguments: value.arguments ?? {} });
      for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
    };
    visit(event.message);
  }
  const executed = [...calls.values()];
  const tmuxCalls = executed.filter((call) => call.name === "yocto_tmux");
  check(`${scenario.id}:tmux-record`, tmuxLog.length > 0, `${tmuxLog.length} bytes captured by tmux pipe-pane`);
  check(`${scenario.id}:no-bash`, !executed.some((call) => call.name === "bash"), `${executed.length} completed tool calls; native bash absent`);
  check(`${scenario.id}:tmux-used`, tmuxCalls.length >= 3, `${tmuxCalls.length} yocto_tmux calls`);
  check(`${scenario.id}:marker`, new RegExp(`^${regexEscape(scenario.marker)}$`, "m").test(terminal), `exact visible output line ${scenario.marker} in tmux record`);
  check(`${scenario.id}:wait`, tmuxCalls.some((call) => call.arguments.action === "wait" && call.arguments.pattern === scenario.marker && call.arguments.exactLine === true), "exact-line wait recorded");
  if (scenario.id === "roundtrip") check(`${scenario.id}:operations`, ["capture", "send", "wait"].every((action) => tmuxCalls.some((call) => call.arguments.action === action)), "capture/send/wait completed");
  if (scenario.id === "project-tests") {
    check(`${scenario.id}:command`, tmuxCalls.some((call) => call.arguments.action === "send" && /npm test/.test(call.arguments.text ?? "")), "npm test sent through tmux");
    check(`${scenario.id}:tap`, /(?:#|ℹ) pass 63\b/.test(terminal) && /(?:#|ℹ) fail 0\b/.test(terminal), "complete TAP suite passed in tmux record");
  }
  if (scenario.id === "interrupt-recovery") {
    check(`${scenario.id}:sleep`, tmuxCalls.some((call) => call.arguments.action === "send" && /sleep 120/.test(call.arguments.text ?? "")), "long command started");
    check(`${scenario.id}:interrupt`, tmuxCalls.some((call) => call.arguments.action === "key" && call.arguments.key === "C-c"), "C-c sent through tmux tool");
    check(`${scenario.id}:interrupt-record`, /sleep 120\n\^C/.test(terminal), "sleep and terminal interrupt recorded by tmux");
  }
}
const report = { schemaVersion: "1.0.0", runRoot, passed: results.every((result) => result.ok), results, verifiedAt: new Date().toISOString() };
await writeFile(join(runRoot, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
