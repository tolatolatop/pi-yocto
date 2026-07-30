import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "../src/fs-utils.js";
import { preflightFileMirror } from "../src/mirror.js";
import { createTestWorkspace } from "./fixture.js";

test("offline mirror preflight preserves basename, checksum, and one BitBake newline escape", async () => {
  const located = await createTestWorkspace("pi-yocto-mirror-");
  const archive = join(located.rootDir, "demo-1.0.tar.gz");
  const content = Buffer.from("offline source archive");
  await writeFile(archive, content);
  const result = await preflightFileMirror(located, { sourceUri: "https://upstream.invalid/releases/demo-1.0.tar.gz", mirrorFile: archive, expectedSha256: sha256(content) });
  assert.equal(result.expectedResolvedUri, `file://${archive}`);
  assert.equal(result.sha256, sha256(content));
  assert.equal(result.rule.split(String.raw`\n`).length - 1, 1);
  assert.match(result.rule, /file:\/\/.*\/ \x5cn"$/);
  await assert.rejects(() => preflightFileMirror(located, { sourceUri: "https://upstream.invalid/releases/renamed.tar.gz", mirrorFile: archive }), /must match source basename/);
  await assert.rejects(() => preflightFileMirror(located, { sourceUri: "https://upstream.invalid/releases/demo-1.0.tar.gz", mirrorFile: archive, expectedSha256: "0".repeat(64) }), /SHA-256 mismatch/);
});
