import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { pathExists, sha256 } from "./fs-utils.js";
import { captureBitbakeEnvironment, runCommand } from "./process.js";
import type { Evidence } from "./types.js";

export interface WorkspaceInspection {
  sourceDir: string;
  buildDir: string;
  commit: string;
  branch: string;
  release: string;
  dirtyFiles: string[];
  protectedDirtyFiles: string[];
  machine: string;
  distro: string;
  layers: Array<{ path: string; exists: boolean; dirtyFiles: string[]; contentHash?: string }>;
  dlDir?: string;
  sstateDir?: string;
  tmpDir: string;
  offline: boolean;
  bitbakeVersion?: string;
  artifacts: string[];
  evidence: Evidence[];
}

async function gitValue(cwd: string, args: string[], fallback = "unknown"): Promise<string> {
  const result = await runCommand("git", args, { cwd, timeoutMs: 10_000 });
  return result.code === 0 ? result.stdout.trim() : fallback;
}

async function findArtifacts(tmpDir: string, machine: string): Promise<string[]> {
  const deploy = join(tmpDir, "deploy");
  if (!(await pathExists(deploy))) return [];
  const result = await runCommand("find", [deploy, "(", "-type", "f", "-o", "-type", "l", ")", "-printf", "%T@ %p\n"], { cwd: deploy, timeoutMs: 20_000, maxOutputBytes: 16 * 1024 * 1024 });
  if (result.code !== 0) return [];
  const preferred = `/images/${machine}/`;
  return result.stdout.trim().split("\n").filter(Boolean)
    .map((line) => ({ mtime: Number(line.split(" ")[0]), path: line.replace(/^\S+\s+/, "") }))
    .sort((a, b) => (Number(b.path.includes(preferred)) - Number(a.path.includes(preferred))) || b.mtime - a.mtime)
    .slice(0, 20).map((entry) => entry.path);
}

function within(path: string, root: string): boolean {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}/`);
}

async function snapshotExternalLayer(root: string): Promise<{ files: string[]; contentHash: string }> {
  const files: string[] = [];
  const entries: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === ".pi-yocto") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const name = relative(root, path);
        const content = await readFile(path);
        files.push(path);
        entries.push(`${name}\0file\0${sha256(content)}`);
      } else if (entry.isSymbolicLink()) {
        const name = relative(root, path);
        files.push(path);
        entries.push(`${name}\0symlink\0${await readlink(path)}`);
      }
      if (files.length > 20_000) throw new Error(`External layer snapshot exceeds 20000 entries: ${root}`);
    }
  };
  await walk(root);
  return { files, contentHash: sha256(entries.join("\n")) };
}

export async function inspectWorkspace(located: LocatedConfig, includeBitbake = false): Promise<WorkspaceInspection> {
  const { config } = located;
  const commit = await gitValue(config.sourceDir, ["rev-parse", "HEAD"]);
  const branch = await gitValue(config.sourceDir, ["branch", "--show-current"], "detached");
  const release = await gitValue(config.sourceDir, ["describe", "--tags", "--always"]);
  const statusResult = await runCommand("git", ["status", "--porcelain=v1"], { cwd: config.sourceDir, timeoutMs: 10_000 });
  const status = statusResult.code === 0 ? statusResult.stdout.trimEnd() : "";
  const dirtyFiles = status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
  const layers = await Promise.all(config.layers.map(async (path) => {
    const exists = await pathExists(path);
    if (!exists) return { path, exists, dirtyFiles: [] };
    if (within(path, config.sourceDir)) {
      const prefix = relative(config.sourceDir, path);
      const layerDirty = dirtyFiles.filter((file) => file === prefix || file.startsWith(`${prefix}/`)).map((file) => join(config.sourceDir, file));
      return { path, exists, dirtyFiles: layerDirty, contentHash: sha256(`${commit}\n${layerDirty.join("\n")}`) };
    }
    const snapshot = await snapshotExternalLayer(path);
    return { path, exists, dirtyFiles: snapshot.files, contentHash: snapshot.contentHash };
  }));
  const tmpDir = config.tmpDir ?? join(config.buildDir, "tmp");
  let bitbakeVersion: string | undefined;
  if (includeBitbake) {
    const env = await captureBitbakeEnvironment(config);
    const result = await runCommand("bitbake", ["--version"], { cwd: config.buildDir, env, timeoutMs: 30_000, umask: 0o022 });
    bitbakeVersion = (result.stdout || result.stderr).trim();
  }
  const artifacts = await findArtifacts(tmpDir, config.machine);
  const externalLayerFiles = layers.filter((layer) => !within(layer.path, config.sourceDir)).reduce((count, layer) => count + layer.dirtyFiles.length, 0);
  const fact = `Poky ${branch}@${commit}; MACHINE=${config.machine}; DISTRO=${config.distro}; source dirty paths=${dirtyFiles.length}; external layer snapshot files=${externalLayerFiles}; offline=${config.offline.bitbakeNoNetwork}`;
  return {
    sourceDir: config.sourceDir,
    buildDir: config.buildDir,
    commit,
    branch,
    release,
    dirtyFiles,
    protectedDirtyFiles: [...dirtyFiles.map((file) => join(config.sourceDir, file)), ...layers.filter((layer) => !within(layer.path, config.sourceDir)).flatMap((layer) => layer.dirtyFiles)],
    machine: config.machine,
    distro: config.distro,
    layers,
    ...(config.dlDir ? { dlDir: config.dlDir } : {}),
    ...(config.sstateDir ? { sstateDir: config.sstateDir } : {}),
    tmpDir,
    offline: config.offline.bitbakeNoNetwork,
    ...(bitbakeVersion ? { bitbakeVersion } : {}),
    artifacts,
    evidence: [{
      id: `ev-${sha256(`${config.sourceDir}:${commit}:${status}:${config.machine}:${config.distro}`).slice(0, 16)}`,
      kind: "source",
      executionDomain: "source",
      claimType: "observation",
      source: config.sourceDir,
      locator: commit,
      fact,
      confidence: commit === "unknown" ? "medium" : "high",
      capturedAt: new Date().toISOString(),
      sha256: sha256(`${commit}\n${status}\n${layers.map((layer) => `${layer.path}:${layer.contentHash ?? "missing"}`).join("\n")}`)
    }]
  };
}

export async function readLayerSeries(sourceDir: string): Promise<string> {
  const conf = await readFile(join(sourceDir, "meta", "conf", "layer.conf"), "utf8").catch(() => "");
  return conf.match(/LAYERSERIES_CORENAMES\s*=\s*"([^"]+)"/)?.[1]?.split(/\s+/).at(-1) ?? basename(sourceDir);
}
