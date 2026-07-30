import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LocatedConfig } from "../src/config.js";
import { analyzeLog } from "../src/log-analyzer.js";
import { SCHEMA_VERSION } from "../src/types.js";

test("log analyzer reports the first critical error before cascade summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-yocto-log-"));
  const sourceDir = join(root, "poky"); const buildDir = join(root, "build");
  await mkdir(sourceDir); await mkdir(buildDir);
  const log = join(root, "log.do_compile");
  await writeFile(log, "note\nfoo.c:2: fatal error: missing.h: No such file\nERROR: Task x failed\nERROR: another task failed\n");
  const located: LocatedConfig = { rootDir: root, configPath: join(root, ".pi/yocto.json"), stateDir: join(root, ".pi-yocto"), config: { schemaVersion: SCHEMA_VERSION, sourceDir, buildDir, machine: "qemux86-64", distro: "poky", layers: [], offline: { bitbakeNoNetwork: true, blockExplicitNetworkCommands: true }, limits: { maxParallelAgents: 3, maxWorkflowDepth: 4, maxFixIterations: 2 } } };
  const result = await analyzeLog(located, log);
  assert.equal(result.category, "compile");
  assert.match(result.firstCriticalError ?? "", /fatal error/);
  assert.equal(result.firstCriticalLine, 2);
  assert.equal(result.evidence[0]?.confidence, "high");
});
