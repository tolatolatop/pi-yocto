import { extname, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  category: "safe" | "network" | "destructive" | "force" | "git-write" | "workspace-write";
  reason: string;
}

const networkPattern = /(^|[;&|]\s*|\b)(curl|wget|git\s+clone|npm\s+(?:install|i|ci)|pip\s+install|cargo\s+install)\b/i;
const destructivePattern = /(?:^|[;&|\n]\s*|\b(?:sudo|command|xargs)\s+)(?:rm|rmdir|unlink|shred)(?:\s|$)|\bfind\b[^\n;&|]*\s-delete\b|\b(?:cleanall|cleansstate|bitbake\s+[^\n]*-c\s+clean|bitbake-layers\s+(?:add-layer|remove-layer))\b/i;
const forcePattern = /\bbitbake\b[^\n]*(?:\s-f\b|--force\b)/i;
const gitWritePattern = /\bgit\s+(?:commit|push|reset|clean|checkout|restore|rebase|merge|apply|am)\b/i;
const shellWritePattern = /\b(?:apply_patch|patch|tee|truncate|install|mv|cp|chmod|chown)\b|\bsed\b[^\n]*\s-i(?:\s|$)|\bperl\b[^\n]*\s-pi(?:\s|$)|(?:^|[;&|]\s*|\s)(?:>|>>)[^=]/i;

export function classifyCommand(command: string, offline = true): PolicyDecision {
  if (offline && networkPattern.test(command)) return { allowed: false, requiresApproval: true, category: "network", reason: "Explicit network command is blocked by the offline policy" };
  if (destructivePattern.test(command)) return { allowed: false, requiresApproval: true, category: "destructive", reason: "Deleting files, cleaning build state, or changing layer configuration requires exact approval" };
  if (forcePattern.test(command)) return { allowed: false, requiresApproval: true, category: "force", reason: "Forced task execution requires evidence and approval" };
  if (gitWritePattern.test(command)) return { allowed: false, requiresApproval: true, category: "git-write", reason: "Git history/worktree mutation requires approval" };
  if (shellWritePattern.test(command)) return { allowed: false, requiresApproval: true, category: "workspace-write", reason: "Shell-based file mutation requires an exact human approval" };
  return { allowed: true, requiresApproval: false, category: "safe", reason: "Read-only check or ordinary incremental operation" };
}

export function classifyFileWrite(located: LocatedConfig, path: string): PolicyDecision {
  const absolute = resolve(path);
  const source = resolve(located.config.sourceDir);
  const build = resolve(located.config.buildDir);
  const sensitiveExtensions = new Set([".bb", ".bbappend", ".inc", ".conf", ".bbclass", ".patch", ".cfg"]);
  const inSource = absolute === source || absolute.startsWith(`${source}/`);
  const inLayer = located.config.layers.some((layer) => absolute === resolve(layer) || absolute.startsWith(`${resolve(layer)}/`));
  const inBuildConfig = absolute === resolve(build, "conf") || absolute.startsWith(`${resolve(build, "conf")}/`);
  const inBuild = absolute === build || absolute.startsWith(`${build}/`);
  if (inSource || inLayer || inBuildConfig || (inBuild && sensitiveExtensions.has(extname(absolute)))) {
    return { allowed: false, requiresApproval: true, category: "workspace-write", reason: "Poky source, layer content, or build configuration requires a content-bound ChangeSet approval" };
  }
  return { allowed: true, requiresApproval: false, category: "safe", reason: "Path is outside protected Yocto metadata" };
}

export function validateBitbakeJobArgs(args: string[]): void {
  if (!args.length) throw new Error("At least one BitBake target is required");
  const joined = `bitbake ${args.join(" ")}`;
  const decision = classifyCommand(joined, true);
  if (decision.requiresApproval) throw new Error(decision.reason);
  const safe = /^[A-Za-z0-9][A-Za-z0-9+_.:@/-]*$/;
  const allowedFlags = new Set(["-k", "--continue", "-v", "--verbose", "-D", "-DD", "-DDD", "-n", "--dry-run"]);
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!allowedFlags.has(arg)) throw new Error(`BitBake flag is not allowed for an automatic incremental job: ${arg}`);
    } else if (!safe.test(arg) || arg.includes("..")) throw new Error(`Unsafe BitBake target: ${arg}`);
  }
}
