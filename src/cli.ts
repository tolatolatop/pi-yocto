#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { discoverWorkspace, findConfig, initializeProject } from "./config.js";
import { runDoctor } from "./doctor.js";
import { ApprovalStore } from "./approval.js";
import { guestCommandEvidence, queueGuestCommand, waitForGuestCommand } from "./guest.js";
import { JobStore, reconcileJob, startJob, stopJob, tailJob } from "./jobs.js";
import { buildKnowledgeIndex, knowledgeStatus, searchKnowledge } from "./knowledge.js";
import { exportTaskMarkdown, TaskStore } from "./state.js";

const program = new Command();
program.name("pi-yocto").description("Offline-first Yocto/Poky agent harness for Pi").version("0.1.0");

program.command("init")
  .description("Discover a Poky workspace and install project-local agent definitions")
  .option("--project <path>", "Pi project root", process.cwd())
  .option("--workspace <path>", "directory containing Poky source/build directories")
  .option("--source <path>", "Poky source directory")
  .option("--build <path>", "configured BitBake build directory")
  .action(async (options: { project: string; workspace?: string; source?: string; build?: string }) => {
    const project = resolve(options.project);
    const workspace = resolve(options.workspace ?? options.source ?? project);
    const config = await discoverWorkspace(workspace, options.source, options.build);
    const written = await initializeProject(project, config);
    process.stdout.write(`${JSON.stringify({ config, written }, null, 2)}\n`);
  });

program.command("doctor")
  .description("Check the configured Poky and pi-yocto environment")
  .option("--json", "emit JSON")
  .action(async (options: { json?: boolean }) => {
    const result = await runDoctor(await findConfig());
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else for (const check of result.checks) process.stdout.write(`${check.ok ? "OK" : check.warning ? "WARN" : "FAIL"} ${check.name}: ${check.detail}\n`);
    if (!result.ok) process.exitCode = 1;
  });

const knowledge = program.command("knowledge").description("Manage the deterministic offline knowledge index");
knowledge.command("build").action(async () => { process.stdout.write(`${JSON.stringify(await buildKnowledgeIndex(await findConfig()), null, 2)}\n`); });
knowledge.command("status").action(async () => { process.stdout.write(`${JSON.stringify(await knowledgeStatus(await findConfig()), null, 2)}\n`); });
knowledge.command("search").argument("<query>").option("--release <release>").option("--limit <number>", "maximum hits", "8").action(async (query: string, options: { release?: string; limit: string }) => {
  process.stdout.write(`${JSON.stringify(await searchKnowledge(await findConfig(), query, { ...(options.release ? { release: options.release } : {}), limit: Number(options.limit) }), null, 2)}\n`);
});

const job = program.command("job").description("Manage detached BitBake/QEMU/check jobs");
job.command("start").requiredOption("--kind <kind>", "bitbake, qemu, or check").requiredOption("--purpose <purpose>", "baseline, parse, verification, incremental-confirmation, or qemu").requiredOption("--task <id>").option("--iteration <number>").option("--retry-interrupted").argument("[args...]").action(async (args: string[], options: { kind: string; purpose: string; task: string; iteration?: string; retryInterrupted?: boolean }) => {
  if (!(["bitbake", "qemu", "check"] as string[]).includes(options.kind)) throw new Error(`Unknown job kind ${options.kind}`);
  if (!(["baseline", "parse", "verification", "incremental-confirmation", "qemu"] as string[]).includes(options.purpose)) throw new Error(`Unknown job purpose ${options.purpose}`);
  const record = await startJob(await findConfig(), { kind: options.kind as "bitbake" | "qemu" | "check", purpose: options.purpose as "baseline" | "parse" | "verification" | "incremental-confirmation" | "qemu", taskId: options.task, args, ...(options.iteration ? { iteration: Number(options.iteration) } : {}), ...(options.retryInterrupted ? { retryInterrupted: true } : {}) });
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
});
job.command("list").action(async () => {
  const located = await findConfig(); const store = new JobStore(located);
  const records = await Promise.all((await store.list()).map((record) => reconcileJob(store, record.id)));
  process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
});
job.command("status").argument("<id>").action(async (id: string) => {
  const located = await findConfig(); process.stdout.write(`${JSON.stringify(await reconcileJob(new JobStore(located), id), null, 2)}\n`);
});
job.command("logs").argument("<id>").option("--offset <number>").option("--bytes <number>", "maximum bytes", "65536").action(async (id: string, options: { offset?: string; bytes: string }) => {
  const located = await findConfig(); const result = await tailJob(new JobStore(located), id, { ...(options.offset ? { offset: Number(options.offset) } : {}), bytes: Number(options.bytes) });
  process.stdout.write(result.text); process.stderr.write(`\n[pi-yocto offset=${result.offset} status=${result.job.status}]\n`);
});
job.command("stop").argument("<id>").requiredOption("--task <id>").requiredOption("--approval <id>").action(async (id: string, options: { task: string; approval: string }) => {
  const located = await findConfig(); const record = await new JobStore(located).load(id);
  if (record.taskId !== options.task) throw new Error("Job task binding mismatch");
  await new ApprovalStore(located).consume(options.approval, { taskId: options.task, action: "stop_job", command: ["stop", id], files: [] });
  process.stdout.write(`${JSON.stringify(await stopJob(new JobStore(located), id), null, 2)}\n`);
});
job.command("exec").description("Run a controlled command in a RUNNING QEMU guest").argument("<id>").requiredOption("--task <id>").option("--timeout <ms>").argument("[argv...]").action(async (id: string, argv: string[], options: { task: string; timeout?: string }) => {
  const located = await findConfig(); const queued = await queueGuestCommand(located, { taskId: options.task, jobId: id, argv, ...(options.timeout ? { timeoutMs: Number(options.timeout) } : {}) });
  const command = await waitForGuestCommand(located, queued.id); process.stdout.write(`${JSON.stringify({ command, evidence: [guestCommandEvidence(command)] }, null, 2)}\n`);
});

const task = program.command("task").description("Inspect and resume evidence-backed tasks");
task.command("create").argument("<objective>").action(async (objective: string) => {
  process.stdout.write(`${JSON.stringify(await new TaskStore(await findConfig()).create(objective), null, 2)}\n`);
});
task.command("status").argument("[id]").action(async (id?: string) => {
  const store = new TaskStore(await findConfig()); process.stdout.write(`${JSON.stringify(id ? await store.load(id) : await store.list(), null, 2)}\n`);
});
task.command("resume").argument("<id>").action(async (id: string) => {
  const store = new TaskStore(await findConfig()); const record = await store.load(id); const checkpoint = record.checkpoints.at(-1);
  if (!checkpoint) throw new Error(`Task ${id} has no checkpoint`);
  const resumed = ["PAUSED", "FAILED"].includes(record.phase) ? await store.transition(id, checkpoint.phase === record.phase ? "INSPECTING" : checkpoint.phase) : record;
  process.stdout.write(`${JSON.stringify({ task: resumed, resumeAction: checkpoint.resumeAction, pendingSteps: checkpoint.pendingSteps }, null, 2)}\n`);
});
task.command("export").argument("<id>").option("--output <path>").action(async (id: string, options: { output?: string }) => {
  const store = new TaskStore(await findConfig()); const markdown = exportTaskMarkdown(await store.load(id));
  if (options.output) { await writeFile(resolve(options.output), markdown, "utf8"); process.stdout.write(`${resolve(options.output)}\n`); } else process.stdout.write(markdown);
});

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`pi-yocto: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
