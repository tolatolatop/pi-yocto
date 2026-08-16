#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scenarioDir = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(scenarioDir, "../..");
const runId = process.argv[2] ?? `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`Unsafe run id: ${runId}`);
const runRoot = join(scenarioDir, "runs", runId);
try { await stat(runRoot); throw new Error(`Run already exists: ${runRoot}`); }
catch (error) { if (error?.code !== "ENOENT") throw error; }
await mkdir(runRoot, { recursive: true });

const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

const suffix = runId.replace(/[^A-Za-z0-9]/g, "").slice(-20) || "run";
const scenarios = [
  {
    id: "roundtrip", session: `piy-roundtrip-${suffix}`, marker: `E2E_ROUNDTRIP_${suffix}`,
    prompt: "Use only yocto_tmux. Capture the bound pane, send a printf command that outputs the marker on its own line, then call wait with pattern equal to the marker and exactLine=true. Report success only after that wait matches."
  },
  {
    id: "project-tests", session: `piy-tests-${suffix}`, marker: `E2E_TESTS_PASS_${suffix}`,
    prompt: "Use only yocto_tmux. Capture the bound pane. Run npm test and, only if it succeeds, print the marker on its own line. Call wait with pattern equal to the marker, exactLine=true and a sufficient timeout, then capture enough history and report the TAP pass count."
  },
  {
    id: "interrupt-recovery", session: `piy-interrupt-${suffix}`, marker: `E2E_INTERRUPT_OK_${suffix}`,
    prompt: "Use only yocto_tmux. Capture the bound pane, send sleep 120, then send the C-c key through yocto_tmux. Send a printf command that outputs the marker on its own line, then call wait with pattern equal to the marker and exactLine=true. Report recovery only after it matches."
  }
];
for (const scenario of scenarios) {
  scenario.tmuxLog = join(runRoot, `${scenario.id}.tmux.log`);
  await writeFile(scenario.tmuxLog, "");
  await execFileAsync("tmux", ["new-session", "-d", "-s", scenario.session, "-c", repoRoot, "-n", "console"]);
  await execFileAsync("tmux", ["set-option", "-t", scenario.session, "history-limit", "10000"]);
  await execFileAsync("tmux", ["pipe-pane", "-o", "-t", `${scenario.session}:0.0`, `cat >> ${shellQuote(scenario.tmuxLog)}`]);
}
const manifest = { schemaVersion: "1.0.0", runId, runRoot, repoRoot, model: "deepseek/deepseek-v4-flash", scenarios, createdAt: new Date().toISOString() };
await writeFile(join(runRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ runRoot, sessions: scenarios.map(({ id, session }) => ({ id, session })) }, null, 2)}\n`);
