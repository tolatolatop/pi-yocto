import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApprovalStore } from "../src/approval.js";
import type { LocatedConfig } from "../src/config.js";
import { writeJsonAtomic } from "../src/fs-utils.js";
import { TaskStore } from "../src/state.js";
import { SCHEMA_VERSION } from "../src/types.js";

test("approval cannot be reused for an expanded file or command scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-yocto-approval-"));
  await mkdir(join(root, ".pi-yocto", "approvals"), { recursive: true });
  const located: LocatedConfig = { rootDir: root, configPath: join(root, ".pi/yocto.json"), stateDir: join(root, ".pi-yocto"), config: { schemaVersion: SCHEMA_VERSION, sourceDir: join(root, "src"), buildDir: join(root, "build"), machine: "qemu", distro: "poky", layers: [], offline: { bitbakeNoNetwork: true, blockExplicitNetworkCommands: true }, limits: { maxParallelAgents: 3, maxWorkflowDepth: 4, maxFixIterations: 2 } } };
  const store = new ApprovalStore(located);
  const task = await new TaskStore(located).create("test exact approval binding");
  const request = await store.create({ taskId: task.id, action: "modify", command: ["edit", "a.bb"], files: [join(root, "a.bb")], impact: "metadata", risk: "parse", recovery: "restore" });
  await store.decide(request.id, true);
  await assert.rejects(() => store.consume(request.id, { taskId: task.id, action: "modify", command: ["edit", "b.bb"], files: [join(root, "b.bb")] }), /command binding mismatch|file scope mismatch/);
  const consumed = await store.consume(request.id, { taskId: task.id, action: "modify", command: ["edit", "a.bb"], files: [join(root, "a.bb")] });
  assert.equal(consumed.status, "CONSUMED");
  await assert.rejects(() => store.consume(request.id, { taskId: task.id, action: "modify", command: ["edit", "a.bb"], files: [join(root, "a.bb")] }), /not approved \(CONSUMED\)/);

  const tampered = await store.create({ taskId: task.id, action: "modify", command: ["edit", "a.bb"], files: [join(root, "a.bb")], impact: "metadata", risk: "parse", recovery: "restore" });
  await writeJsonAtomic(store.path(tampered.id), { ...tampered, files: [join(root, "expanded.bb")] });
  await assert.rejects(() => store.load(tampered.id), /scope integrity check failed/);
});
