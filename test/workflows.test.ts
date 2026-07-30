import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("fixed workflows enforce concurrency, depth and fix iteration budgets", async () => {
  const root = join(process.cwd(), "workflows");
  const names = (await readdir(root)).filter((name) => name.endsWith(".json"));
  assert.deepEqual(names.sort(), ["create-layer.json", "diagnose.json", "fix-and-verify.json", "long-build.json", "optimize-build.json"]);
  for (const name of names) {
    const sourceText = await readFile(join(root, name), "utf8");
    assert.equal(await readFile(join(process.cwd(), ".pi", "yocto-workflows", name), "utf8"), sourceText, `${name} project copy is stale`);
    const workflow = JSON.parse(sourceText) as { budgets: Record<string, number>; flow: Record<string, unknown> };
    assert.equal(workflow.budgets.maxParallelism, 3);
    assert.equal(workflow.budgets.maxDepth, 4);
    assert.equal(workflow.budgets.maxIterations, 2);
    assert.ok(workflow.flow);
    const forks = new Set<string>(); const joins: string[] = []; const agents = new Set<string>();
    const walk = (node: Record<string, unknown>): void => {
      if (node.kind === "fork") { forks.add(String(node.id)); for (const branch of Object.values(node.branches as Record<string, Record<string, unknown>>)) walk(branch); }
      if (node.kind === "join") joins.push(String(node.from));
      if (node.kind === "spawn") agents.add(String(node.agent));
      if (node.kind === "sequence") for (const step of node.steps as Array<Record<string, unknown>>) walk(step);
      if (node.kind === "loop") { assert.ok(Number(node.maxIterations) <= 2); walk(node.body as Record<string, unknown>); }
    };
    walk(workflow.flow);
    assert.ok(joins.every((reference) => forks.has(reference)), `${name} contains an unresolved join`);
    const known = new Set(["workspace-inspector", "log-analyst", "metadata-explorer", "standards-reviewer", "performance-analyst", "layer-engineer", "verifier", "evidence-summarizer"]);
    assert.ok([...agents].every((agent) => known.has(agent)), `${name} contains an unknown agent`);
  }
  const fix = JSON.parse(await readFile(join(root, "fix-and-verify.json"), "utf8")) as { flow: { steps: Array<Record<string, unknown>> } };
  const loop = fix.flow.steps.find((step) => step.kind === "loop");
  assert.equal(loop?.maxIterations, 2);

  for (const name of await readdir(join(process.cwd(), "agents"))) {
    if (!name.endsWith(".md")) continue;
    const source = await readFile(join(process.cwd(), "agents", name), "utf8");
    assert.equal(await readFile(join(process.cwd(), ".pi", "agents", name), "utf8"), source, `${name} project copy is stale`);
    assert.match(source, /yocto_task_open/, `${name} does not enforce TaskRecord binding`);
  }
});
