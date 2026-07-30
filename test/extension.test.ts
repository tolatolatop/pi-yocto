import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piYoctoExtension from "../src/extension.js";

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
