import { Ajv } from "ajv";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceConfigSchema } from "./schemas.js";
import { pathExists, readJson, writeJsonAtomic } from "./fs-utils.js";
import type { WorkspaceConfig } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export interface LocatedConfig {
  rootDir: string;
  configPath: string;
  stateDir: string;
  config: WorkspaceConfig;
}

const validateConfig = new Ajv({ allErrors: true }).compile(workspaceConfigSchema);

function absoluteFrom(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

export async function findConfig(start = process.cwd()): Promise<LocatedConfig> {
  let cursor = resolve(start);
  for (;;) {
    const configPath = join(cursor, ".pi", "yocto.json");
    if (await pathExists(configPath)) {
      const raw = await readJson<WorkspaceConfig>(configPath);
      if (!validateConfig(raw)) {
        const detail = validateConfig.errors?.map((error: { instancePath: string; message?: string }) => `${error.instancePath || "/"} ${error.message}`).join("; ");
        throw new Error(`Invalid ${configPath}: ${detail}`);
      }
      const config: WorkspaceConfig = {
        ...raw,
        sourceDir: absoluteFrom(cursor, raw.sourceDir),
        buildDir: absoluteFrom(cursor, raw.buildDir),
        layers: raw.layers.map((layer) => absoluteFrom(cursor, layer)),
        ...(raw.dlDir ? { dlDir: absoluteFrom(cursor, raw.dlDir) } : {}),
        ...(raw.sstateDir ? { sstateDir: absoluteFrom(cursor, raw.sstateDir) } : {}),
        ...(raw.tmpDir ? { tmpDir: absoluteFrom(cursor, raw.tmpDir) } : {})
      };
      return { rootDir: cursor, configPath, stateDir: join(cursor, ".pi-yocto"), config };
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`No .pi/yocto.json found from ${start}; run pi-yocto init`);
}

function parseAssignment(text: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...text.matchAll(new RegExp(`^\\s*${escaped}(?:[:?+.]?=|\\s+\\?{0,2}=)\\s*["']([^"']+)["']`, "gm"))];
  return matches.at(-1)?.[1];
}

export function parseBuildConfiguration(localConf: string, bblayersConf: string): Pick<WorkspaceConfig, "machine" | "distro" | "layers" | "dlDir" | "sstateDir" | "tmpDir"> {
  const expandedLayers = bblayersConf.replace(/\\\r?\n/g, " ");
  const layerValue = parseAssignment(expandedLayers, "BBLAYERS") ?? "";
  const layers = layerValue.split(/\s+/).filter((item) => item.startsWith("/"));
  const dlDir = parseAssignment(localConf, "DL_DIR");
  const sstateDir = parseAssignment(localConf, "SSTATE_DIR");
  const tmpDir = parseAssignment(localConf, "TMPDIR");
  return {
    machine: parseAssignment(localConf, "MACHINE") ?? "qemux86-64",
    distro: parseAssignment(localConf, "DISTRO") ?? "poky",
    layers,
    ...(dlDir ? { dlDir } : {}),
    ...(sstateDir ? { sstateDir } : {}),
    ...(tmpDir ? { tmpDir } : {})
  };
}

async function findCandidateDir(root: string, predicate: (path: string) => Promise<boolean>): Promise<string | undefined> {
  if (await predicate(root)) return root;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidate = join(root, entry.name);
    if (await predicate(candidate)) return candidate;
  }
  return undefined;
}

export async function discoverWorkspace(root: string, sourceHint?: string, buildHint?: string): Promise<WorkspaceConfig> {
  const base = resolve(root);
  const sourceDir = sourceHint
    ? resolve(sourceHint)
    : await findCandidateDir(base, async (path) => pathExists(join(path, "oe-init-build-env")));
  if (!sourceDir) throw new Error(`Cannot find oe-init-build-env under ${base}; pass --source`);
  const buildDir = buildHint
    ? resolve(buildHint)
    : await findCandidateDir(base, async (path) => (await pathExists(join(path, "conf", "local.conf"))) && (await pathExists(join(path, "conf", "bblayers.conf"))));
  if (!buildDir) throw new Error(`Cannot find a configured build directory under ${base}; pass --build`);
  const localConf = await readFile(join(buildDir, "conf", "local.conf"), "utf8");
  const bblayersConf = await readFile(join(buildDir, "conf", "bblayers.conf"), "utf8");
  const parsed = parseBuildConfiguration(localConf, bblayersConf);
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceDir,
    buildDir,
    machine: parsed.machine,
    distro: parsed.distro,
    layers: parsed.layers,
    ...(parsed.dlDir ? { dlDir: parsed.dlDir } : {}),
    ...(parsed.sstateDir ? { sstateDir: parsed.sstateDir } : {}),
    ...(parsed.tmpDir ? { tmpDir: parsed.tmpDir } : {}),
    offline: { bitbakeNoNetwork: true, blockExplicitNetworkCommands: true },
    limits: { maxParallelAgents: 3, maxWorkflowDepth: 4, maxFixIterations: 2 }
  };
}

export async function initializeProject(projectRoot: string, config: WorkspaceConfig): Promise<string[]> {
  const root = resolve(projectRoot);
  const configPath = join(root, ".pi", "yocto.json");
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await mkdir(join(root, ".pi", "yocto-workflows"), { recursive: true });
  await mkdir(join(root, ".pi-yocto", "jobs"), { recursive: true });
  await mkdir(join(root, ".pi-yocto", "tasks"), { recursive: true });
  await mkdir(join(root, ".pi-yocto", "approvals"), { recursive: true });
  await mkdir(join(root, ".pi-yocto", "changes"), { recursive: true });
  await mkdir(join(root, ".pi-yocto", "guest"), { recursive: true });
  await mkdir(join(root, ".pi-yocto", "knowledge"), { recursive: true });
  await mkdir(join(root, ".pi-yocto", "sessions"), { recursive: true });
  await writeJsonAtomic(configPath, config);

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoot = (await pathExists(join(packageRoot, "agents"))) ? packageRoot : resolve(packageRoot, "..");
  const written = [configPath];
  const ignorePath = join(root, ".gitignore");
  const ignore = await readFile(ignorePath, "utf8").catch(() => "");
  if (!ignore.split(/\r?\n/).some((line) => line.trim() === ".pi-yocto/")) {
    await writeFile(ignorePath, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}.pi-yocto/\n`, "utf8");
    written.push(ignorePath);
  }
  for (const [fromDir, toDir] of [["agents", join(root, ".pi", "agents")], ["workflows", join(root, ".pi", "yocto-workflows")]] as const) {
    const names = await readdir(join(sourceRoot, fromDir)).catch(() => []);
    for (const name of names.sort()) {
      if (!name.endsWith(fromDir === "agents" ? ".md" : ".json")) continue;
      const content = await readFile(join(sourceRoot, fromDir, name), "utf8");
      const destination = join(toDir, name);
      if (!(await pathExists(destination))) {
        await writeFile(destination, content, "utf8");
        written.push(destination);
      }
    }
  }
  return written;
}

export async function directorySize(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    total += await directorySize(join(path, entry.name)).catch(() => 0);
  }
  return total;
}
