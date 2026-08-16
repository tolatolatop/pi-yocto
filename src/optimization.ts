import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { pathExists, sha256 } from "./fs-utils.js";
import { captureBitbakeEnvironment, runCommand } from "./process.js";
import type { Evidence } from "./types.js";

const safeTarget = /^[A-Za-z0-9][A-Za-z0-9+_.:@/-]*$/;
const allowedOptimizationFlags = new Set(["-O0", "-O1", "-O2", "-O3", "-Os", "-Oz", "-Og", "-Ofast"]);

function effectiveVariable(output: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignment = new RegExp(`^(?:export\\s+)?${escaped}=(.*)$`);
  let value: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(assignment);
    if (!match) continue;
    const raw = (match[1] ?? "").trim();
    value = raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) ? raw.slice(1, -1) : raw;
  }
  return value;
}

function optimizationFlags(value: string): string[] {
  return [...value.matchAll(/(?:^|\s)(-O(?:fast|[0-3sgz]))(?=\s|$)/g)].map((match) => match[1] as string);
}

function within(path: string, root: string): boolean {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(root);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}/`);
}

async function environmentForTarget(located: LocatedConfig, target: string): Promise<{ output: string; code: number; command: string[] }> {
  if (!safeTarget.test(target) || target.startsWith("-") || target.includes("..")) throw new Error(`Unsafe optimization target: ${target}`);
  const env = await captureBitbakeEnvironment(located.config);
  const result = await runCommand("bitbake", ["-e", target], { cwd: located.config.buildDir, env, timeoutMs: 180_000, maxOutputBytes: 32 * 1024 * 1024, umask: 0o022 });
  return { output: result.stdout, code: result.code, command: result.command };
}

function flagFingerprint(values: Record<string, string | undefined>): string {
  return sha256(JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
}

export async function assertTargetOptimization(located: LocatedConfig, input: {
  target: string;
  expectedFlag: string;
  requireCompileCommand?: boolean;
  compileCommandPath?: string;
  referenceTarget?: string;
  expectedReferenceFingerprint?: string;
}): Promise<{
  passed: boolean;
  target: string;
  expectedFlag: string;
  metadataFlags: string[];
  variables: Record<string, string | undefined>;
  compileCommandPath?: string;
  compileCommands: string[];
  referenceTarget?: string;
  reference?: Record<string, string | undefined>;
  referenceFingerprint?: string;
  failures: string[];
  evidence: Evidence[];
}> {
  if (!allowedOptimizationFlags.has(input.expectedFlag)) throw new Error(`Unsupported expected optimization flag: ${input.expectedFlag}`);
  if (input.expectedReferenceFingerprint && !input.referenceTarget) throw new Error("expectedReferenceFingerprint requires referenceTarget");
  if (input.expectedReferenceFingerprint && !/^[a-f0-9]{64}$/.test(input.expectedReferenceFingerprint)) throw new Error("Invalid reference optimization fingerprint");

  const targetResult = await environmentForTarget(located, input.target);
  const variables = {
    TARGET_CFLAGS: effectiveVariable(targetResult.output, "TARGET_CFLAGS"),
    CFLAGS: effectiveVariable(targetResult.output, "CFLAGS"),
    SELECTED_OPTIMIZATION: effectiveVariable(targetResult.output, "SELECTED_OPTIMIZATION"),
    T: effectiveVariable(targetResult.output, "T")
  };
  const effective = variables.CFLAGS ?? variables.TARGET_CFLAGS ?? "";
  const metadataFlags = optimizationFlags(effective);
  const failures: string[] = [];
  if (targetResult.code !== 0) failures.push(`bitbake -e ${input.target} exited ${targetResult.code}`);
  if (metadataFlags.length !== 1 || metadataFlags[0] !== input.expectedFlag) failures.push(`effective CFLAGS must contain exactly ${input.expectedFlag}; got ${metadataFlags.join(" ") || "no -O flag"}`);

  const tmpDir = resolve(located.config.tmpDir ?? join(located.config.buildDir, "tmp"));
  let compileCommandPath = input.compileCommandPath ? resolve(input.compileCommandPath) : variables.T ? resolve(variables.T, "run.do_compile") : undefined;
  let compileCommands: string[] = [];
  if (compileCommandPath) {
    if (!within(compileCommandPath, tmpDir)) throw new Error(`Compile command path is outside TMPDIR: ${compileCommandPath}`);
    if (await pathExists(compileCommandPath)) {
      const script = (await readFile(compileCommandPath, "utf8")).replace(/\\\r?\n/g, " ");
      compileCommands = script.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
        /(?:^|\s)(?:\S*-(?:gcc|g\+\+)|gcc|g\+\+|cc|c\+\+|clang|clang\+\+)(?:\s|$)/.test(line) && /(?:^|\s)-O(?:fast|[0-3sgz])(?:\s|$)/.test(line));
      for (const command of compileCommands) {
        const flags = optimizationFlags(command);
        if (flags.length !== 1 || flags[0] !== input.expectedFlag) failures.push(`compile argv must contain exactly ${input.expectedFlag}; got ${flags.join(" ") || "no -O flag"}`);
      }
    }
  }
  if (input.requireCompileCommand && !compileCommands.length) failures.push(`no compiler argv with an optimization flag was found${compileCommandPath ? ` in ${compileCommandPath}` : "; bitbake -e did not expose T"}`);

  let reference: Record<string, string | undefined> | undefined;
  let referenceFingerprint: string | undefined;
  let referenceCommand: string[] | undefined;
  if (input.referenceTarget) {
    const result = await environmentForTarget(located, input.referenceTarget);
    referenceCommand = result.command;
    reference = {
      TARGET_CFLAGS: effectiveVariable(result.output, "TARGET_CFLAGS"),
      CFLAGS: effectiveVariable(result.output, "CFLAGS"),
      SELECTED_OPTIMIZATION: effectiveVariable(result.output, "SELECTED_OPTIMIZATION")
    };
    referenceFingerprint = flagFingerprint(reference);
    if (result.code !== 0) failures.push(`bitbake -e ${input.referenceTarget} exited ${result.code}`);
    if (input.expectedReferenceFingerprint && referenceFingerprint !== input.expectedReferenceFingerprint) failures.push(`reference target ${input.referenceTarget} flags changed: expected ${input.expectedReferenceFingerprint}, got ${referenceFingerprint}`);
  }

  const passed = failures.length === 0;
  const capturedAt = new Date().toISOString();
  const evidence: Evidence[] = [{
    id: `ev-${sha256(`${input.target}:${input.expectedFlag}:${JSON.stringify(variables)}:${compileCommands.join("\n")}:${referenceFingerprint ?? ""}:${passed}`).slice(0, 16)}`,
    kind: "metadata",
    executionDomain: "metadata",
    claimType: "configuration",
    source: "bitbake:optimization-assertion",
    ...(compileCommandPath ? { locator: compileCommandPath } : {}),
    fact: passed
      ? `${input.target} has exactly ${input.expectedFlag} in effective CFLAGS${compileCommands.length ? ` and ${compileCommands.length} compiler argv line(s)` : ""}${input.referenceTarget ? `; ${input.referenceTarget} fingerprint is ${referenceFingerprint}` : ""}`
      : `Optimization assertion failed for ${input.target}: ${failures.join("; ")}`,
    conclusion: passed ? "Target-scoped optimization is effective and non-conflicting" : "Do not mark optimization verification PASSED or consume another build iteration until flags are corrected",
    confidence: "high",
    capturedAt,
    sha256: sha256(`${JSON.stringify(variables)}\n${compileCommands.join("\n")}\n${referenceFingerprint ?? ""}`),
    command: [...targetResult.command, ...(referenceCommand ?? [])],
    exitCode: passed ? 0 : 1
  }];
  return {
    passed,
    target: input.target,
    expectedFlag: input.expectedFlag,
    metadataFlags,
    variables,
    ...(compileCommandPath ? { compileCommandPath } : {}),
    compileCommands,
    ...(input.referenceTarget ? { referenceTarget: input.referenceTarget } : {}),
    ...(reference ? { reference } : {}),
    ...(referenceFingerprint ? { referenceFingerprint } : {}),
    failures,
    evidence
  };
}
