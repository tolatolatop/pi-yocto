import type { JSONSchemaType } from "ajv";
import type { WorkspaceConfig } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export const workspaceConfigSchema: JSONSchemaType<WorkspaceConfig> = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "sourceDir", "buildDir", "machine", "distro", "layers", "offline", "limits"],
  properties: {
    schemaVersion: { type: "string", const: SCHEMA_VERSION },
    sourceDir: { type: "string", minLength: 1 },
    buildDir: { type: "string", minLength: 1 },
    machine: { type: "string", minLength: 1 },
    distro: { type: "string", minLength: 1 },
    layers: { type: "array", items: { type: "string", minLength: 1 } },
    dlDir: { type: "string", nullable: true },
    sstateDir: { type: "string", nullable: true },
    tmpDir: { type: "string", nullable: true },
    offline: {
      type: "object",
      additionalProperties: false,
      required: ["bitbakeNoNetwork", "blockExplicitNetworkCommands"],
      properties: {
        bitbakeNoNetwork: { type: "boolean" },
        blockExplicitNetworkCommands: { type: "boolean" }
      }
    },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["maxParallelAgents", "maxWorkflowDepth", "maxFixIterations"],
      properties: {
        maxParallelAgents: { type: "integer", minimum: 1, maximum: 16 },
        maxWorkflowDepth: { type: "integer", minimum: 1, maximum: 16 },
        maxFixIterations: { type: "integer", minimum: 1, maximum: 10 }
      }
    }
  }
};

const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "executionDomain", "claimType", "source", "fact", "confidence", "capturedAt"],
  properties: {
    id: { type: "string" }, kind: { enum: ["log", "metadata", "source", "documentation", "case", "command"] },
    executionDomain: { enum: ["host", "guest", "build", "metadata", "source", "documentation"] },
    claimType: { enum: ["observation", "diagnosis", "configuration", "build", "artifact", "execution", "behavior"] },
    source: { type: "string" }, locator: { type: "string" }, fact: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] }, conclusion: { type: "string" },
    capturedAt: { type: "string", format: "date-time" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    command: { type: "array", items: { type: "string" }, minItems: 1 }, exitCode: { type: "integer" }, jobId: { type: "string" }, workspaceId: { type: "string", pattern: "^[a-f0-9]{64}$" }
  },
  allOf: [
    { if: { properties: { executionDomain: { const: "guest" } }, required: ["executionDomain"] }, then: { required: ["command", "exitCode", "jobId"] } },
    { if: { properties: { claimType: { enum: ["execution", "behavior"] } }, required: ["claimType"] }, then: { required: ["command", "exitCode"] } }
  ]
};

const phase = { enum: ["INTAKE", "INSPECTING", "PLANNING", "WAITING_HUMAN", "EXECUTING", "VERIFYING", "SUMMARIZING", "COMPLETED", "FAILED", "PAUSED"] };
const jobStatus = { enum: ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "STOPPING", "STOPPED", "INTERRUPTED"] };
const jobKind = { enum: ["bitbake", "qemu", "check"] };
const jobPurpose = { enum: ["baseline", "parse", "verification", "incremental-confirmation", "qemu"] };
const jobSnapshot = { type: "object", additionalProperties: false, required: ["jobId", "status", "logOffset", "capturedAt"], properties: { jobId: { type: "string" }, status: jobStatus, logOffset: { type: "integer", minimum: 0 }, pid: { type: "integer" }, processGroupId: { type: "integer" }, processStartTicks: { type: "string" }, bootId: { type: "string" }, heartbeatAt: { type: "string" }, capturedAt: { type: "string" } } };
const inputManifest = { type: "object", additionalProperties: false, required: ["id", "path", "sha256", "required", "purpose", "usage"], properties: { id: { type: "string" }, path: { type: "string" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, required: { type: "boolean" }, purpose: { type: "string" }, usage: { enum: ["copy", "reference"] }, destinationSuffix: { type: "string" } } };
const decisionAnalysis = { type: "object", additionalProperties: false, required: ["selectedId", "rationale", "options"], properties: { selectedId: { type: "string" }, rationale: { type: "string" }, options: { type: "array", minItems: 2, items: { type: "object", additionalProperties: false, required: ["id", "summary", "files", "affectedPackages", "impactScore"], properties: { id: { type: "string" }, summary: { type: "string" }, files: { type: "array", items: { type: "string" } }, affectedPackages: { type: "array", items: { type: "string" } }, impactScore: { type: "integer", minimum: 0, maximum: 100 } } } } } };
const completionPolicy = { type: "object", additionalProperties: false, properties: { requiredJobs: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "purpose"], properties: { id: { type: "string" }, kind: jobKind, purpose: jobPurpose, target: { type: "string" }, minCount: { type: "integer", minimum: 1 }, allowedStatuses: { type: "array", items: jobStatus } } } }, requireReview: { type: "boolean" }, requireNoActiveJobs: { type: "boolean" }, requireNonzeroLogOffsets: { type: "boolean" }, requireJobIdentitySnapshots: { type: "boolean" }, requireDecisionAnalysis: { type: "boolean" }, minimumSessionBindings: { type: "integer", minimum: 1 } } };

export const schemas: Record<string, unknown> = {
  WorkspaceConfig: workspaceConfigSchema,
  ProjectContract: {
    $id: "pi-yocto/ProjectContract/1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "id", "requirements", "completion"],
    properties: {
      schemaVersion: { const: SCHEMA_VERSION }, id: { type: "string" },
      requirements: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["id", "description", "required"], properties: { id: { type: "string" }, description: { type: "string" }, required: { type: "boolean" }, expectedDomain: { enum: ["host", "guest", "build", "metadata", "source", "documentation"] }, expectedClaimType: { enum: ["observation", "diagnosis", "configuration", "build", "artifact", "execution", "behavior"] }, note: { type: "string" }, updatedAt: { type: "string" } } } },
      completion: completionPolicy,
      inputs: { type: "array", items: inputManifest }
    }
  },
  TaskRecord: {
    $id: "pi-yocto/TaskRecord/1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "id", "objective", "phase", "plan", "checkpoints", "evidence", "jobIds", "approvalIds", "changeSetIds", "currentFixIteration", "verificationAttempts", "createdAt", "updatedAt"],
    properties: {
      schemaVersion: { const: SCHEMA_VERSION }, id: { type: "string" }, workspaceId: { type: "string", pattern: "^[a-f0-9]{64}$" }, contractId: { type: "string" }, objective: { type: "string" }, phase,
      plan: { type: "array", items: { type: "string" } },
      checkpoints: { type: "array", items: { type: "object", additionalProperties: false, required: ["objective", "phase", "modifiedFiles", "evidenceIds", "completedSteps", "pendingSteps", "jobIds", "logOffsets", "createdAt"], properties: { objective: { type: "string" }, phase, modifiedFiles: { type: "array", items: { type: "string" } }, evidenceIds: { type: "array", items: { type: "string" } }, completedSteps: { type: "array", items: { type: "string" } }, pendingSteps: { type: "array", items: { type: "string" } }, jobIds: { type: "array", items: { type: "string" } }, logOffsets: { type: "object", additionalProperties: { type: "integer", minimum: 0 } }, jobSnapshots: { type: "object", additionalProperties: jobSnapshot }, resumeAction: { type: "string" }, createdAt: { type: "string", format: "date-time" } } } },
      evidence: { type: "array", items: evidenceSchema }, jobIds: { type: "array", items: { type: "string" } }, approvalIds: { type: "array", items: { type: "string" } }, changeSetIds: { type: "array", items: { type: "string" } }, currentFixIteration: { type: "integer", minimum: 0 },
      verificationAttempts: { type: "array", items: { type: "object", additionalProperties: false, required: ["iteration", "jobId", "fingerprint", "target", "status", "createdAt"], properties: { iteration: { type: "integer", minimum: 1 }, jobId: { type: "string" }, fingerprint: { type: "string" }, target: { type: "string" }, status: { enum: ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "STOPPING", "STOPPED", "INTERRUPTED"] }, createdAt: { type: "string" }, completedAt: { type: "string" } } } },
      verificationContract: { type: "object", additionalProperties: false, required: ["createdAt", "requirements"], properties: { createdAt: { type: "string" }, requirements: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "description", "required", "status", "evidenceIds"], properties: { id: { type: "string" }, description: { type: "string" }, required: { type: "boolean" }, expectedDomain: { enum: ["host", "guest", "build", "metadata", "source", "documentation"] }, expectedClaimType: { enum: ["observation", "diagnosis", "configuration", "build", "artifact", "execution", "behavior"] }, status: { enum: ["PENDING", "PASSED", "FAILED", "SKIPPED"] }, evidenceIds: { type: "array", items: { type: "string" } }, note: { type: "string" }, updatedAt: { type: "string" } } } } } },
      completionPolicy, inputManifest: { type: "array", items: inputManifest }, reviews: { type: "array", items: { type: "object", additionalProperties: false, required: ["files", "passed", "evidenceIds", "createdAt"], properties: { files: { type: "array", items: { type: "string" } }, passed: { type: "boolean" }, evidenceIds: { type: "array", items: { type: "string" } }, createdAt: { type: "string" } } } },
      createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, finalSummary: { type: "string" }, error: { type: "string" }
    }
  },
  JobRecord: {
    $id: "pi-yocto/JobRecord/1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "id", "taskId", "kind", "purpose", "fingerprint", "executable", "args", "cwd", "status", "createdAt", "logPath", "logOffset", "artifacts"],
    properties: {
      schemaVersion: { const: SCHEMA_VERSION }, id: { type: "string" }, workspaceId: { type: "string", pattern: "^[a-f0-9]{64}$" }, taskId: { type: "string" }, kind: jobKind, purpose: jobPurpose, iteration: { type: "integer", minimum: 1 }, fingerprint: { type: "string" }, executable: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, status: jobStatus, pid: { type: "integer" }, processGroupId: { type: "integer" }, processStartTicks: { type: "string" }, bootId: { type: "string" }, createdAt: { type: "string" }, startedAt: { type: "string" }, completedAt: { type: "string" }, heartbeatAt: { type: "string" }, exitCode: { type: "integer" }, signal: { type: "string" }, logPath: { type: "string" }, logOffset: { type: "integer", minimum: 0 }, artifacts: { type: "array", items: { type: "string" } }, error: { type: "string" }, resumeCommand: { type: "string" }
    }
  },
  Evidence: { ...evidenceSchema,
    $id: "pi-yocto/Evidence/1.0.0",
  },
  ApprovalRequest: {
    $id: "pi-yocto/ApprovalRequest/1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "id", "taskId", "action", "files", "scopeHash", "impact", "risk", "recovery", "status", "createdAt", "expiresAt"],
    properties: { schemaVersion: { const: SCHEMA_VERSION }, id: { type: "string" }, taskId: { type: "string" }, action: { type: "string" }, normalizedCommand: { type: "array", items: { type: "string" } }, files: { type: "array", items: { type: "string" } }, scopeHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, changeSetId: { type: "string" }, changeSetScopeHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, impact: { type: "string" }, estimatedDuration: { type: "string" }, risk: { type: "string" }, recovery: { type: "string" }, status: { enum: ["PENDING", "APPROVED", "DENIED", "EXPIRED", "CONSUMED"] }, createdAt: { type: "string" }, expiresAt: { type: "string" }, decidedAt: { type: "string" }, consumedAt: { type: "string" }, consumption: { type: "object", additionalProperties: false, required: ["taskId", "action", "files"], properties: { taskId: { type: "string" }, action: { type: "string" }, normalizedCommand: { type: "array", items: { type: "string" } }, files: { type: "array", items: { type: "string" } }, changeSetId: { type: "string" }, changeSetScopeHash: { type: "string", pattern: "^[a-f0-9]{64}$" } } } },
    allOf: [
      { if: { required: ["changeSetId"] }, then: { required: ["changeSetScopeHash"] } },
      { if: { required: ["changeSetScopeHash"] }, then: { required: ["changeSetId"] } }
    ]
  },
  ChangeSetRecord: {
    $id: "pi-yocto/ChangeSetRecord/1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "id", "taskId", "objective", "operations", "files", "scopeHash", "status", "preflight", "createdAt"],
    properties: {
      schemaVersion: { const: SCHEMA_VERSION }, id: { type: "string" }, taskId: { type: "string" }, objective: { type: "string" },
      operations: { type: "array", minItems: 1, items: { oneOf: [
        { type: "object", additionalProperties: false, required: ["kind", "path", "content", "afterSha256"], properties: { kind: { const: "write" }, path: { type: "string" }, content: { type: "string" }, beforeSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, afterSha256: { type: "string", pattern: "^[a-f0-9]{64}$" } } },
        { type: "object", additionalProperties: false, required: ["kind", "path", "destination", "beforeSha256"], properties: { kind: { const: "rename" }, path: { type: "string" }, destination: { type: "string" }, beforeSha256: { type: "string", pattern: "^[a-f0-9]{64}$" } } }
      ] } },
      files: { type: "array", minItems: 1, items: { type: "string" } }, scopeHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      status: { enum: ["PREPARED", "APPROVED", "APPLIED", "FAILED"] }, approvalId: { type: "string" }, inputIds: { type: "array", items: { type: "string" } }, decisionAnalysis,
      preflight: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "path", "passed", "detail"], properties: { kind: { enum: ["patch-syntax", "patch-applicability", "metadata-review"] }, path: { type: "string" }, passed: { type: "boolean" }, detail: { type: "string" } } } },
      createdAt: { type: "string" }, appliedAt: { type: "string" }, error: { type: "string" }
    }
  },
  GuestCommandRecord: {
    $id: "pi-yocto/GuestCommandRecord/1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "id", "taskId", "jobId", "argv", "status", "createdAt", "timeoutMs", "output"],
    properties: {
      schemaVersion: { const: SCHEMA_VERSION }, id: { type: "string" }, taskId: { type: "string" }, jobId: { type: "string" },
      argv: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1 } }, status: { enum: ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT"] },
      createdAt: { type: "string" }, startedAt: { type: "string" }, completedAt: { type: "string" }, timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 }, output: { type: "string" }, outputType: { enum: ["text", "binary"] }, outputBytes: { type: "integer", minimum: 0 }, outputSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, outputArtifact: { type: "string" }, outputTruncated: { type: "boolean" }, exitCode: { type: "integer" }, error: { type: "string" }
    }
  },
  AgentResult: {
    $id: "pi-yocto/AgentResult/1.0.0",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "conclusion", "evidence", "assumptions", "recommendedActions"],
    properties: { schemaVersion: { const: SCHEMA_VERSION }, conclusion: { type: "string" }, evidence: { type: "array", items: evidenceSchema }, assumptions: { type: "array", items: { type: "string" } }, recommendedActions: { type: "array", items: { type: "string" } }, error: { type: "object", additionalProperties: false, required: ["code", "message", "retryable"], properties: { code: { type: "string" }, message: { type: "string" }, retryable: { type: "boolean" } } } }
  }
} as const;
