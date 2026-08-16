#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scenarioDir = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(scenarioDir, "../..");
const runRoot = resolve(process.argv[2] ?? "");
if (!runRoot.startsWith(join(scenarioDir, "runs") + "/")) throw new Error("run root must be under this scenario's runs directory");
const manifest = JSON.parse(await readFile(join(runRoot, "manifest.json"), "utf8"));
const provider = process.env.YOCTO_E2E_PROVIDER ?? "openrouter";
const model = process.env.YOCTO_E2E_MODEL ?? manifest.model;
const apiKey = process.env.YOCTO_E2E_API_KEY ?? process.env.OPENROUTER_WALLBREAKER_API_KEY;
if (!apiKey) throw new Error("Set YOCTO_E2E_API_KEY or OPENROUTER_WALLBREAKER_API_KEY");
await mkdir(join(runRoot, "sessions"), { recursive: true });

const runPi = (args, outputPath) => new Promise((resolvePromise, reject) => {
  const child = spawn(join(repoRoot, "node_modules/.bin/pi"), args, {
    cwd: repoRoot, env: { ...process.env, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "inherit"]
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.on("error", reject);
  child.on("exit", async (code) => {
    await writeFile(outputPath, Buffer.concat(chunks));
    if (code === 0) resolvePromise(); else reject(new Error(`Pi exited ${code} for ${outputPath}`));
  });
});

for (const scenario of manifest.scenarios) {
  const prompt = `${scenario.prompt}\nThe required marker is ${scenario.marker}. Do not call edit, write, or any shell-like tool other than yocto_tmux.`;
  await runPi([
    "--extension", join(repoRoot, "dist/src/extension.js"), "--mode", "json", "--print", "--approve", "--offline", "--no-skills", "--no-context-files",
    "--provider", provider, "--model", model, "--api-key", apiKey, "--thinking", process.env.YOCTO_E2E_THINKING ?? "low",
    "--session-dir", join(runRoot, "sessions"), "--disable", "bash", "--tmux-session", scenario.session, prompt
  ], join(runRoot, `${scenario.id}.agent.jsonl`));
  const capture = await new Promise((resolvePromise, reject) => {
    const child = spawn("tmux", ["capture-pane", "-p", "-J", "-S", "-2000", "-t", `${scenario.session}:0.0`], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolvePromise(Buffer.concat(stdout)) : reject(new Error(Buffer.concat(stderr).toString())));
  });
  await writeFile(join(runRoot, `${scenario.id}.pane.log`), capture);
  // Closing the pipe flushes the tmux-owned raw console stream to disk. The
  // immutable manifest path lets the verifier distinguish it from a final
  // capture-pane snapshot or agent-authored evidence.
  await new Promise((resolvePromise, reject) => {
    const child = spawn("tmux", ["pipe-pane", "-t", `${scenario.session}:0.0`], { stdio: ["ignore", "ignore", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(Buffer.concat(stderr).toString())));
  });
}
