import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { pathExists, sha256 } from "./fs-utils.js";
import { runCommand } from "./process.js";
import type { Evidence } from "./types.js";

const criticalPatterns: Array<{ category: string; pattern: RegExp }> = [
  { category: "fetch", pattern: /Fetcher failure|FetchError|Unable to fetch URL|NetworkAccess/i },
  { category: "parse", pattern: /ParseError|ExpansionError|unparsed line|Unable to parse/i },
  { category: "patch", pattern: /do_patch.*failed|Hunk #\d+ FAILED|malformed patch/i },
  { category: "configure", pattern: /do_configure.*failed|configure: error|CMake Error/i },
  { category: "compile", pattern: /do_compile.*failed|fatal error:|undefined reference|ninja: build stopped/i },
  { category: "install", pattern: /do_install.*failed|cannot stat|installed-vs-shipped/i },
  { category: "package", pattern: /do_package.*failed|^ERROR:.*QA Issue:|package.*contains bad RPATH/i },
  { category: "rootfs", pattern: /do_rootfs.*failed|Unable to install packages|Solver encountered/i },
  { category: "image", pattern: /do_image.*failed|No space left on device/i },
  { category: "qemu", pattern: /runqemu.*error|Failed to boot|QEMU.*failed|Kernel panic/i },
  { category: "generic", pattern: /^(?:ERROR|FATAL):|Command Error|ExecutionError/i }
];

export interface LogAnalysis {
  path: string;
  task?: string;
  recipe?: string;
  category: string;
  firstCriticalLine?: number;
  firstCriticalError?: string;
  context: string;
  cascadingErrors: string[];
  evidence: Evidence[];
}

async function newestLog(root: string): Promise<string | undefined> {
  const result = await runCommand("find", [root, "-type", "f", "(", "-name", "log.do_*", "-o", "-name", "console-latest.log", ")", "-printf", "%T@ %p\n"], {
    cwd: root,
    timeoutMs: 20_000,
    maxOutputBytes: 8 * 1024 * 1024
  });
  if (result.code !== 0) return undefined;
  const candidates = result.stdout.trim().split("\n").filter(Boolean).sort((a, b) => Number(b.split(" ")[0]) - Number(a.split(" ")[0])).slice(0, 100).map((line) => line.replace(/^\S+\s+/, ""));
  for (const candidate of candidates) {
    const content = await readFile(candidate, "utf8").catch(() => "");
    if (content.split(/\r?\n/).some((line) => criticalPatterns.some(({ pattern }) => pattern.test(line)))) return candidate;
  }
  return candidates[0];
}

export async function analyzeLog(located: LocatedConfig, requestedPath?: string): Promise<LogAnalysis> {
  const tmpDir = located.config.tmpDir ?? join(located.config.buildDir, "tmp");
  const path = requestedPath ? resolve(requestedPath) : await newestLog(tmpDir);
  if (!path || !(await pathExists(path))) throw new Error(`No Yocto log found${requestedPath ? ` at ${requestedPath}` : ` under ${tmpDir}`}`);
  const info = await stat(path);
  const maxBytes = 16 * 1024 * 1024;
  const content = await readFile(path, "utf8");
  const referencedFailure = [...content.matchAll(/Logfile of failure stored in:\s*(\S+)/g)].at(-1)?.[1];
  if (referencedFailure && resolve(referencedFailure) !== path && await pathExists(resolve(referencedFailure))) return analyzeLog(located, referencedFailure);
  const analyzed = content.length > maxBytes ? content.slice(-maxBytes) : content;
  const lines = analyzed.split(/\r?\n/);
  let firstIndex = -1;
  let category = "unknown";
  outer: for (let index = 0; index < lines.length; index += 1) {
    for (const candidate of criticalPatterns) {
      if (candidate.pattern.test(lines[index] ?? "")) {
        firstIndex = index;
        category = candidate.category;
        break outer;
      }
    }
  }
  const cascade = lines.filter((line, index) => index > firstIndex && /^(?:ERROR|FATAL):|Task .* failed/i.test(line)).slice(0, 20);
  const task = path.match(/log\.(do_[^/.]+)/)?.[1];
  const recipe = path.match(/\/work\/[^/]+\/([^/]+)\/[^/]+\/temp\//)?.[1];
  if ((category === "generic" || category === "unknown") && task) {
    const taskCategory: Record<string, string> = { do_fetch: "fetch", do_patch: "patch", do_configure: "configure", do_compile: "compile", do_install: "install", do_package: "package", do_package_qa: "package", do_recipe_qa: "package", do_rootfs: "rootfs", do_image: "image" };
    category = taskCategory[task] ?? category;
  }
  const firstLine = firstIndex >= 0 ? lines[firstIndex] : undefined;
  const actualLine = firstIndex >= 0 ? Math.max(1, content.split(/\r?\n/).length - lines.length + firstIndex + 1) : undefined;
  const fact = firstLine ? `First critical ${category} error: ${firstLine.trim()}` : "No known critical error signature found";
  const evidence: Evidence[] = [{
    id: `ev-${sha256(`${path}:${actualLine}:${fact}`).slice(0, 16)}`,
    kind: "log",
    executionDomain: "build",
    claimType: "diagnosis",
    source: path,
    ...(actualLine ? { locator: `line ${actualLine}` } : { locator: `last ${Math.min(info.size, maxBytes)} bytes` }),
    fact,
    confidence: firstLine ? "high" : "low",
    capturedAt: new Date().toISOString(),
    sha256: sha256(content)
  }];
  return {
    path,
    ...(task ? { task } : {}),
    ...(recipe ? { recipe } : {}),
    category,
    ...(actualLine ? { firstCriticalLine: actualLine } : {}),
    ...(firstLine ? { firstCriticalError: firstLine.trim() } : {}),
    context: firstIndex >= 0 ? lines.slice(Math.max(0, firstIndex - 12), firstIndex + 30).join("\n") : lines.slice(-80).join("\n"),
    cascadingErrors: cascade,
    evidence
  };
}
