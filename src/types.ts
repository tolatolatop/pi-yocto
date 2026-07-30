export const SCHEMA_VERSION = "1.0.0" as const;

export type TaskPhase =
  | "INTAKE"
  | "INSPECTING"
  | "PLANNING"
  | "WAITING_HUMAN"
  | "EXECUTING"
  | "VERIFYING"
  | "SUMMARIZING"
  | "COMPLETED"
  | "FAILED"
  | "PAUSED";

export interface WorkspaceConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  sourceDir: string;
  buildDir: string;
  machine: string;
  distro: string;
  layers: string[];
  dlDir?: string;
  sstateDir?: string;
  tmpDir?: string;
  offline: {
    bitbakeNoNetwork: boolean;
    blockExplicitNetworkCommands: boolean;
  };
  limits: {
    maxParallelAgents: number;
    maxWorkflowDepth: number;
    maxFixIterations: number;
  };
}

export interface Evidence {
  id: string;
  kind: "log" | "metadata" | "source" | "documentation" | "case" | "command";
  executionDomain: "host" | "guest" | "build" | "metadata" | "source" | "documentation";
  claimType: "observation" | "diagnosis" | "configuration" | "build" | "artifact" | "execution" | "behavior";
  source: string;
  locator?: string;
  fact: string;
  confidence: "high" | "medium" | "low";
  conclusion?: string;
  capturedAt: string;
  sha256?: string;
  command?: string[];
  exitCode?: number;
  jobId?: string;
  workspaceId?: string;
}

export interface JobSnapshot {
  jobId: string;
  status: JobStatus;
  logOffset: number;
  pid?: number;
  processGroupId?: number;
  processStartTicks?: string;
  bootId?: string;
  heartbeatAt?: string;
  capturedAt: string;
}

export interface Checkpoint {
  objective: string;
  phase: TaskPhase;
  modifiedFiles: string[];
  evidenceIds: string[];
  completedSteps: string[];
  pendingSteps: string[];
  jobIds: string[];
  logOffsets: Record<string, number>;
  jobSnapshots?: Record<string, JobSnapshot>;
  resumeAction?: string;
  createdAt: string;
}

export type VerificationStatus = "PENDING" | "PASSED" | "FAILED" | "SKIPPED";

export interface VerificationRequirement {
  id: string;
  description: string;
  required: boolean;
  expectedDomain?: Evidence["executionDomain"];
  expectedClaimType?: Evidence["claimType"];
  status: VerificationStatus;
  evidenceIds: string[];
  note?: string;
  updatedAt?: string;
}

export interface VerificationContract {
  createdAt: string;
  requirements: VerificationRequirement[];
}

export interface RequiredJob {
  id: string;
  kind?: JobKind;
  purpose: JobPurpose;
  target?: string;
  minCount?: number;
  allowedStatuses?: JobStatus[];
}

export interface InputManifestEntry {
  id: string;
  path: string;
  sha256: string;
  required: boolean;
  purpose: string;
  usage: "copy" | "reference";
  destinationSuffix?: string;
}

export interface DecisionOption {
  id: string;
  summary: string;
  files: string[];
  affectedPackages: string[];
  impactScore: number;
}

export interface DecisionAnalysis {
  selectedId: string;
  rationale: string;
  options: DecisionOption[];
}

export interface ReviewRecord {
  files: string[];
  passed: boolean;
  evidenceIds: string[];
  createdAt: string;
}

export interface CompletionPolicy {
  requiredJobs?: RequiredJob[];
  requireReview?: boolean;
  requireNoActiveJobs?: boolean;
  requireNonzeroLogOffsets?: boolean;
  requireJobIdentitySnapshots?: boolean;
  requireDecisionAnalysis?: boolean;
  minimumSessionBindings?: number;
}

export interface ProjectContract {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  requirements: Array<Omit<VerificationRequirement, "status" | "evidenceIds">>;
  completion: CompletionPolicy;
  inputs?: InputManifestEntry[];
}

export type JobPurpose = "baseline" | "parse" | "verification" | "incremental-confirmation" | "qemu";

export interface VerificationAttempt {
  iteration: number;
  jobId: string;
  fingerprint: string;
  target: string;
  status: JobStatus;
  createdAt: string;
  completedAt?: string;
}

export interface TaskRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  workspaceId?: string;
  contractId?: string;
  objective: string;
  phase: TaskPhase;
  plan: string[];
  checkpoints: Checkpoint[];
  evidence: Evidence[];
  jobIds: string[];
  approvalIds: string[];
  changeSetIds: string[];
  currentFixIteration: number;
  verificationAttempts: VerificationAttempt[];
  verificationContract?: VerificationContract;
  completionPolicy?: CompletionPolicy;
  inputManifest?: InputManifestEntry[];
  reviews?: ReviewRecord[];
  createdAt: string;
  updatedAt: string;
  finalSummary?: string;
  error?: string;
}

export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "STOPPING"
  | "STOPPED"
  | "INTERRUPTED";

export type JobKind = "bitbake" | "qemu" | "check";

export interface JobRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  workspaceId?: string;
  taskId: string;
  kind: JobKind;
  purpose: JobPurpose;
  iteration?: number;
  fingerprint: string;
  executable: string;
  args: string[];
  cwd: string;
  status: JobStatus;
  pid?: number;
  processGroupId?: number;
  processStartTicks?: string;
  bootId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  heartbeatAt?: string;
  exitCode?: number;
  signal?: string;
  logPath: string;
  logOffset: number;
  artifacts: string[];
  error?: string;
  resumeCommand?: string;
}

export interface ApprovalRequest {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  taskId: string;
  action: string;
  normalizedCommand?: string[];
  files: string[];
  scopeHash: string;
  changeSetId?: string;
  changeSetScopeHash?: string;
  impact: string;
  estimatedDuration?: string;
  risk: string;
  recovery: string;
  status: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "CONSUMED";
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  consumedAt?: string;
  consumption?: {
    taskId: string;
    action: string;
    normalizedCommand?: string[];
    files: string[];
    changeSetId?: string;
    changeSetScopeHash?: string;
  };
}

export type ChangeOperation =
  | { kind: "write"; path: string; content: string; beforeSha256?: string; afterSha256: string }
  | { kind: "rename"; path: string; destination: string; beforeSha256: string };

export interface ChangeSetRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  taskId: string;
  objective: string;
  operations: ChangeOperation[];
  files: string[];
  scopeHash: string;
  inputIds?: string[];
  decisionAnalysis?: DecisionAnalysis;
  status: "PREPARED" | "APPROVED" | "APPLIED" | "FAILED";
  approvalId?: string;
  preflight: Array<{ kind: "patch-syntax" | "patch-applicability" | "metadata-review"; path: string; passed: boolean; detail: string }>;
  createdAt: string;
  appliedAt?: string;
  error?: string;
}

export interface GuestCommandRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  taskId: string;
  jobId: string;
  argv: string[];
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  timeoutMs: number;
  output: string;
  outputType?: "text" | "binary";
  outputBytes?: number;
  outputSha256?: string;
  outputArtifact?: string;
  outputTruncated?: boolean;
  exitCode?: number;
  error?: string;
}

export interface AgentResult {
  schemaVersion: typeof SCHEMA_VERSION;
  conclusion: string;
  evidence: Evidence[];
  assumptions: string[];
  recommendedActions: string[];
  error?: { code: string; message: string; retryable: boolean };
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  body: string;
  release: string;
  source: string;
  commit: string;
  hash: string;
  license: string;
  confidence: "official-current" | "official-versioned" | "verified-case" | "curated";
  rank: number;
}

export interface KnowledgeIndexFile {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: string;
  workspaceCommit: string;
  documents: KnowledgeDocument[];
  miniSearch: unknown;
}
