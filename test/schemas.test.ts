import assert from "node:assert/strict";
import { test } from "node:test";
import { Ajv, type AnySchema } from "ajv";
import { schemas } from "../src/schemas.js";
import { SCHEMA_VERSION } from "../src/types.js";

test("all public protocol schemas compile and reject missing bindings", () => {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  for (const [name, schema] of Object.entries(schemas)) assert.doesNotThrow(() => ajv.compile(schema as AnySchema), name);
  const validate = ajv.compile(schemas.ApprovalRequest as AnySchema);
  assert.equal(validate({ schemaVersion: SCHEMA_VERSION, id: "a", taskId: "t", action: "modify", files: [], scopeHash: "a".repeat(64), impact: "x", risk: "x", recovery: "x", status: "PENDING", createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() }), true);
  assert.equal(validate({ schemaVersion: SCHEMA_VERSION, id: "a", taskId: "t", action: "modify", files: ["/tmp/a"], scopeHash: "a".repeat(64), changeSetId: "change-a", impact: "x", risk: "x", recovery: "x", status: "PENDING", createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() }), false);
  assert.equal(validate({ schemaVersion: SCHEMA_VERSION, id: "a", action: "modify" }), false);
  const validateChangeSet = ajv.compile(schemas.ChangeSetRecord as AnySchema);
  assert.equal(validateChangeSet({ schemaVersion: SCHEMA_VERSION, id: "change-a", taskId: "task-a", objective: "write", operations: [{ kind: "write", path: "/tmp/a", content: "x", afterSha256: "b".repeat(64) }], files: ["/tmp/a"], scopeHash: "c".repeat(64), status: "PREPARED", preflight: [], createdAt: new Date().toISOString() }), true);
  const validateGuest = ajv.compile(schemas.GuestCommandRecord as AnySchema);
  assert.equal(validateGuest({ schemaVersion: SCHEMA_VERSION, id: "guest-a", taskId: "task-a", jobId: "job-a", argv: ["uname", "-a"], status: "SUCCEEDED", createdAt: new Date().toISOString(), timeoutMs: 3000, output: "Linux", exitCode: 0 }), true);
});
