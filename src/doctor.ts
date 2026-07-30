import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import type { LocatedConfig } from "./config.js";
import { knowledgeStatus } from "./knowledge.js";
import { captureBitbakeEnvironment, runCommand } from "./process.js";
import { inspectWorkspace } from "./workspace.js";

export interface DoctorCheck { name: string; ok: boolean; detail: string; warning?: boolean }

export async function runDoctor(located: LocatedConfig): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: major >= 22, detail: process.version });
  for (const [name, path] of [["source", located.config.sourceDir], ["build", located.config.buildDir], ["oe-init-build-env", join(located.config.sourceDir, "oe-init-build-env")]] as const) {
    const ok = await access(path, constants.R_OK).then(() => true).catch(() => false);
    checks.push({ name, ok, detail: path });
  }
  const inspection = await inspectWorkspace(located, false);
  checks.push({ name: "git", ok: inspection.commit !== "unknown", detail: `${inspection.branch} ${inspection.commit.slice(0, 12)}; dirty: ${inspection.dirtyFiles.join(", ") || "none"}`, warning: inspection.dirtyFiles.length > 0 });
  checks.push({ name: "layers", ok: inspection.layers.every((layer) => layer.exists), detail: inspection.layers.map((layer) => `${layer.exists ? "ok" : "missing"}:${layer.path}`).join(", ") });
  try {
    const env = await captureBitbakeEnvironment(located.config);
    const result = await runCommand("bitbake", ["--version"], { cwd: located.config.buildDir, env, timeoutMs: 30_000, umask: 0o022 });
    checks.push({ name: "bitbake", ok: result.code === 0, detail: (result.stdout || result.stderr).trim() });
    checks.push({ name: "offline", ok: env.BB_NO_NETWORK === "1", detail: `BB_NO_NETWORK=${env.BB_NO_NETWORK ?? "unset"}` });
  } catch (error) {
    checks.push({ name: "bitbake", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  const df = await runCommand("df", ["-Pk", located.config.buildDir], { cwd: located.rootDir, timeoutMs: 10_000 });
  const last = df.stdout.trim().split("\n").at(-1)?.split(/\s+/);
  const availableKb = Number(last?.[3] ?? 0);
  checks.push({ name: "disk", ok: availableKb > 10 * 1024 * 1024, detail: availableKb ? `${Math.round(availableKb / 1024 / 1024)} GiB available` : df.stderr, warning: availableKb <= 50 * 1024 * 1024 });
  const knowledge = await knowledgeStatus(located);
  checks.push({ name: "knowledge", ok: knowledge.built === true && knowledge.stale !== true, detail: knowledge.built ? `${knowledge.documents} documents${knowledge.stale ? "; stale" : ""}` : "not built", warning: true });
  return { ok: checks.every((check) => check.ok || check.warning), checks };
}
