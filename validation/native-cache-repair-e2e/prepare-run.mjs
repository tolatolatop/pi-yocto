#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const gitDiffSha = async (cwd) => {
  const { stdout } = await execFileAsync("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], {
    cwd, maxBuffer: 32 * 1024 * 1024
  });
  return sha256(stdout);
};
const gitStatusSha = async (cwd) => {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  return sha256(stdout);
};
const replaceExact = async (path, from, to) => {
  const source = await readFile(path, "utf8");
  if (!source.includes(from)) throw new Error(`Expected locale fixture text not found in ${path}`);
  await writeFile(path, source.replace(from, to));
};
const scenarioDir = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(scenarioDir, "../..");
const runId = process.argv[2] ?? `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`Unsafe run id: ${runId}`);
const runRoot = join(scenarioDir, "runs", runId);
try { await stat(runRoot); throw new Error(`Run already exists: ${runRoot}`); }
catch (error) { if (error?.code !== "ENOENT") throw error; }

const upstreamPoky = "/home/agent/poky/poky-src";
const downloads = "/home/agent/poky/cache/downloads";
const isolatedPoky = join(runRoot, "poky-src");
await mkdir(runRoot, { recursive: true });
await execFileAsync("cp", ["-a", "--reflink=auto", upstreamPoky, isolatedPoky]);

// This host only supplies C.UTF-8. Prepare compatibility inside the isolated
// fixture so the evaluated agent never needs to patch shared Poky to start.
await replaceExact(join(isolatedPoky, "bitbake/lib/bb/utils.py"),
  'locale.setlocale(locale.LC_CTYPE, ("en_US", "UTF-8"))',
  'locale.setlocale(locale.LC_CTYPE, ("C", "UTF-8"))');
await replaceExact(join(isolatedPoky, "bitbake/lib/bb/utils.py"),
  'os.environ["LC_ALL"] = "en_US.UTF-8"', 'os.environ["LC_ALL"] = "C.UTF-8"');
await replaceExact(join(isolatedPoky, "meta/classes-global/sanity.bbclass"),
  'locale.setlocale(locale.LC_ALL, "en_US.UTF-8")',
  'locale.setlocale(locale.LC_ALL, "C.UTF-8")');
await replaceExact(join(isolatedPoky, "meta/conf/bitbake.conf"),
  'export LC_ALL = "en_US.UTF-8"', 'export LC_ALL = "C.UTF-8"');

const nativeClass = join(isolatedPoky, "meta/classes-recipe/native.bbclass");
const pristine = await readFile(nativeClass);
const pristineSha256 = sha256(pristine);
const repairedSourceDiffSha256 = await gitDiffSha(isolatedPoky);
const repairedSourceStatusSha256 = await gitStatusSha(isolatedPoky);
const upstreamSourceDiffSha256 = await gitDiffSha(upstreamPoky);
const upstreamSourceStatusSha256 = await gitStatusSha(upstreamPoky);
await execFileAsync("git", ["apply", join(scenarioDir, "fixtures/native-machine-pollution.patch")], { cwd: isolatedPoky });
const injectedSha256 = sha256(await readFile(nativeClass));

const builds = [
  ["broken-x86", "qemux86-64", "broken-sstate"],
  ["broken-arm64", "qemuarm64", "broken-sstate"],
  ["fixed-x86", "qemux86-64", "fixed-sstate"],
  ["fixed-arm64", "qemuarm64", "fixed-sstate"]
];
for (const [name, machine, cache] of builds) {
  const build = join(runRoot, name);
  await mkdir(join(build, "conf"), { recursive: true });
  await writeFile(join(build, "conf/local.conf"), `MACHINE = "${machine}"
DISTRO = "poky"
DL_DIR = "${downloads}"
SSTATE_DIR = "${join(runRoot, cache)}"
TMPDIR = "${join(build, "tmp")}"
BB_NO_NETWORK = "1"
PATCHRESOLVE = "noop"
INHERIT:remove = "create-spdx"
BB_NUMBER_THREADS ?= "8"
PARALLEL_MAKE ?= "-j8"
`);
  await writeFile(join(build, "conf/bblayers.conf"), `POKY_BBLAYERS_CONF_VERSION = "2"
BBPATH = "\${TOPDIR}"
BBFILES ?= ""
BBLAYERS ?= " \\
  ${isolatedPoky}/meta \\
  ${isolatedPoky}/meta-poky \\
  ${isolatedPoky}/meta-yocto-bsp \\
  "
`);
  await mkdir(join(build, ".pi"), { recursive: true });
  await writeFile(join(build, ".pi/yocto.json"), `${JSON.stringify({
    schemaVersion: "1.0.0", sourceDir: isolatedPoky, buildDir: build,
    machine, distro: "poky", layers: [`${isolatedPoky}/meta`, `${isolatedPoky}/meta-poky`, `${isolatedPoky}/meta-yocto-bsp`],
    dlDir: downloads, sstateDir: join(runRoot, cache), tmpDir: join(build, "tmp"),
    offline: { bitbakeNoNetwork: true, blockExplicitNetworkCommands: true },
    limits: { maxParallelAgents: 1, maxWorkflowDepth: 2, maxFixIterations: 2 }
  }, null, 2)}\n`);
}
await mkdir(join(runRoot, "broken-sstate"), { recursive: true });
await mkdir(join(runRoot, "fixed-sstate"), { recursive: true });
await mkdir(join(runRoot, "logs"), { recursive: true });
await mkdir(join(runRoot, "controller"), { recursive: true });

const manifest = {
  schemaVersion: "1.0.0", runId, runRoot, upstreamPoky, isolatedPoky, downloads,
  target: "autoconf-native", machines: ["qemux86-64", "qemuarm64"],
  pristineNativeClassSha256: pristineSha256, injectedNativeClassSha256: injectedSha256,
  repairedSourceDiffSha256, repairedSourceStatusSha256,
  upstreamSourceDiffSha256, upstreamSourceStatusSha256,
  cachesInitiallyEmpty: [join(runRoot, "broken-sstate"), join(runRoot, "fixed-sstate")],
  createdAt: new Date().toISOString()
};
await writeFile(join(runRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(runRoot, "TASK.md"), `# Task

The native sstate cache in this isolated Yocto workspace has regressed. Native
tools built for qemux86-64 are unexpectedly rebuilt when the target changes to
qemuarm64 on the same build host.

Act as an autonomous pi-yocto engineer. Establish a reproducible broken
baseline using broken-x86 then broken-arm64 and the initially empty shared
broken-sstate cache. Diagnose the first effective signature/key difference
using current metadata, logs, bitbake-dumpsig/diffsigs, and the pi-yocto native
cache inspection capability where useful (run node ${join(repoRoot, "dist/src/cli.js")} cache native
from the relevant build directory). Locate and repair the root cause in the
isolated Poky copy only. The only Poky source file you may change is
meta/classes-recipe/native.bbclass; locale and PATH are already prepared. The
repair must restore that file byte-for-byte and restore upstream native semantics,
not hide variables globally with a broad hash-ignore workaround.

Then use the initially empty fixed-sstate cache: cold-build autoconf-native in
fixed-x86, confirm fixed-arm64 has a fresh TMPDIR, and build it there. Prove
cross-target reuse with exact Sstate summaries, task stamps/work directories,
and native siginfo. The fixed arm64 build must restore all demanded sstate
objects locally and must not execute real do_configure/do_compile/do_install.

Save complete build output as logs/broken-x86.log, logs/broken-arm64.log,
logs/fixed-x86.log, and logs/fixed-arm64.log. Save a concise diagnosis and the
repair diff as diagnosis.md and repair.diff. Save signature-evidence.md with
the exact commands and verbatim output lines for effective PACKAGE_ARCH,
MACHINE_ARCH and BUILD_ARCH values, plus real 64-hex Computed base/task hashes
from bitbake-dumpsig or explanatory output from bitbake-diffsigs. Do not use
inferred or abbreviated hashes. Correlate them with actual sstate filenames.
Every BitBake command must explicitly set BB_NO_NETWORK=1. You may read
/home/agent/poky, but do not write there or anywhere outside this run root. Do
not use shared sstate; do not use clean, cleansstate, cleanall, or -f. The four
TMPDIRs and both caches are fresh at handoff, so do not delete or empty them.
Independently retry safe failures inside the run root and
finish with a strict PASS/FAIL report.
`);
process.stdout.write(`${JSON.stringify({ runRoot, task: join(runRoot, "TASK.md"), manifest: join(runRoot, "manifest.json") }, null, 2)}\n`);
