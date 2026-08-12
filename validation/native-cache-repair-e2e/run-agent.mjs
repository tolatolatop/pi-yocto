#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scenarioDir = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(scenarioDir, "../..");
const runRoot = resolve(process.argv[2] ?? "");
if (!runRoot.startsWith(join(scenarioDir, "runs") + "/")) throw new Error("run root must be under this scenario's runs directory");
const task = await readFile(join(runRoot, "TASK.md"), "utf8");
const provider = process.env.YOCTO_E2E_PROVIDER ?? "openrouter";
const model = process.env.YOCTO_E2E_MODEL ?? "deepseek/deepseek-v4-flash";
const apiBaseUrl = process.env.YOCTO_E2E_API_BASE_URL ?? "https://openrouter.ai/api/v1";
const apiKey = process.env.YOCTO_E2E_API_KEY ?? process.env.OPENROUTER_WALLBREAKER_API_KEY;
if (!apiKey) throw new Error("Set YOCTO_E2E_API_KEY (or OPENROUTER_WALLBREAKER_API_KEY) before running the E2E");
const configDir = join(runRoot, "controller/agent-config");
const sessions = join(runRoot, "controller/sessions");
const nodeBin = dirname(process.execPath);
await mkdir(configDir, { recursive: true });
await mkdir(sessions, { recursive: true });
await writeFile(join(configDir, "models.json"), `${JSON.stringify({ providers: { [provider]: {
  baseUrl: apiBaseUrl, api: "openai-completions", apiKey: "$YOCTO_E2E_API_KEY", authHeader: true,
  models: [{ id: model, name: model, reasoning: true, contextWindow: 131072, maxTokens: 16384 }]
} } }, null, 2)}\n`, { mode: 0o600 });
await writeFile(join(configDir, "auth.json"), "{}\n", { mode: 0o600 });
const output = await import("node:fs").then(({ createWriteStream }) => createWriteStream(join(runRoot, "controller/agent.jsonl"), { flags: "a" }));
const child = spawn(join(repoRoot, "node_modules/.bin/pi"), [
  "--mode", "json", "--print", "--approve", "--offline", "--no-skills", "--no-context-files",
  "--provider", provider, "--model", model, "--thinking", process.env.YOCTO_E2E_THINKING ?? "medium",
  "--session-dir", sessions, "--tools", "read,bash,grep,find,ls", task
], { cwd: runRoot, env: {
  ...process.env, YOCTO_E2E_API_KEY: apiKey,
  PATH: `${nodeBin}:${join(runRoot, "poky-src/bitbake/bin")}:${join(runRoot, "poky-src/scripts")}:/home/agent/poky/cache/tools/root/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  LC_ALL: "C.UTF-8", LANG: "C.UTF-8",
  PI_OFFLINE: "1", PI_CODING_AGENT_DIR: configDir
}, stdio: ["ignore", "pipe", "inherit"] });
child.stdout.pipe(output);
child.stdout.pipe(process.stdout);
child.on("exit", (code) => { output.end(); process.exitCode = code ?? 1; });
