import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { pathExists } from "../src/fs-utils.js";
import { queryMetadata } from "../src/metadata.js";
import { assertTargetOptimization } from "../src/optimization.js";
import { createTestWorkspace, writeExecutable } from "./fixture.js";

test("large metadata output is artifacted and only compact excerpts return to the model", async () => {
  const located = await createTestWorkspace("pi-yocto-metadata-large-");
  await writeExecutable(join(located.config.sourceDir, "oe-init-build-env"), `export PATH="${located.binDir}:$PATH"\ncd "$1"\n`);
  await writeExecutable(join(located.binDir, "bitbake"), "#!/usr/bin/env bash\nfor ((i=0; i<8000; i++)); do printf 'VARIABLE_%05d=abcdefghijklmnopqrstuvwxyz0123456789\\n' \"$i\"; done\n");
  const result = await queryMetadata(located, { action: "environment", target: "demo" });
  assert.equal(result.outputTruncated, true);
  assert.equal(typeof result.outputArtifact, "string");
  assert.equal(await pathExists(result.outputArtifact as string), true);
  assert.ok(String(result.output).length < 40 * 1024);
});

test("target optimization assertion rejects conflicts and preserves a reference fingerprint", async () => {
  const located = await createTestWorkspace("pi-yocto-optimization-");
  const taskDir = join(located.config.buildDir, "tmp", "work", "demo", "temp");
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, "run.do_compile"), "x86_64-poky-linux-gcc -pipe -Os demo.c -o demo\n", "utf8");
  await writeExecutable(join(located.config.sourceDir, "oe-init-build-env"), `export PATH="${located.binDir}:$PATH"\ncd "$1"\n`);
  await writeExecutable(join(located.binDir, "bitbake"), `#!/usr/bin/env bash
target="\${2:-}"
if [ "$target" = "demo" ]; then flags="\${DEMO_FLAGS:--Os}"; else flags="-O2"; fi
printf 'TARGET_CFLAGS="%s -pipe"\\n' "$flags"
printf 'export CFLAGS="%s -pipe"\\n' "$flags"
printf 'SELECTED_OPTIMIZATION="%s -pipe"\\n' "$flags"
printf 'T="${taskDir}"\\n'
`);
  const baseline = await assertTargetOptimization(located, { target: "demo", expectedFlag: "-Os", referenceTarget: "reference" });
  assert.equal(baseline.passed, true);
  assert.match(String(baseline.referenceFingerprint), /^[a-f0-9]{64}$/);
  const verified = await assertTargetOptimization(located, { target: "demo", expectedFlag: "-Os", requireCompileCommand: true, referenceTarget: "reference", expectedReferenceFingerprint: String(baseline.referenceFingerprint) });
  assert.equal(verified.passed, true);
  assert.equal(verified.compileCommands.length, 1);

  process.env.DEMO_FLAGS = "-O2 -Os";
  try {
    const conflicting = await assertTargetOptimization(located, { target: "demo", expectedFlag: "-Os", requireCompileCommand: true });
    assert.equal(conflicting.passed, false);
    assert.match(conflicting.failures.join(";"), /exactly -Os/);
  } finally { delete process.env.DEMO_FLAGS; }
});
