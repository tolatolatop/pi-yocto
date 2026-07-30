import MiniSearch, { type SearchResult } from "minisearch";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocatedConfig } from "./config.js";
import { pathExists, sha256, writeJsonAtomic, readJson } from "./fs-utils.js";
import { runCommand } from "./process.js";
import type { KnowledgeDocument, KnowledgeIndexFile } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { readLayerSeries } from "./workspace.js";

const indexOptions = {
  fields: ["title", "body", "release", "source"],
  storeFields: ["title", "body", "release", "source", "license", "confidence", "rank", "hash", "commit"],
  searchOptions: { boost: { title: 3, release: 2 }, prefix: true, fuzzy: 0.15 }
};

function packageRoot(): string {
  const compiledRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return resolve(compiledRoot, (compiledRoot.endsWith("/dist") || compiledRoot.endsWith("\\dist")) ? ".." : ".");
}

async function collectFiles(root: string, accept: (path: string) => boolean, cap = 8000): Promise<string[]> {
  const output: string[] = [];
  async function visit(path: string): Promise<void> {
    if (output.length >= cap) return;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (output.length >= cap) break;
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if ([".git", "tmp", "downloads", "sstate-cache", "node_modules"].includes(entry.name)) continue;
        await visit(child);
      } else if (entry.isFile() && accept(child)) output.push(child);
    }
  }
  await visit(root);
  return output;
}

export function splitDocument(content: string, maxChars = 6000): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const sections = normalized.split(/(?=^#{1,3}\s+|^[A-Za-z][^\n]{2,80}\n[=~-]{3,}\s*$)/m);
  const chunks: string[] = [];
  for (const section of sections) {
    if (section.length <= maxChars) {
      if (section.trim()) chunks.push(section.trim());
      continue;
    }
    for (let offset = 0; offset < section.length; offset += maxChars) chunks.push(section.slice(offset, offset + maxChars).trim());
  }
  return chunks.filter(Boolean);
}

function titleOf(content: string, fallback: string): string {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^#{1,3}\s+/.test(line))?.replace(/^#{1,3}\s+/, "")
    ?? lines.find((line, index) => index + 1 < lines.length && /^[=~-]{3,}$/.test(lines[index + 1] ?? ""))
    ?? fallback;
}

async function documentFromFile(path: string, root: string, release: string, commit: string, confidence: KnowledgeDocument["confidence"], rank: number, license: string): Promise<KnowledgeDocument[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return splitDocument(content).map((body, chunk) => {
    const source = relative(root, path) || path;
    const hash = sha256(body);
    return {
      id: `${sha256(`${path}:${chunk}:${hash}`).slice(0, 24)}`,
      title: `${titleOf(body, source)}${chunk ? ` (${chunk + 1})` : ""}`,
      body,
      release,
      source,
      commit,
      hash,
      license,
      confidence,
      rank
    };
  });
}

export function knowledgeIndexPath(located: LocatedConfig): string {
  return join(located.stateDir, "knowledge", "index.json");
}

export async function buildKnowledgeIndex(located: LocatedConfig): Promise<{ path: string; documents: number; commit: string; release: string }> {
  const sourceCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: located.config.sourceDir, timeoutMs: 10_000 })).stdout.trim() || "unknown";
  const release = await readLayerSeries(located.config.sourceDir);
  const official = await collectFiles(located.config.sourceDir, (path) => {
    const rel = relative(located.config.sourceDir, path);
    const ext = extname(path);
    return ext === ".rst"
      || ext === ".bbclass"
      || ext === ".bb"
      || ext === ".bbappend"
      || ext === ".inc"
      || ext === ".conf"
      || /(^|\/)README(?:\.[A-Za-z0-9_-]+)?$/.test(rel)
      || /documentation\.conf$/.test(path);
  });
  const curatedRoot = join(packageRoot(), "knowledge", "scarthgap");
  const curated = await collectFiles(curatedRoot, (path) => extname(path) === ".md", 100);
  const casesRoot = join(located.stateDir, "cases");
  const cases = await collectFiles(casesRoot, (path) => extname(path) === ".json", 1000);
  const documents: KnowledgeDocument[] = [];
  for (const path of official) {
    const rank = extname(path) === ".rst" ? 100 : 120;
    documents.push(...await documentFromFile(path, located.config.sourceDir, release, sourceCommit, "official-current", rank, "See source file headers; Poky documentation is CC BY-SA 2.0 UK, code is under its declared license"));
  }
  for (const path of curated) {
    documents.push(...await documentFromFile(path, curatedRoot, "scarthgap", sourceCommit, "curated", 40, "Apache-2.0; citations retain upstream license"));
  }
  for (const path of cases) {
    const raw = JSON.parse(await readFile(path, "utf8")) as { verified?: boolean; rootCause?: string; fixDiff?: string; verification?: string; title?: string; release?: string };
    if (raw.verified !== true || !raw.rootCause || !raw.fixDiff || !raw.verification) continue;
    const body = `# ${raw.title ?? "Verified local case"}\n\nRoot cause:\n${raw.rootCause}\n\nFix diff:\n${raw.fixDiff}\n\nSuccessful verification:\n${raw.verification}`;
    const hash = sha256(body);
    documents.push({ id: sha256(`case:${path}:${hash}`).slice(0, 24), title: raw.title ?? "Verified local case", body, release: raw.release ?? release, source: path, commit: sourceCommit, hash, license: "Local case; contributor-supplied metadata", confidence: "verified-case", rank: 70 });
  }
  documents.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  const miniSearch = new MiniSearch<KnowledgeDocument>(indexOptions);
  miniSearch.addAll(documents);
  const file: KnowledgeIndexFile = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    workspaceCommit: sourceCommit,
    documents,
    miniSearch: miniSearch.toJSON()
  };
  const path = knowledgeIndexPath(located);
  await writeJsonAtomic(path, file);
  return { path, documents: documents.length, commit: sourceCommit, release };
}

export interface KnowledgeHit {
  id: string;
  title: string;
  source: string;
  release: string;
  license: string;
  confidence: string;
  hash: string;
  score: number;
  excerpt: string;
}

export async function searchKnowledge(located: LocatedConfig, query: string, options: { release?: string; limit?: number } = {}): Promise<KnowledgeHit[]> {
  const path = knowledgeIndexPath(located);
  if (!(await pathExists(path))) throw new Error("Knowledge index missing; run pi-yocto knowledge build");
  const file = await readJson<KnowledgeIndexFile>(path);
  const miniSearch = MiniSearch.loadJSON<KnowledgeDocument>(JSON.stringify(file.miniSearch), indexOptions);
  const results = miniSearch.search(query, options.release
    ? { filter: (result) => String(result.release).includes(options.release ?? "") }
    : {});
  return results
    .map((result: SearchResult) => ({ result, weighted: result.score * Number(result.rank ?? 1) }))
    .sort((a, b) => b.weighted - a.weighted)
    .slice(0, options.limit ?? 8)
    .map(({ result, weighted }) => ({
      id: String(result.id),
      title: String(result.title),
      source: String(result.source),
      release: String(result.release),
      license: String(result.license),
      confidence: String(result.confidence),
      hash: String(result.hash),
      score: weighted,
      excerpt: String(result.body).slice(0, 1200)
    }));
}

export async function knowledgeStatus(located: LocatedConfig): Promise<Record<string, unknown>> {
  const path = knowledgeIndexPath(located);
  if (!(await pathExists(path))) return { built: false, path };
  const file = await readJson<KnowledgeIndexFile>(path);
  const currentCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: located.config.sourceDir, timeoutMs: 10_000 })).stdout.trim();
  return {
    built: true,
    path,
    generatedAt: file.generatedAt,
    documents: file.documents.length,
    indexedCommit: file.workspaceCommit,
    currentCommit,
    stale: Boolean(currentCommit && currentCommit !== file.workspaceCommit)
  };
}
