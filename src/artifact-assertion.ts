import { readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { pathExists, sha256 } from "./fs-utils.js";
import { JobStore, reconcileJob } from "./jobs.js";
import type { Evidence } from "./types.js";

function within(path: string, root: string): boolean {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(root);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}/`);
}

function bitbakeTargets(args: string[]): string[] {
  return args.filter((argument) => !argument.startsWith("-"));
}

async function stableManifest(located: LocatedConfig, artifacts: string[], target: string): Promise<string> {
  const tmpDir = resolve(located.config.tmpDir ?? join(located.config.buildDir, "tmp"));
  const expected = resolve(tmpDir, "deploy", "images", located.config.machine, `${target}-${located.config.machine}.rootfs.manifest`);
  const candidates = artifacts.filter((path) => path.endsWith(".manifest"));
  if (candidates.includes(expected) && await pathExists(expected)) return expected;

  const canonical = new Map<string, string>();
  for (const candidate of candidates) {
    if (!within(candidate, tmpDir) || !(await pathExists(candidate))) continue;
    const resolved = await realpath(candidate);
    if (!within(resolved, tmpDir)) continue;
    canonical.set(resolved, candidate);
  }
  if (canonical.size !== 1) {
    throw new Error(`Job has no unambiguous current manifest for ${target}; expected ${expected}, candidates=${candidates.join(", ") || "none"}`);
  }
  return [...canonical.values()][0] as string;
}

/** Assert exact package membership in the stable manifest produced by one successful image job. */
export async function assertImageManifest(located: LocatedConfig, input: {
  taskId: string;
  jobId: string;
  package: string;
  expected: "present" | "absent";
}): Promise<{ passed: boolean; jobId: string; manifest: string; package: string; expected: "present" | "absent"; observed: "present" | "absent"; evidence: Evidence[] }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9+_.-]*$/.test(input.package)) throw new Error(`Unsafe package name: ${input.package}`);
  const job = await reconcileJob(new JobStore(located), input.jobId);
  if (job.taskId !== input.taskId) throw new Error(`Job ${job.id} belongs to a different TaskRecord`);
  if (job.kind !== "bitbake" || job.status !== "SUCCEEDED" || job.exitCode !== 0) throw new Error(`Manifest assertion requires a successful BitBake job; ${job.id} is ${job.status}`);
  const targets = bitbakeTargets(job.args);
  if (targets.length !== 1) throw new Error(`Manifest assertion requires one exact image target; got ${targets.join(", ") || "none"}`);
  const target = targets[0] as string;
  const manifest = await stableManifest(located, job.artifacts, target);
  const content = await readFile(manifest, "utf8");
  const packages = new Set(content.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
  const observed = packages.has(input.package) ? "present" : "absent";
  const passed = observed === input.expected;
  const command = ["assert-image-manifest", input.jobId, input.expected, input.package];
  const capturedAt = new Date().toISOString();
  const evidence: Evidence = {
    id: `ev-${sha256(`${input.jobId}:${manifest}:${input.package}:${input.expected}:${observed}:${sha256(content)}`).slice(0, 16)}`,
    kind: "command",
    executionDomain: "build",
    claimType: "behavior",
    source: "bitbake:image-manifest-assertion",
    locator: `${manifest}:${input.package}`,
    fact: `${basename(manifest)} ${observed === "present" ? "contains" : "does not contain"} exact package ${input.package}; expected ${input.expected}`,
    conclusion: passed ? "The current image manifest satisfies the package membership assertion" : "The successful image build has a semantic package-membership failure; bind this Evidence as FAILED and request controlled replanning",
    confidence: "high",
    capturedAt,
    sha256: sha256(content),
    command,
    exitCode: passed ? 0 : 1,
    jobId: job.id,
    ...(job.workspaceId ? { workspaceId: job.workspaceId } : {})
  };
  return { passed, jobId: job.id, manifest, package: input.package, expected: input.expected, observed, evidence: [evidence] };
}
