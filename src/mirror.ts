import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { pathExists, sha256 } from "./fs-utils.js";
import type { Evidence } from "./types.js";

export interface MirrorPreflight {
  sourceUri: string;
  mirrorFile: string;
  sha256: string;
  rule: string;
  expectedResolvedUri: string;
  offline: boolean;
  evidence: Evidence[];
}

export async function preflightFileMirror(located: LocatedConfig, input: { sourceUri: string; mirrorFile: string; expectedSha256?: string }): Promise<MirrorPreflight> {
  let source: URL;
  try { source = new URL(input.sourceUri); } catch { throw new Error(`Invalid source URI: ${input.sourceUri}`); }
  if (!['http:', 'https:'].includes(source.protocol)) throw new Error("File PREMIRRORS preflight only accepts HTTP(S) source URIs");
  const mirrorFile = resolve(input.mirrorFile);
  if (!(await pathExists(mirrorFile))) throw new Error(`Mirror file does not exist: ${mirrorFile}`);
  if (/\s/.test(mirrorFile)) throw new Error("Mirror paths containing whitespace are not supported by the deterministic rule generator");
  const sourceName = basename(source.pathname);
  if (!sourceName || sourceName !== basename(mirrorFile)) throw new Error(`Mirror filename ${basename(mirrorFile)} must match source basename ${sourceName}; rename/copying the read-only mirror is outside this tool`);
  const digest = sha256(await readFile(mirrorFile));
  if (input.expectedSha256 && digest !== input.expectedSha256.toLowerCase()) throw new Error(`Mirror SHA-256 mismatch: expected ${input.expectedSha256.toLowerCase()}, got ${digest}`);
  const mirrorDir = dirname(mirrorFile);
  const rule = `PREMIRRORS:prepend = "https?$://.*/.* file://${mirrorDir}/ \\n"`;
  const expectedResolvedUri = `file://${mirrorFile}`;
  const evidence: Evidence[] = [{
    id: `ev-${sha256(`${input.sourceUri}:${mirrorFile}:${digest}`).slice(0, 16)}`,
    kind: "source",
    executionDomain: "host",
    claimType: "artifact",
    source: mirrorFile,
    locator: `sha256 ${digest}`,
    fact: `Local mirror basename matches ${sourceName} and has SHA-256 ${digest}`,
    confidence: "high",
    capturedAt: new Date().toISOString(),
    sha256: digest
  }];
  return { sourceUri: input.sourceUri, mirrorFile, sha256: digest, rule, expectedResolvedUri, offline: located.config.offline.bitbakeNoNetwork, evidence };
}
