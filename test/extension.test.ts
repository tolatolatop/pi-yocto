import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piYoctoExtension from "../src/extension.js";
import { JobStore, reconcileJob } from "../src/jobs.js";
import { TaskStore } from "../src/state.js";
import { createTestWorkspace, writeExecutable } from "./fixture.js";

test("Pi extension registers the complete Poky tool and slash-command surface", () => {
  const tools: string[] = []; const commands: string[] = []; const events: string[] = [];
  const mock = {
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
    on(name: string) { events.push(name); },
    sendUserMessage() {}
  } as unknown as ExtensionAPI;
  piYoctoExtension(mock);
  assert.deepEqual(tools.sort(), [
    "yocto_approval_request", "yocto_change_apply", "yocto_change_prepare", "yocto_checkpoint", "yocto_guest_exec",
    "yocto_job_start", "yocto_job_status", "yocto_job_stop", "yocto_job_tail", "yocto_knowledge_search", "yocto_log_analyze",
    "yocto_metadata_query", "yocto_mirror_preflight", "yocto_review", "yocto_task_open", "yocto_task_status",
    "yocto_verification_plan", "yocto_verification_update", "yocto_workspace_inspect"
  ]);
  assert.ok(commands.includes("yocto-diagnose"));
  assert.ok(commands.includes("yocto-long-build"));
  assert.ok(events.includes("tool_call"));
  assert.ok(events.includes("session_start"));
});

test("Pi package manifest points to emitted extension, CLI, and pinned pi-agents", async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { bin: Record<string, string>; pi: { extensions: string[] }; dependencies: Record<string, string> };
  assert.equal(packageJson.bin["pi-yocto"], "./dist/src/cli.js");
  assert.equal(packageJson.dependencies["pi-agents"], "0.2.1");
  for (const path of packageJson.pi.extensions) await access(join(process.cwd(), path));
});

test("metadata tool persists returned Evidence before verification update", async () => {
  const located = await createTestWorkspace("pi-yocto-extension-evidence-");
  await writeExecutable(join(located.config.sourceDir, "oe-init-build-env"), `export PATH="${located.binDir}:$PATH"\ncd "$1"\n`);
  await writeExecutable(join(located.binDir, "bitbake"), "#!/usr/bin/env bash\necho parsed\n");
  await writeExecutable(join(located.binDir, "bitbake-layers"), "#!/usr/bin/env bash\necho demo-layer\n");
  const registered = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: unknown }> }>();
  const mock = {
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<{ details: unknown }> }) { registered.set(tool.name, tool); },
    registerCommand() {}, on() {}, sendUserMessage() {}
  } as unknown as ExtensionAPI;
  piYoctoExtension(mock);
  const ctx = { cwd: located.rootDir, hasUI: false, sessionManager: { getSessionId: () => "extension-evidence-session" } };
  const open = registered.get("yocto_task_open");
  const metadata = registered.get("yocto_metadata_query");
  const plan = registered.get("yocto_verification_plan");
  const update = registered.get("yocto_verification_update");
  const start = registered.get("yocto_job_start");
  const guest = registered.get("yocto_guest_exec");
  assert.ok(open && metadata && plan && update && start && guest);
  const opened = await open.execute("open", { objective: "prove automatic evidence persistence" }, undefined, undefined, ctx) as { details: { task: { id: string } } };
  const taskId = opened.details.task.id;
  await plan.execute("plan", { requirements: [
    { id: "parse", description: "metadata parse", required: true, expectedDomain: "metadata", expectedClaimType: "execution" },
    { id: "guest", description: "guest command", required: true, expectedDomain: "guest", expectedClaimType: "execution" }
  ] }, undefined, undefined, ctx);
  const queried = await metadata.execute("metadata", { action: "parse" }, undefined, undefined, ctx) as { details: { evidence: Array<{ id: string }> } };
  const evidenceId = queried.details.evidence[0]?.id;
  assert.ok(evidenceId);
  assert.equal((await new TaskStore(located).load(taskId)).evidence.some((item) => item.id === evidenceId), true);
  await update.execute("update", { requirementId: "parse", status: "PASSED", evidenceIds: [evidenceId] }, undefined, undefined, ctx);
  assert.equal((await new TaskStore(located).load(taskId)).verificationContract?.requirements[0]?.status, "PASSED");
  const observed = await metadata.execute("recipes", { action: "recipes", target: "demo" }, undefined, undefined, ctx) as { details: { evidence: Array<{ claimType: string }> } };
  assert.deepEqual(observed.details.evidence.map((item) => item.claimType), ["observation", "configuration", "diagnosis"]);

  await mkdir(join(located.config.sourceDir, "scripts"), { recursive: true });
  await writeExecutable(join(located.config.sourceDir, "scripts", "runqemu"), "#!/usr/bin/env bash\nprintf 'login: '\nIFS= read -r _\nprintf '# '\nIFS= read -r guest_line\neval \"$guest_line\"\nsleep 0.5\n");
  const tasks = new TaskStore(located);
  let task = await tasks.load(taskId);
  for (const phase of ["INSPECTING", "PLANNING", "EXECUTING", "VERIFYING"] as const) task = await tasks.transition(task.id, phase);
  await tasks.checkpoint(task.id, { objective: task.objective, phase: "VERIFYING", modifiedFiles: [], evidenceIds: [], completedSteps: ["prepared"], pendingSteps: ["guest"], jobIds: [], logOffsets: {} });
  const started = await start.execute("start", { kind: "qemu", purpose: "qemu", args: ["nographic"], iteration: 1 }, undefined, undefined, ctx) as { details: { job: { id: string } } };
  const jobs = new JobStore(located);
  let qemu = await jobs.load(started.details.job.id);
  for (let attempt = 0; attempt < 50 && qemu.status !== "RUNNING"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    qemu = await reconcileJob(jobs, qemu.id);
  }
  assert.equal(qemu.status, "RUNNING");
  const executed = await guest.execute("guest", { jobId: qemu.id, argv: ["printf", "%s", "guest-ok"], timeoutMs: 3000 }, undefined, undefined, ctx) as { details: { evidence: Array<{ id: string }> } };
  const guestEvidenceId = executed.details.evidence[0]?.id;
  assert.ok(guestEvidenceId);
  assert.equal((await tasks.load(taskId)).evidence.some((item) => item.id === guestEvidenceId), true);
  await update.execute("update-guest", { requirementId: "guest", status: "PASSED", evidenceIds: [guestEvidenceId] }, undefined, undefined, ctx);
  assert.equal((await tasks.load(taskId)).verificationContract?.requirements[1]?.status, "PASSED");
});
