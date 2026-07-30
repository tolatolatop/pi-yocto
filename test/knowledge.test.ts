import assert from "node:assert/strict";
import { test } from "node:test";
import { splitDocument } from "../src/knowledge.js";

test("RST/Markdown splitting is deterministic and bounded", () => {
  const input = `# First\n\n${"a".repeat(80)}\n\n## Second\n\n${"b".repeat(80)}`;
  const first = splitDocument(input, 60);
  assert.deepEqual(first, splitDocument(input, 60));
  assert.ok(first.length >= 3);
  assert.ok(first.every((chunk) => chunk.length <= 60));
});
