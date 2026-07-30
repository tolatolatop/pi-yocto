import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBuildConfiguration } from "../src/config.js";
import { runCommand } from "../src/process.js";

test("parses weak assignments and multiline BBLAYERS", () => {
  const parsed = parseBuildConfiguration(`
MACHINE ??= "qemux86-64"
DISTRO ?= "poky"
DL_DIR ?= "/cache/downloads"
SSTATE_DIR ?= "/cache/sstate"
`, `BBLAYERS ?= " \\
  /work/meta-local \\
  /work/poky/meta \\
  "`);
  assert.equal(parsed.machine, "qemux86-64");
  assert.equal(parsed.distro, "poky");
  assert.deepEqual(parsed.layers, ["/work/meta-local", "/work/poky/meta"]);
  assert.equal(parsed.dlDir, "/cache/downloads");
  assert.equal(parsed.sstateDir, "/cache/sstate");
});

test("command output preserves leading porcelain status whitespace", async () => {
  const result = await runCommand("printf", [" M scripts/runqemu\n"], { cwd: process.cwd() });
  assert.equal(result.stdout, " M scripts/runqemu\n");
});
