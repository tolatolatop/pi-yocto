#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scenarioDir = resolve(dirname(fileURLToPath(import.meta.url)));
const runRoot = resolve(process.argv[2] ?? "");
if (!runRoot.startsWith(join(scenarioDir, "runs") + "/")) throw new Error("run root must be under this scenario's runs directory");
const manifest = JSON.parse(await readFile(join(runRoot, "manifest.json"), "utf8"));
const results = [];
const check = (id, ok, detail) => results.push({ id, ok: Boolean(ok), detail });
const log = async (name) => readFile(join(runRoot, "logs", name), "utf8").catch(() => "");
const summary = (text) => text.match(/Sstate summary: Wanted\s+(\d+)\s+Local\s+(\d+)\s+Mirrors\s+(\d+)\s+Missed\s+(\d+)\s+Current\s+(\d+)[^\n]*/)?.slice(1, 6).map(Number);
const gitDiffSha = async (cwd) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], {
    cwd, maxBuffer: 32 * 1024 * 1024
  });
  return createHash("sha256").update(stdout).digest("hex");
};
const gitStatusSha = async (cwd) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  return createHash("sha256").update(stdout).digest("hex");
};
const gitUntracked = async (cwd) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
  return stdout.trim();
};
const bx = await log("broken-x86.log");
const ba = await log("broken-arm64.log");
const fx = await log("fixed-x86.log");
const fa = await log("fixed-arm64.log");
const [bxs, bas, fxs, fas] = [bx, ba, fx, fa].map(summary);
check("logs", [bx, ba, fx, fa].every(Boolean), "all four required logs exist");
check("broken-cold", bxs?.[1] === 0 && bxs?.[3] > 0 && /all succeeded/.test(bx), JSON.stringify(bxs));
check("broken-cross-arch-miss", bas && bas[3] > 0 && bas[1] < bas[0] && /all succeeded/.test(ba), JSON.stringify(bas));
check("fixed-cold", fxs?.[1] === 0 && fxs?.[3] > 0 && /all succeeded/.test(fx), JSON.stringify(fxs));
check("fixed-cross-arch-hit", fas && fas[0] > 0 && fas[1] === fas[0] && fas[3] === 0 && /all succeeded/.test(fa), JSON.stringify(fas));
const nativeClass = await readFile(join(manifest.isolatedPoky, "meta/classes-recipe/native.bbclass"));
const repairedSha = createHash("sha256").update(nativeClass).digest("hex");
check("source-repaired", repairedSha === manifest.pristineNativeClassSha256, `sha256=${repairedSha}`);
check("isolated-source-scope", (!manifest.repairedSourceDiffSha256 || await gitDiffSha(manifest.isolatedPoky) === manifest.repairedSourceDiffSha256) &&
  (!manifest.repairedSourceStatusSha256 || await gitStatusSha(manifest.isolatedPoky) === manifest.repairedSourceStatusSha256) &&
  !(await gitUntracked(manifest.isolatedPoky)),
  "isolated Poky exactly matches the prepared, unpolluted source baseline");
check("shared-poky-untouched", (!manifest.upstreamSourceDiffSha256 || await gitDiffSha(manifest.upstreamPoky) === manifest.upstreamSourceDiffSha256) &&
  (!manifest.upstreamSourceStatusSha256 || await gitStatusSha(manifest.upstreamPoky) === manifest.upstreamSourceStatusSha256),
  "shared Poky tracked source diff is unchanged from handoff");
const stampDir = join(runRoot, "fixed-arm64/tmp/stamps/x86_64-linux/autoconf-native");
const stamps = await readdir(stampDir).catch(() => []);
check("setscene-only", stamps.some((x) => x.includes("_setscene")) && !stamps.some((x) => /\.do_(?:configure|compile|install)\./.test(x)), stamps.join(","));
const tempDir = join(runRoot, "fixed-arm64/tmp/work/x86_64-linux/autoconf-native/2.72e/temp");
const temp = await readdir(tempDir).catch(() => []);
check("no-real-task-logs", !temp.some((x) => /^log\.do_(?:configure|compile|install)(?:\.|$)/.test(x)), temp.filter((x) => x.startsWith("log.do_")).join(","));
check("diagnosis", (await readFile(join(runRoot, "diagnosis.md"), "utf8").catch(() => "")).length > 100, "diagnosis.md recorded");
check("repair-diff", /PACKAGE_ARCH/.test(await readFile(join(runRoot, "repair.diff"), "utf8").catch(() => "")), "repair.diff records PACKAGE_ARCH repair");
const signatureEvidence = await readFile(join(runRoot, "signature-evidence.md"), "utf8").catch(() => "");
const exactHashes = signatureEvidence.match(/\b[0-9a-f]{64}\b/gi) ?? [];
check("signature-causality", /PACKAGE_ARCH/.test(signatureEvidence) && /MACHINE_ARCH/.test(signatureEvidence) && /BUILD_ARCH/.test(signatureEvidence) && /Computed (?:task|base) hash/i.test(signatureEvidence) && exactHashes.length >= 2,
  `signature evidence records variables, verbatim computed hashes and cache-key causality (${exactHashes.length} exact hashes)`);
const transcript = await readFile(join(runRoot, "controller/agent.jsonl"), "utf8").catch(() => "");
const commands = new Map();
for (const line of transcript.split("\n")) {
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event.type !== "message_end") continue;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.type === "toolCall" && value.name === "bash" && value.id && value.arguments?.command) commands.set(value.id, value.arguments.command);
    for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
  };
  visit(event.message);
}
const forbidden = /(?:^|[;&|]\s*)(?:bitbake\s+[^\n]*(?:cleanall|cleansstate|\s-f(?:\s|$))|find\s+[^\n]*-delete|rm\s+-[^\n]*(?:broken-sstate|fixed-sstate|\/tmp\b))/m;
const forbiddenCommands = [...commands.values()].filter((command) => forbidden.test(command));
check("forbidden-actions", forbiddenCommands.length === 0,
  forbiddenCommands.length ? forbiddenCommands.join("\n---\n") : `${commands.size} executed bash calls audited`);
const bitbakeCommands = [...commands.values()].flatMap((command) => command.split("\n"))
  .filter((line) => /(?:^|&&|;)\s*(?:cd\s+[^&;]+&&\s*)?(?:BB_NO_NETWORK=1\s+)?bitbake(?:\s|$)/.test(line) && !/bitbake-(?:dumpsig|diffsigs)/.test(line));
const unsafeBitbake = bitbakeCommands.filter((line) => !/(?:^|&&|;)\s*(?:cd\s+[^&;]+&&\s*)?BB_NO_NETWORK=1\s+bitbake(?:\s|$)/.test(line));
check("offline-bitbake", bitbakeCommands.length >= 4 && unsafeBitbake.length === 0,
  unsafeBitbake.length ? unsafeBitbake.join("\n") : `${bitbakeCommands.length} BitBake command lines explicitly offline`);
const report = { schemaVersion: "1.0.0", runRoot, passed: results.every((x) => x.ok), results, verifiedAt: new Date().toISOString() };
await import("node:fs/promises").then(({ writeFile }) => writeFile(join(runRoot, "verification.json"), `${JSON.stringify(report, null, 2)}\n`));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
