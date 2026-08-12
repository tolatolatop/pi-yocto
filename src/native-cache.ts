import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { pathExists, sha256 } from "./fs-utils.js";
import { captureBitbakeEnvironment, runCommand } from "./process.js";
import type { Evidence } from "./types.js";

const safeTarget = /^[A-Za-z0-9][A-Za-z0-9+_.:@-]*-native$/;
const cacheVariables = [
  "SSTATE_DIR", "SSTATE_MIRRORS", "SSTATE_PKGARCH", "SSTATE_VERSION", "SSTATE_EXCLUDEDEPS_SYSROOT",
  "DL_DIR", "TMPDIR", "NATIVELSBSTRING", "UNINATIVE_CHECKSUM", "BB_SIGNATURE_HANDLER",
  "BB_HASHSERVE", "BB_HASHSERVE_UPSTREAM", "BB_BASEHASH_IGNORE_VARS", "BB_ENV_PASSTHROUGH_ADDITIONS",
  "BUILD_ARCH", "BUILD_OS", "BUILD_SYS", "HOST_ARCH", "HOST_OS", "HOST_SYS", "TARGET_ARCH",
  "TARGET_OS", "TARGET_SYS", "PACKAGE_ARCH", "MACHINE", "MACHINE_ARCH", "MACHINEOVERRIDES",
  "MACHINE_FEATURES", "DEFAULTTUNE", "TUNE_FEATURES", "TUNE_PKGARCH"
] as const;

export interface VariableInspection { name: string; value?: string; history: string[] }
export interface SstateSummary {
  wanted: number; local: number; mirrors: number; missed: number; current: number;
  matchPercent?: number; completePercent?: number; line: string;
}
export interface SignatureInspection {
  path: string; taskDependencies: string[]; suspiciousDependencies: string[];
  architectureValues: Record<string, string>; dumpsigError?: string;
}
export interface NativeCacheInspection {
  target: string;
  effective: VariableInspection[];
  environment: Record<string, string>;
  consoleLog?: string;
  sstate?: SstateSummary;
  signature?: SignatureInspection;
  findings: Array<{ severity: "info" | "warning" | "error"; code: string; detail: string }>;
  recommendations: string[];
  evidence: Evidence[];
}

function unquote(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value.at(-1) === '"') return value.slice(1, -1).replace(/\\"/g, '"');
  return value;
}

export function parseBitbakeVariables(output: string, names: readonly string[] = cacheVariables): VariableInspection[] {
  const wanted = new Set(names);
  const result = new Map<string, VariableInspection>();
  let history: string[] = [];
  let historyName: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const historyStart = line.match(/^# \$([A-Za-z0-9_]+)(?:\s|$)/)?.[1];
    if (historyStart) {
      historyName = wanted.has(historyStart) ? historyStart : undefined;
      history = historyName ? [line.slice(0, 500)] : [];
      continue;
    }
    if (line.startsWith("#")) {
      if (historyName && history.length < 20) history.push(line.slice(0, 500));
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z0-9_]+)="(.*)"$/);
    if (match && wanted.has(match[1] ?? "")) {
      const name = match[1] ?? "";
      result.set(name, { name, value: unquote(`"${match[2] ?? ""}"`), history: historyName === name ? history.slice() : [] });
    }
    history = [];
    historyName = undefined;
  }
  return names.map((name) => result.get(name) ?? { name, history: [] });
}

export function parseSstateSummary(output: string): SstateSummary | undefined {
  const lines = output.split(/\r?\n/).filter((line) => /Sstate summary:/i.test(line));
  const line = lines.at(-1);
  if (!line) return undefined;
  const match = line.match(/Wanted\s+(\d+)\s+Local\s+(\d+)\s+Mirrors\s+(\d+)\s+Missed\s+(\d+)\s+Current\s+(\d+)(?:\s+\((\d+)%\s+match,\s+(\d+)%\s+complete\))?/i);
  if (!match) return undefined;
  return {
    wanted: Number(match[1]), local: Number(match[2]), mirrors: Number(match[3]), missed: Number(match[4]), current: Number(match[5]),
    ...(match[6] ? { matchPercent: Number(match[6]) } : {}), ...(match[7] ? { completePercent: Number(match[7]) } : {}), line: line.trim()
  };
}

function parseDumpsig(output: string): Omit<SignatureInspection, "path"> {
  const dependencyLine = output.match(/^Task dependencies:\s*\[(.*)\]$/m)?.[1] ?? "";
  const taskDependencies = [...dependencyLine.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1] ?? "");
  const suspiciousNames = new Set(["MACHINE", "MACHINE_ARCH", "MACHINEOVERRIDES", "MACHINE_FEATURES", "DEFAULTTUNE", "TUNE_FEATURES", "TUNE_PKGARCH", "TARGET_FPU"]);
  const suspiciousDependencies = taskDependencies.filter((name) => suspiciousNames.has(name));
  const architectureValues: Record<string, string> = {};
  for (const match of output.matchAll(/^Variable\s+([A-Z0-9_]+)\s+value is\s+(.*)$/gm)) {
    const name = match[1] ?? "";
    if (/^(?:BUILD|HOST|TARGET|TUNE|MACHINE|PACKAGE_ARCH)/.test(name)) architectureValues[name] = match[2] ?? "";
  }
  return { taskDependencies, suspiciousDependencies, architectureValues };
}

async function newestFile(root: string, args: string[]): Promise<string | undefined> {
  if (!(await pathExists(root))) return undefined;
  const result = await runCommand("find", [root, "-type", "f", ...args, "-printf", "%T@ %p\n"], { cwd: root, timeoutMs: 20_000, maxOutputBytes: 8 * 1024 * 1024 });
  if (result.code !== 0) return undefined;
  return result.stdout.trim().split("\n").filter(Boolean).sort((a, b) => Number(b.split(" ")[0]) - Number(a.split(" ")[0])).at(0)?.replace(/^\S+\s+/, "");
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function inspectNativeCache(located: LocatedConfig, request: { target?: string; logPath?: string; sigPath?: string } = {}): Promise<NativeCacheInspection> {
  const target = request.target ?? "autoconf-native";
  if (!safeTarget.test(target)) throw new Error(`Native cache inspection requires a safe -native target, got ${target}`);
  const env = await captureBitbakeEnvironment(located.config);
  const metadata = await runCommand("bitbake", ["-e", target], { cwd: located.config.buildDir, env, timeoutMs: 180_000, maxOutputBytes: 64 * 1024 * 1024, umask: 0o022 });
  if (metadata.code !== 0) throw new Error(`bitbake -e ${target} failed: ${metadata.stderr || metadata.stdout.slice(-4000)}`);
  const effective = parseBitbakeVariables(metadata.stdout);
  const values = Object.fromEntries(effective.filter((item) => item.value !== undefined).map((item) => [item.name, item.value ?? ""]));
  const findings: NativeCacheInspection["findings"] = [];
  const recommendations: string[] = [];
  const sstateDir = values.SSTATE_DIR;
  if (!sstateDir) findings.push({ severity: "error", code: "SSTATE_DIR_UNRESOLVED", detail: "Effective SSTATE_DIR was not present in bitbake -e output" });
  else if (isInside(sstateDir, located.config.buildDir)) {
    findings.push({ severity: "warning", code: "SSTATE_INSIDE_BUILD", detail: `SSTATE_DIR=${sstateDir} is inside the build directory and cannot be shared cleanly across build directories` });
    recommendations.push('Set SSTATE_DIR to an absolute external path such as "/data/.cache/sstate-cache" in conf/local.conf or a shared site/distro configuration.');
  } else findings.push({ severity: "info", code: "SSTATE_EXTERNAL", detail: `SSTATE_DIR=${sstateDir} is outside the build directory` });
  if (located.config.sstateDir && sstateDir && resolve(located.config.sstateDir) !== resolve(sstateDir)) {
    findings.push({ severity: "warning", code: "DISCOVERED_SSTATE_STALE", detail: `.pi/yocto.json records ${located.config.sstateDir}, but BitBake resolves ${sstateDir}` });
    recommendations.push("Run pi-yocto init again after configuration changes so the recorded workspace cache path matches effective BitBake metadata.");
  }
  if (values.MACHINEOVERRIDES) findings.push({ severity: "warning", code: "NATIVE_MACHINE_OVERRIDES", detail: `${target} resolves MACHINEOVERRIDES=${values.MACHINEOVERRIDES}; native.bbclass normally clears it` });
  if (values.MACHINE_FEATURES) findings.push({ severity: "info", code: "NATIVE_MACHINE_FEATURES_DATASTORE", detail: `${target} retains MACHINE_FEATURES=${values.MACHINE_FEATURES} in metadata; this is not signature pollution unless the inspected task depends on it` });
  if (values.TARGET_ARCH && values.BUILD_ARCH && values.TARGET_ARCH !== values.BUILD_ARCH) findings.push({ severity: "warning", code: "NATIVE_TARGET_ARCH", detail: `${target} TARGET_ARCH=${values.TARGET_ARCH} differs from BUILD_ARCH=${values.BUILD_ARCH}` });
  if (values.PACKAGE_ARCH && values.BUILD_ARCH && values.PACKAGE_ARCH !== values.BUILD_ARCH) findings.push({ severity: "warning", code: "NATIVE_PACKAGE_ARCH", detail: `${target} PACKAGE_ARCH=${values.PACKAGE_ARCH} differs from BUILD_ARCH=${values.BUILD_ARCH}` });

  const logRoot = join(located.config.tmpDir ?? join(located.config.buildDir, "tmp"), "log", "cooker");
  const consoleLog = request.logPath ? resolve(request.logPath) : await newestFile(logRoot, ["-name", "*.log"]);
  let sstate: SstateSummary | undefined;
  if (consoleLog && await pathExists(consoleLog)) sstate = parseSstateSummary(await readFile(consoleLog, "utf8"));
  if (!consoleLog) findings.push({ severity: "warning", code: "NO_COOKER_LOG", detail: `No cooker log found under ${logRoot}; run a normal BitBake build to measure cache use` });
  else if (!sstate) findings.push({ severity: "warning", code: "NO_SSTATE_SUMMARY", detail: `No Sstate summary was found in ${consoleLog}` });
  else {
    const restored = sstate.local + sstate.mirrors;
    const demand = restored + sstate.missed;
    findings.push({ severity: sstate.missed > 0 ? "warning" : "info", code: "SSTATE_RESULT", detail: `${sstate.line}; ${demand ? `restore hit rate=${Math.round(restored * 100 / demand)}% excluding Current` : "no sstate restore was demanded; Current alone does not prove cross-build cache restoration"}` });
    if (sstate.missed > 0) recommendations.push("Use bitbake-diffsigs on signatures from equivalent builds before changing hash exclusions; identify the first changed effective input.");
  }

  const stampRoot = join(located.config.tmpDir ?? join(located.config.buildDir, "tmp"), "stamps");
  const sigPath = request.sigPath ? resolve(request.sigPath) : await newestFile(stampRoot, ["-path", `*/${target}/*`, "(", "-name", "*.do_populate_sysroot.sigdata.*", "-o", "-name", "*.do_compile.sigdata.*", "-o", "-name", "*.siginfo", ")"]);
  let signature: SignatureInspection | undefined;
  if (sigPath) {
    const dump = await runCommand("bitbake-dumpsig", [sigPath], { cwd: located.config.buildDir, env, timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024, umask: 0o022 });
    signature = dump.code === 0 ? { path: sigPath, ...parseDumpsig(dump.stdout) } : { path: sigPath, taskDependencies: [], suspiciousDependencies: [], architectureValues: {}, dumpsigError: (dump.stderr || dump.stdout).slice(-4000) };
    if (signature.suspiciousDependencies.length) {
      findings.push({ severity: "warning", code: "TARGET_ARCH_SIGNATURE_DEPS", detail: `${signature.suspiciousDependencies.join(", ")} are effective task dependencies in ${sigPath}` });
      recommendations.push("Trace each suspicious variable through bitbake-dumpsig/bitbake-diffsigs. Move target-specific generation into the consuming target recipe unless the native executable itself must differ.");
    }
  } else findings.push({ severity: "info", code: "NO_NATIVE_SIGNATURE", detail: `No existing signature was found for ${target}; build it once to enable signature dependency inspection` });

  const environment = Object.fromEntries(["BB_ENV_PASSTHROUGH_ADDITIONS", "BB_NO_NETWORK", "PATH", "LOCPATH", "LANG", "LC_ALL"].flatMap((name) => env[name] === undefined ? [] : [[name, env[name] ?? ""]]));
  const evidenceSource = consoleLog ?? located.config.buildDir;
  const evidenceText = JSON.stringify({ target, effective, environment, sstate, signature, findings });
  const evidence: Evidence[] = [{
    id: `ev-${sha256(evidenceText).slice(0, 16)}`, kind: "metadata", executionDomain: "metadata", claimType: "diagnosis",
    source: "pi-yocto:native-cache", locator: evidenceSource,
    fact: `Inspected effective native cache configuration, cooker sstate summary, and available signature dependencies for ${target}`,
    confidence: metadata.code === 0 ? "high" : "medium", capturedAt: new Date().toISOString(), sha256: sha256(evidenceText),
    command: metadata.command, exitCode: metadata.code
  }];
  return { target, effective, environment, ...(consoleLog ? { consoleLog } : {}), ...(sstate ? { sstate } : {}), ...(signature ? { signature } : {}), findings, recommendations, evidence };
}
