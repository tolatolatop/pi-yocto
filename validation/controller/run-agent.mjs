#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runRoot = resolve(process.argv[2] ?? "");
const scenario = process.argv[3];
const mode = process.argv[4] ?? "initial";
if (!runRoot.startsWith(join(repoRoot, ".pi-yocto", "validation") + "/")) throw new Error("runRoot must be an isolated validation directory");
if (!/^(?:01|02|03|04|05|06|07|08|09|10)$/.test(scenario ?? "") || !["initial", "resume"].includes(mode)) throw new Error("Usage: run-agent.mjs <run-root> <01..10> [initial|resume]");
if (!process.env.YOCTO_E2E_API_KEY) throw new Error("YOCTO_E2E_API_KEY is required in the controller process environment");

const provider = process.env.YOCTO_E2E_PROVIDER ?? "openrouter";
const model = process.env.YOCTO_E2E_MODEL ?? "qwen/qwen3.6-35b-a3b";
const apiBaseUrl = process.env.YOCTO_E2E_API_BASE_URL ?? (provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined);
const thinking = process.env.YOCTO_E2E_THINKING ?? "medium";
const tmuxSession = process.env.YOCTO_E2E_TMUX_SESSION;
if (tmuxSession && !/^[A-Za-z0-9_.-]{1,64}$/.test(tmuxSession)) throw new Error(`Unsafe tmux session: ${tmuxSession}`);

const scenarioText = await readFile(join(repoRoot, "validation", "scenarios", ({
  "01": "01-patch-regression.md",
  "02": "02-create-layer-image.md",
  "03": "03-rootfs-package-split.md",
  "04": "04-kernel-fragment-qemu.md",
  "05": "05-offline-long-build.md",
  "06": "06-new-oss-recipe.md",
  "07": "07-package-optimization.md",
  "08": "08-remove-package.md",
  "09": "09-runtime-dev.md",
  "10": "10-full-minimal-variants.md"
})[scenario]), "utf8");
const taskMatch = scenarioText.match(/## 给 agent 的任务\s+> ([\s\S]*?)(?=\n## )/);
if (!taskMatch) throw new Error(`Cannot extract agent task for E2E-${scenario}`);
const task = taskMatch[1].split("\n").map((line) => line.replace(/^> ?/, "")).join("\n").trim();

const controllerDir = join(runRoot, "controller");
const sessionDir = join(controllerDir, `sessions-${mode}-${Date.now()}`);
await mkdir(sessionDir, { recursive: true });
const rpcLog = createWriteStream(join(controllerDir, `rpc-${mode}.jsonl`), { flags: "a", mode: 0o600 });
const stderrLog = createWriteStream(join(controllerDir, `pi-${mode}.stderr.log`), { flags: "a", mode: 0o600 });
const decisionLog = createWriteStream(join(controllerDir, "ui-decisions.jsonl"), { flags: "a", mode: 0o600 });
const tmuxLog = tmuxSession ? join(controllerDir, `tmux-${mode}.log`) : undefined;
if (tmuxSession) {
  await writeFile(tmuxLog, "", { mode: 0o600 });
  await execFileAsync("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", runRoot, "-n", "console"]);
  await execFileAsync("tmux", ["set-option", "-t", tmuxSession, "history-limit", "10000"]);
  const quotedLog = `'${tmuxLog.replaceAll("'", `'\\''`)}'`;
  await execFileAsync("tmux", ["pipe-pane", "-o", "-t", `${tmuxSession}:0.0`, `cat >> ${quotedLog}`]);
}

let agentDir;
if (apiBaseUrl) {
  agentDir = join(controllerDir, "agent-config");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      [provider]: {
        baseUrl: apiBaseUrl,
        api: "openai-completions",
        apiKey: "$YOCTO_E2E_API_KEY",
        authHeader: true,
        // Keep a conservative advertised context/output budget so Pi compacts
        // before OpenRouter receives an oversized completion request.
        models: [{ id: model, name: model, reasoning: true, contextWindow: 131072, maxTokens: 16384 }]
      }
    }
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
}

const pi = spawn(join(repoRoot, "node_modules", ".bin", "pi"), [
  "--mode", "rpc",
  "--provider", provider,
  "--model", model,
  "--thinking", thinking,
  "--offline",
  "--approve",
  "--session-dir", sessionDir,
  "--extension", join(repoRoot, "dist", "src", "extension.js"),
  ...(tmuxSession ? ["--disable", "bash", "--tmux-session", tmuxSession] : [])
], {
  cwd: runRoot,
  env: {
    ...process.env,
    PI_OFFLINE: "1",
    OPENROUTER_API_KEY: process.env.YOCTO_E2E_API_KEY,
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {})
  },
  stdio: ["pipe", "pipe", "pipe"],
  shell: false
});

let stdoutBuffer = "";
let settledCount = 0;
let turnCount = 0;
let finished = false;
let lastAssistantText = "";
const startedAt = new Date().toISOString();
const send = (value) => pi.stdin.write(`${JSON.stringify(value)}\n`);

async function loadTask() {
  const directory = join(runRoot, ".pi-yocto", "tasks");
  const names = await readdir(directory).catch(() => []);
  if (!names.length) return undefined;
  const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

async function approvalDecision(event) {
  if (event.method !== "confirm" || !String(event.title ?? "").startsWith("Yocto approval:")) return { confirmed: false, reason: "not-yocto-confirm" };
  const action = String(event.title).slice("Yocto approval: ".length);
  if (!["apply_change_set", "stop_job"].includes(action)) return { confirmed: false, reason: `unapproved-action:${action}` };
  const approvalDir = join(runRoot, ".pi-yocto", "approvals");
  const names = await readdir(approvalDir).catch(() => []);
  const pending = (await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(approvalDir, name), "utf8")))))
    .filter((approval) => approval.status === "PENDING" && approval.action === action)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const approval = pending[0];
  if (!approval) return { confirmed: false, reason: `no-pending-${action}` };
  if (action === "stop_job") {
    const jobId = approval.normalizedCommand?.[1];
    const job = jobId ? await readFile(join(runRoot, ".pi-yocto", "jobs", `${jobId}.json`), "utf8").then(JSON.parse).catch(() => undefined) : undefined;
    const valid = job && job.taskId === approval.taskId && job.kind === "qemu" && job.cwd === join(runRoot, "build");
    return { confirmed: Boolean(valid), reason: valid ? "bound-run-qemu-stop" : "invalid-stop-binding", approvalId: approval.id };
  }
  const files = approval.files ?? [];
  const withinRun = files.length > 0 && files.every((path) => path.startsWith(`${runRoot}/`) && !path.startsWith(`${join(runRoot, ".pi-yocto")}/`));
  const change = approval.changeSetId
    ? await readFile(join(runRoot, ".pi-yocto", "changes", `${approval.changeSetId}.json`), "utf8").then(JSON.parse).catch(() => undefined)
    : undefined;
  const exactBinding = change
    && change.status === "PREPARED"
    && change.taskId === approval.taskId
    && change.scopeHash === approval.changeSetScopeHash
    && JSON.stringify(change.files) === JSON.stringify(files);
  const confirmed = Boolean(withinRun && exactBinding);
  return { confirmed, reason: confirmed ? "exact-run-change-set" : "invalid-change-set-binding", approvalId: approval.id, files };
}

async function finish(reason, code = 0) {
  if (finished) return;
  finished = true;
  const record = await loadTask();
  await writeFile(join(controllerDir, `controller-result-${mode}.json`), `${JSON.stringify({
    scenario: `E2E-${scenario}`,
    provider,
    model,
    mode,
    startedAt,
    completedAt: new Date().toISOString(),
    reason,
    settledCount,
    turnCount,
    tmuxSession,
    tmuxLog,
    taskId: record?.id,
    phase: record?.phase,
    lastAssistantText
  }, null, 2)}\n`, { mode: 0o600 });
  pi.kill("SIGTERM");
  if (tmuxSession) {
    const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-J", "-S", "-10000", "-t", `${tmuxSession}:0.0`]);
    await writeFile(join(controllerDir, `tmux-${mode}.pane.log`), stdout, { mode: 0o600 });
    await execFileAsync("tmux", ["pipe-pane", "-t", `${tmuxSession}:0.0`]);
  }
  setTimeout(() => pi.kill("SIGKILL"), 2000).unref();
  process.exitCode = code;
}

async function shouldDetachForRecovery(record) {
  if (scenario !== "05" || mode !== "initial" || !record?.jobIds?.length) return false;
  const jobs = await Promise.all(record.jobIds.map(async (id) => JSON.parse(await readFile(join(runRoot, ".pi-yocto", "jobs", `${id}.json`), "utf8"))));
  const verification = [...jobs].reverse().find((job) => job.kind === "bitbake" && job.purpose === "verification" && job.args.includes("offline-report-image") && ["QUEUED", "RUNNING"].includes(job.status));
  if (!verification) return false;
  const checkpoint = record.checkpoints?.at(-1);
  const snapshot = checkpoint?.jobSnapshots?.[verification.id];
  return checkpoint?.jobIds?.includes(verification.id) && Boolean(snapshot?.pid && snapshot?.processGroupId && snapshot?.processStartTicks && snapshot?.bootId);
}

async function handle(event) {
  // Streaming deltas duplicate the terminal messages and can grow a single
  // validation log to hundreds of megabytes. Terminal message/tool events are
  // sufficient to audit the controller conversation.
  if (event.type !== "message_update" && event.type !== "tool_execution_update") {
    rpcLog.write(`${JSON.stringify(event)}\n`);
  }
  if (event.type === "extension_ui_request" && event.method === "confirm") {
    const decision = await approvalDecision(event);
    decisionLog.write(`${JSON.stringify({ at: new Date().toISOString(), id: event.id, title: event.title, message: event.message, ...decision })}\n`);
    send({ type: "extension_ui_response", id: event.id, confirmed: decision.confirmed });
    return;
  }
  if (event.type === "extension_ui_request" && ["select", "input", "editor"].includes(event.method)) {
    send({ type: "extension_ui_response", id: event.id, cancelled: true });
    return;
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    lastAssistantText = (event.message.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n").slice(-20000);
  }
  if (event.type === "tool_execution_end") {
    const record = await loadTask();
    if (record?.phase === "COMPLETED") return finish("task-completed", 0);
    if (["FAILED", "PAUSED"].includes(record?.phase)) return finish(`task-${record.phase.toLowerCase()}`, 2);
    if (await shouldDetachForRecovery(record)) return finish("detached-after-running-checkpoint", 0);
  }
  if (event.type === "turn_end") {
    turnCount += 1;
    if (turnCount >= 160) return finish("tool-turn-budget-exhausted", 3);
  }
  if (!["agent_settled", "agent_end"].includes(event.type)) return;
  settledCount += 1;
  const record = await loadTask();
  if (record?.phase === "COMPLETED") return finish("task-completed", 0);
  if (["FAILED", "PAUSED"].includes(record?.phase)) return finish(`task-${record.phase.toLowerCase()}`, 2);
  if (settledCount >= 12) return finish("settled-turn-budget-exhausted", 3);
  const activeJobs = record?.jobIds?.length
    ? await Promise.all(record.jobIds.map(async (id) => JSON.parse(await readFile(join(runRoot, ".pi-yocto", "jobs", `${id}.json`), "utf8"))))
    : [];
  const active = activeJobs.filter((job) => ["QUEUED", "RUNNING", "STOPPING"].includes(job.status));
  const activeQemu = active.filter((job) => job.kind === "qemu");
  const follow = record
    ? `继续完成同一个 TaskRecord ${record.id}。当前 phase=${record.phase}，active jobs=${active.map((job) => `${job.id}:${job.status}`).join(",") || "none"}。${activeQemu.length ? `QEMU 验证完成后直接调用 yocto_job_stop，参数 id=${activeQemu[0].id} 且不传 approvalId；禁止先调用 yocto_approval_request。` : ""}检查合同中仍为 PENDING 的项目，恢复或轮询已有 job，不要重复高成本构建；成功 image 的包存在/缺失语义使用 yocto_artifact_assert，失败时受控 replan，不要把 TaskRecord 直接设为 FAILED；完成所有证据、QEMU 停止和最终 checkpoint。`
    : "你尚未创建 TaskRecord。请立即调用 yocto_task_open，并完整执行用户任务和控制器合同。";
  setTimeout(() => send({ id: `continue-${settledCount}`, type: "prompt", message: follow }), active.length ? 5000 : 1000);
}

pi.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  for (;;) {
    const index = stdoutBuffer.indexOf("\n");
    if (index < 0) break;
    const line = stdoutBuffer.slice(0, index);
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (!line.trim()) continue;
    try { void handle(JSON.parse(line)); }
    catch (error) { stderrLog.write(`[controller parse] ${error instanceof Error ? error.stack : String(error)}\n${line}\n`); }
  }
});
pi.stderr.on("data", (chunk) => stderrLog.write(chunk));
pi.on("error", (error) => { stderrLog.write(`${error.stack ?? error.message}\n`); void finish("pi-spawn-error", 4); });
pi.on("exit", (code, signal) => {
  if (!finished) void finish(`pi-exit-${code ?? signal ?? "unknown"}`, code === 0 ? 0 : 4);
  rpcLog.end(); stderrLog.end(); decisionLog.end();
});

const existing = mode === "resume" ? await loadTask() : undefined;
if (mode === "resume" && !existing) throw new Error("Cannot resume because the run has no TaskRecord");
setTimeout(() => send({
  id: `${mode}-task`,
  type: "prompt",
  message: mode === "initial"
    ? `${task}\n\n这是一次受控 E2E 验证。请自主完成闭环，使用 pi-yocto 专用工具和控制器固定合同；需要修改时准备完整 ChangeSet，控制器只会批准隔离 run 内的精确变更。不要要求我提供 oracle。${tmuxSession ? ` 原生 bash 工具已禁用；需要操作终端时只能使用绑定到 ${tmuxSession} 的 yocto_tmux。` : ""}`
    : `这是新的 Pi 会话。恢复同一 TaskRecord ${existing.id}，先调用 yocto_task_open 并显式传 taskId=${existing.id}，读取 checkpoint、已有 JobRecord 和增量日志 offset；不得重复已经运行或成功的高成本构建。继续完成原始任务：\n\n${task}\n\n完成所有合同证据、QEMU 安全停止和最终 checkpoint。`
}), 500);
setTimeout(() => { void finish("controller-timeout", 5); }, 45 * 60 * 1000).unref();
