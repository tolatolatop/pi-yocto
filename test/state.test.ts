import assert from "node:assert/strict";
import { test } from "node:test";
import { canTransition, transitionTask } from "../src/state.js";
import type { TaskRecord } from "../src/types.js";
import { SCHEMA_VERSION } from "../src/types.js";

test("task state machine accepts the fixed happy path and rejects skips", () => {
  const now = new Date().toISOString();
  let task: TaskRecord = { schemaVersion: SCHEMA_VERSION, id: "task-test", objective: "test", phase: "INTAKE", plan: [], checkpoints: [], evidence: [], jobIds: [], approvalIds: [], changeSetIds: [], currentFixIteration: 0, verificationAttempts: [], verificationContract: { createdAt: now, requirements: [{ id: "proof", description: "verified", required: true, status: "PASSED", evidenceIds: ["ev-proof"] }] }, createdAt: now, updatedAt: now, finalSummary: "verified result" };
  for (const phase of ["INSPECTING", "PLANNING", "WAITING_HUMAN", "EXECUTING", "VERIFYING", "SUMMARIZING", "COMPLETED"] as const) task = transitionTask(task, phase);
  assert.equal(task.phase, "COMPLETED");
  assert.equal(canTransition("INTAKE", "EXECUTING"), false);
  assert.throws(() => transitionTask({ ...task, phase: "INTAKE" }, "EXECUTING"));
});
