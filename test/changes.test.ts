import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ApprovalStore } from "../src/approval.js";
import { applyChangeSet, ChangeSetStore, prepareChangeSet } from "../src/changes.js";
import { pathExists } from "../src/fs-utils.js";
import { TaskStore } from "../src/state.js";
import type { ChangeSetRecord } from "../src/types.js";
import { createTestWorkspace } from "./fixture.js";

async function approve(located: Awaited<ReturnType<typeof createTestWorkspace>>, changeSet: ChangeSetRecord): Promise<void> {
  const approvals = new ApprovalStore(located);
  const approval = await approvals.create({
    taskId: changeSet.taskId,
    action: "apply_change_set",
    command: ["apply-change-set", changeSet.id],
    files: changeSet.files,
    changeSetId: changeSet.id,
    changeSetScopeHash: changeSet.scopeHash,
    impact: "test metadata change",
    risk: "parse failure",
    recovery: "restore exact pre-image"
  });
  await approvals.decide(approval.id, true);
  await new ChangeSetStore(located).bindApproval(changeSet.id, approval.id);
  const tasks = new TaskStore(located);
  let task = await tasks.load(changeSet.taskId);
  if (task.phase === "PLANNING") task = await tasks.transition(task.id, "WAITING_HUMAN");
  if (task.phase === "WAITING_HUMAN") await tasks.transition(task.id, "EXECUTING");
}

async function planningTask(located: Awaited<ReturnType<typeof createTestWorkspace>>, objective: string) {
  const tasks = new TaskStore(located);
  let task = await tasks.create(objective);
  task = await tasks.transition(task.id, "INSPECTING");
  return tasks.transition(task.id, "PLANNING");
}

test("ChangeSet applies only exact approved content and consumes approval once", async () => {
  const located = await createTestWorkspace("pi-yocto-change-");
  const task = await planningTask(located, "update recipe");
  const recipe = join(located.layerDir, "recipes-test", "demo", "demo_1.0.bb");
  const before = 'LICENSE = "MIT"\nSUMMARY = "before"\n';
  const after = 'LICENSE = "MIT"\nSUMMARY = "after"\n';
  await mkdir(join(located.layerDir, "recipes-test", "demo"), { recursive: true });
  await writeFile(recipe, before, "utf8");
  const changeSet = await prepareChangeSet(located, { taskId: task.id, objective: "update summary", changes: [{ kind: "write", path: recipe, content: after }] });
  await approve(located, changeSet);
  const applied = await applyChangeSet(located, changeSet.id);
  assert.equal(applied.status, "APPLIED");
  assert.equal(await readFile(recipe, "utf8"), after);
  const approval = await new ApprovalStore(located).load(applied.approvalId ?? "");
  assert.equal(approval.status, "CONSUMED");
  assert.equal(approval.consumption?.changeSetScopeHash, changeSet.scopeHash);
  await assert.rejects(() => applyChangeSet(located, changeSet.id), /not approved/);
});

test("ChangeSet rejects post-approval content tampering and pre-image drift", async () => {
  const located = await createTestWorkspace("pi-yocto-change-drift-");
  const task = await planningTask(located, "protect content binding");
  const recipe = join(located.layerDir, "demo.bb");
  await writeFile(recipe, 'LICENSE = "MIT"\nSUMMARY = "before"\n', "utf8");
  const changeSet = await prepareChangeSet(located, { taskId: task.id, objective: "approved content", changes: [{ kind: "write", path: recipe, content: 'LICENSE = "MIT"\nSUMMARY = "approved"\n' }] });
  await approve(located, changeSet);
  const store = new ChangeSetStore(located);
  const approved = await store.load(changeSet.id);
  const operation = approved.operations[0];
  assert.equal(operation?.kind, "write");
  if (!operation || operation.kind !== "write") throw new Error("expected write operation");
  await store.save({ ...approved, operations: [{ ...operation, content: 'LICENSE = "MIT"\nSUMMARY = "tampered"\n' }] });
  await assert.rejects(() => applyChangeSet(located, changeSet.id), /does not match its approved hash/);

  await store.save(approved);
  await writeFile(recipe, 'LICENSE = "MIT"\nSUMMARY = "user drift"\n', "utf8");
  await assert.rejects(() => applyChangeSet(located, changeSet.id), /Pre-image changed since approval/);
  assert.match(await readFile(recipe, "utf8"), /user drift/);
  assert.equal((await new ApprovalStore(located).load(approved.approvalId ?? "")).status, "APPROVED");
});

test("ChangeSet rolls back already written files when a later operation fails", async () => {
  const located = await createTestWorkspace("pi-yocto-change-rollback-");
  const task = await planningTask(located, "exercise rollback");
  const blocker = join(located.layerDir, "blocker");
  const child = join(blocker, "child.txt");
  const changeSet = await prepareChangeSet(located, { taskId: task.id, objective: "two writes", changes: [{ kind: "write", path: blocker, content: "temporary\n" }, { kind: "write", path: child, content: "must fail\n" }] });
  await approve(located, changeSet);
  await assert.rejects(() => applyChangeSet(located, changeSet.id));
  assert.equal(await pathExists(blocker), false);
  assert.equal((await new ChangeSetStore(located).load(changeSet.id)).status, "FAILED");
});

test("ChangeSet semantic preflight blocks invalid license hashes and image recipes without tasks", async () => {
  const located = await createTestWorkspace("pi-yocto-change-semantic-");
  const task = await planningTask(located, "block deterministic metadata failures");
  const recipe = join(located.layerDir, "recipes-test", "demo", "demo_1.0.bb");
  await assert.rejects(() => prepareChangeSet(located, {
    taskId: task.id,
    objective: "invalid license checksum",
    changes: [{ kind: "write", path: recipe, content: `LICENSE = "MIT"\nLIC_FILES_CHKSUM = "file://LICENSE;sha256=${"a".repeat(64)}"\n` }]
  }), /LIC_FILES_CHKSUM requires md5/);

  const image = join(located.layerDir, "recipes-core", "images", "broken-image.bb");
  await assert.rejects(() => prepareChangeSet(located, {
    taskId: task.id,
    objective: "broken image graph",
    changes: [{ kind: "write", path: image, content: 'LICENSE = "MIT"\nIMAGE_INSTALL = "busybox"\n' }]
  }), /do_rootfs\/do_image tasks will be missing/);
});

test("ChangeSet semantic preflight distinguishes recommended package removal", async () => {
  const located = await createTestWorkspace("pi-yocto-change-removal-");
  const packagegroupDir = join(located.layerDir, "recipes-core", "packagegroups");
  await mkdir(packagegroupDir, { recursive: true });
  await writeFile(join(packagegroupDir, "packagegroup-demo.bb"), 'LICENSE = "MIT"\nRRECOMMENDS:${PN} = "optional-daemon"\n', "utf8");
  const task = await planningTask(located, "remove a recommendation correctly");
  const append = join(located.layerDir, "recipes-core", "images", "core-image-minimal.bbappend");
  await assert.rejects(() => prepareChangeSet(located, {
    taskId: task.id,
    objective: "wrong removal mechanism",
    changes: [{ kind: "write", path: append, content: 'IMAGE_INSTALL:remove = "optional-daemon"\n' }]
  }), /use BAD_RECOMMENDATIONS/);
  await assert.rejects(() => prepareChangeSet(located, {
    taskId: task.id,
    objective: "invented recommendation variable",
    changes: [{ kind: "write", path: append, content: 'IMAGE_RRECOMMENDS:remove:pn-packagegroup-demo = "optional-daemon"\n' }]
  }), /IMAGE_RRECOMMENDS is not a standard image solver input/);
});

test("ChangeSet graph preflight requires layer registration and resolvable file URIs", async () => {
  const located = await createTestWorkspace("pi-yocto-change-layer-graph-");
  const task = await planningTask(located, "create a complete layer");
  const layerConf = join(located.layerDir, "conf", "layer.conf");
  const recipe = join(located.layerDir, "recipes-test", "demo", "demo_1.0.bb");
  const recipeContent = 'LICENSE = "MIT"\nLIC_FILES_CHKSUM = "file://LICENSE;md5=00000000000000000000000000000000"\nSRC_URI = "file://demo file://LICENSE"\n';
  await assert.rejects(() => prepareChangeSet(located, {
    taskId: task.id,
    objective: "incomplete layer",
    changes: [
      { kind: "write", path: layerConf, content: 'BBFILE_COLLECTIONS += "test"\nBBFILES += "${LAYERDIR}/recipes-*/*/*.bb"\n' },
      { kind: "write", path: recipe, content: recipeContent },
      { kind: "write", path: join(dirname(recipe), "demo", "files", "demo"), content: "bad layout\n" },
      { kind: "write", path: join(dirname(recipe), "demo", "files", "LICENSE"), content: "license\n" }
    ]
  }), /missing from the planned recipe FILESPATH|not registered/);

  const bblayers = join(located.config.buildDir, "conf", "bblayers.conf");
  await assert.rejects(() => prepareChangeSet(located, {
    taskId: task.id,
    objective: "recipe outside BBFILES",
    changes: [
      { kind: "write", path: layerConf, content: 'BBFILE_COLLECTIONS += "test"\nBBFILES += "${LAYERDIR}/recipes-other/*/*.bb"\n' },
      { kind: "write", path: bblayers, content: `BBLAYERS = "${located.layerDir}"\n` },
      { kind: "write", path: recipe, content: recipeContent },
      { kind: "write", path: join(dirname(recipe), "files", "demo"), content: "ok\n" },
      { kind: "write", path: join(dirname(recipe), "files", "LICENSE"), content: "license\n" }
    ]
  }), /not covered by any BBFILES pattern/);

  const complete = await prepareChangeSet(located, {
    taskId: task.id,
    objective: "complete layer",
    changes: [
      { kind: "write", path: layerConf, content: 'BBFILE_COLLECTIONS += "test"\nBBFILES += "${LAYERDIR}/recipes-*/*/*.bb"\n' },
      { kind: "write", path: bblayers, content: `BBLAYERS = "${located.layerDir}"\n` },
      { kind: "write", path: recipe, content: recipeContent },
      { kind: "write", path: join(dirname(recipe), "files", "demo"), content: "ok\n" },
      { kind: "write", path: join(dirname(recipe), "files", "LICENSE"), content: "license\n" }
    ]
  });
  assert.equal(complete.preflight.every((item) => item.passed), true);
});

test("ChangeSet preflight rejects ineffective or conflicting recipe optimization flags", async () => {
  const located = await createTestWorkspace("pi-yocto-change-opt-flags-");
  await mkdir(join(located.config.buildDir, "conf"), { recursive: true });
  await writeFile(join(located.config.buildDir, "conf", "bblayers.conf"), `BBLAYERS = "${located.layerDir}"\n`, "utf8");
  await mkdir(join(located.layerDir, "conf"), { recursive: true });
  await writeFile(join(located.layerDir, "conf", "layer.conf"), 'BBFILE_COLLECTIONS += "test"\nBBFILES += "${LAYERDIR}/recipes-*/*/*.bbappend"\n', "utf8");
  const task = await planningTask(located, "optimize one recipe");
  const append = join(located.layerDir, "recipes-test", "demo", "demo_%.bbappend");
  await assert.rejects(() => prepareChangeSet(located, { taskId: task.id, objective: "wrong variable", changes: [{ kind: "write", path: append, content: 'CFLAGS:remove:demo = "-O2"\nCFLAGS:append:demo = " -Os"\n' }] }), /must change TARGET_CFLAGS/);
  await assert.rejects(() => prepareChangeSet(located, { taskId: task.id, objective: "conflicting flags", changes: [{ kind: "write", path: append, content: 'TARGET_CFLAGS:append:pn-demo = " -Os"\n' }] }), /requires removing the inherited level/);
  const valid = await prepareChangeSet(located, { taskId: task.id, objective: "target-only flags", changes: [{ kind: "write", path: append, content: 'TARGET_CFLAGS:remove:pn-demo = "-O2"\nTARGET_CFLAGS:append:pn-demo = " -Os"\n' }] });
  assert.equal(valid.preflight.every((item) => item.passed), true);
});
