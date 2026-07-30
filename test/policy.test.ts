import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand, validateBitbakeJobArgs } from "../src/policy.js";

test("offline command policy blocks network and destructive BitBake operations", () => {
  assert.equal(classifyCommand("curl https://example.invalid", true).category, "network");
  assert.equal(classifyCommand("bitbake foo -c cleanall", true).category, "destructive");
  assert.equal(classifyCommand("bitbake core-image-minimal", true).allowed, true);
  assert.equal(classifyCommand("sed -i 's/a/b/' meta-local/recipes/a.bb", true).category, "workspace-write");
  assert.equal(classifyCommand("git apply fix.patch", true).category, "git-write");
  assert.doesNotThrow(() => validateBitbakeJobArgs(["core-image-minimal", "-k"]));
  assert.throws(() => validateBitbakeJobArgs(["core-image-minimal", "-f"]));
  assert.throws(() => validateBitbakeJobArgs(["../../target"]));
});
