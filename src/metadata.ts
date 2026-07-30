import type { LocatedConfig } from "./config.js";
import { sha256 } from "./fs-utils.js";
import { captureBitbakeEnvironment, runCommand } from "./process.js";
import type { Evidence } from "./types.js";

export type MetadataAction = "environment" | "parse" | "graph" | "layers" | "recipes" | "appends" | "tasks";

const safeToken = /^[A-Za-z0-9][A-Za-z0-9+_.:@/-]*$/;

function validateToken(value: string, label: string): void {
  if (!safeToken.test(value) || value.startsWith("-") || value.includes("..")) throw new Error(`Unsafe ${label}: ${value}`);
}

function extractVariable(output: string, variable?: string): string {
  if (!variable) return output;
  validateToken(variable, "variable");
  const lines = output.split(/\r?\n/);
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignment = new RegExp(`^(?:export\\s+)?${escaped}(?:\[[^\]]+\])?=`);
  const positions = lines.flatMap((line, index) => assignment.test(line) ? [index] : []);
  if (!positions.length) return `Variable ${variable} was not present in bitbake -e output`;
  return positions.map((index) => lines.slice(Math.max(0, index - 12), index + 2).join("\n")).join("\n\n");
}

export async function queryMetadata(located: LocatedConfig, request: { action: MetadataAction; target?: string; variable?: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
  const args: string[] = [];
  if (request.target) validateToken(request.target, "target");
  switch (request.action) {
    case "environment":
      if (!request.target) throw new Error("environment requires target");
      args.push("-e", request.target);
      break;
    case "parse": args.push("-p"); break;
    case "graph":
      if (!request.target) throw new Error("graph requires target");
      args.push("-g", request.target);
      break;
    case "tasks":
      if (!request.target) throw new Error("tasks requires target");
      args.push("-c", "listtasks", request.target);
      break;
    case "layers": args.push("show-layers"); break;
    case "recipes": args.push("show-recipes", ...(request.target ? [request.target] : [])); break;
    case "appends": args.push("show-appends"); break;
  }
  const executable = ["layers", "recipes", "appends"].includes(request.action) ? "bitbake-layers" : "bitbake";
  const env = await captureBitbakeEnvironment(located.config);
  const result = await runCommand(executable, args, {
    cwd: located.config.buildDir,
    env,
    timeoutMs: Math.min(request.timeoutMs ?? 120_000, 600_000),
    maxOutputBytes: request.action === "environment" ? 32 * 1024 * 1024 : 8 * 1024 * 1024,
    umask: 0o022
  });
  const output = request.action === "environment" ? extractVariable(result.stdout, request.variable) : result.stdout;
  const capturedAt = new Date().toISOString();
  const outputHash = sha256(`${output}\n${result.stderr}`);
  const claimTypes: Evidence["claimType"][] = request.action === "parse"
    ? ["execution"]
    : ["observation", "configuration", "diagnosis"];
  const evidence: Evidence[] = claimTypes.map((claimType) => ({
    id: `ev-${sha256(`${result.command.join("\0")}:${result.code}:${output}:${claimType}`).slice(0, 16)}`,
    kind: "metadata",
    executionDomain: "metadata",
    claimType,
    source: `${executable}:${request.action}`,
    locator: result.cwd,
    fact: `${result.command.join(" ")} exited ${result.code}${request.variable ? ` while resolving ${request.variable}` : ""}; captured metadata is available for ${claimType}`,
    confidence: result.code === 0 ? "high" : "medium",
    capturedAt,
    sha256: outputHash,
    command: result.command,
    exitCode: result.code
  }));
  return {
    command: result.command,
    cwd: result.cwd,
    offline: env.BB_NO_NETWORK === "1",
    exitCode: result.code,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    output: output.slice(-2_000_000),
    stderr: result.stderr.slice(-100_000)
    ,evidence
  };
}
