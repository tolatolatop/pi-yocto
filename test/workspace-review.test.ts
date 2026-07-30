import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { reviewYoctoFiles } from "../src/review.js";
import { inspectWorkspace } from "../src/workspace.js";
import { createTestWorkspace } from "./fixture.js";

test("workspace inspection hashes and protects configured external layer content", async () => {
  const located = await createTestWorkspace("pi-yocto-workspace-");
  const recipeDir = join(located.layerDir, "recipes-test", "demo");
  const recipe = join(recipeDir, "demo_1.0.bb");
  await mkdir(recipeDir, { recursive: true });
  await writeFile(recipe, 'LICENSE = "MIT"\nSUMMARY = "first"\n', "utf8");
  const first = await inspectWorkspace(located);
  const layer = first.layers.find((candidate) => candidate.path === located.layerDir);
  assert.ok(layer?.contentHash);
  assert.ok(first.protectedDirtyFiles.includes(recipe));
  await writeFile(recipe, 'LICENSE = "MIT"\nSUMMARY = "second"\n', "utf8");
  const second = await inspectWorkspace(located);
  assert.notEqual(second.layers.find((candidate) => candidate.path === located.layerDir)?.contentHash, layer.contentHash);
  assert.notEqual(second.evidence[0]?.sha256, first.evidence[0]?.sha256);
});

test("Yocto review returns checkpointable source Evidence and rejects outside paths", async () => {
  const located = await createTestWorkspace("pi-yocto-review-");
  const recipe = join(located.layerDir, "demo.bb");
  await writeFile(recipe, 'LICENSE = "MIT"\nLIC_FILES_CHKSUM = "file://LICENSE;md5=00000000000000000000000000000000"\n', "utf8");
  const review = await reviewYoctoFiles(located, [recipe]);
  assert.equal(review.passed, true);
  assert.equal(review.evidence[0]?.executionDomain, "source");
  assert.equal(review.evidence[0]?.claimType, "diagnosis");
  await assert.rejects(() => reviewYoctoFiles(located, ["/etc/passwd"]), /outside the configured Poky workspace/);
});
