import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { pathExists, sha256 } from "./fs-utils.js";
import type { Evidence } from "./types.js";

export interface ReviewFinding {
  severity: "error" | "warning" | "info";
  rule: string;
  file: string;
  line?: number;
  message: string;
}

function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function within(path: string, root: string): boolean {
  const absoluteRoot = resolve(root);
  return path === absoluteRoot || path.startsWith(`${absoluteRoot}/`);
}

function workspaceRoots(located: LocatedConfig): string[] {
  return [located.config.sourceDir, located.config.buildDir, ...located.config.layers].map((root) => resolve(root));
}

async function effectiveRecipeContent(located: LocatedConfig, file: string, content: string, findings: ReviewFinding[], visited = new Set<string>()): Promise<string> {
  const absolute = resolve(file);
  if (visited.has(absolute)) return "";
  visited.add(absolute);
  const roots = workspaceRoots(located);
  const chunks = [content];
  for (const match of content.matchAll(/^\s*(require|include)\s+["']?([^\s"'#]+)["']?/gm)) {
    const directive = match[1] as "require" | "include";
    const reference = match[2] ?? "";
    let expanded = reference.replaceAll("${THISDIR}", dirname(absolute));
    if (expanded.includes("${COREBASE}")) expanded = expanded.replaceAll("${COREBASE}", resolve(located.config.sourceDir));
    if (/\$\{[^}]+\}/.test(expanded)) {
      findings.push({ severity: "warning", rule: "include-unresolved", file: absolute, line: lineOf(content, match.index), message: `Cannot statically resolve ${directive} ${reference}; confirm it with BitBake metadata` });
      continue;
    }
    const candidates = (expanded.startsWith("/")
      ? [resolve(expanded)]
      : [resolve(dirname(absolute), expanded), ...roots.map((root) => resolve(root, expanded))])
      .filter((candidate, index, all) => all.indexOf(candidate) === index);
    const safeCandidates = candidates.filter((candidate) => roots.some((root) => within(candidate, root)));
    const matches = [] as string[];
    for (const candidate of safeCandidates) if (await pathExists(candidate)) matches.push(candidate);
    if (!matches.length) {
      findings.push({
        severity: directive === "require" ? "error" : "warning",
        rule: directive === "require" ? "required-include" : "optional-include",
        file: absolute,
        line: lineOf(content, match.index),
        message: `${directive} target was not found inside configured workspace/layers: ${reference}`
      });
      continue;
    }
    if (matches.length > 1) {
      findings.push({ severity: "warning", rule: "include-ambiguity", file: absolute, line: lineOf(content, match.index), message: `${directive} ${reference} resolves to multiple configured files; using ${matches[0]}` });
    }
    const includePath = matches[0] as string;
    const includeContent = await readFile(includePath, "utf8");
    chunks.push(await effectiveRecipeContent(located, includePath, includeContent, findings, visited));
  }
  return chunks.join("\n");
}

export async function reviewYoctoFiles(located: LocatedConfig, files: string[]): Promise<{ findings: ReviewFinding[]; passed: boolean; evidence: Evidence[] }> {
  const findings: ReviewFinding[] = [];
  const evidence: Evidence[] = [];
  for (const input of files) {
    const file = resolve(input);
    if (![located.config.sourceDir, located.config.buildDir, ...located.config.layers].some((root) => within(file, root))) throw new Error(`Review path is outside the configured Poky workspace/layers: ${file}`);
    const content = await readFile(file, "utf8");
    const findingStart = findings.length;
    const ext = extname(file);
    if (ext === ".bb" || ext === ".inc") {
      const effectiveContent = await effectiveRecipeContent(located, file, content, findings);
      if (!/^LICENSE\s*(?:\?|\+|:)?=/m.test(effectiveContent)) findings.push({ severity: "error", rule: "license", file, message: "Recipe and its resolvable includes do not declare LICENSE" });
      if (!/^LIC_FILES_CHKSUM\s*(?:\?|\+|:)?=/m.test(effectiveContent)) findings.push({ severity: "warning", rule: "license-checksum", file, message: "Recipe and its resolvable includes do not declare LIC_FILES_CHKSUM" });
      if (/^SRC_URI.*(?:https?|git):\/\//m.test(effectiveContent) && !/SRC_URI\[[^\]]*(?:sha256sum|md5sum)\]/m.test(effectiveContent) && !/SRCREV\s*=/m.test(effectiveContent)) {
        findings.push({ severity: "warning", rule: "source-pinning", file, message: "Remote source does not appear checksum- or revision-pinned" });
      }
    }
    for (const match of content.matchAll(/^([A-Z][A-Z0-9_]*)_(append|prepend|remove)(?::|\s*=)/gm)) {
      findings.push({ severity: "warning", rule: "override-syntax", file, line: lineOf(content, match.index), message: `Legacy override syntax '${match[0].trim()}' should use ':' on scarthgap` });
    }
    for (const match of content.matchAll(/\b(?:curl|wget|git\s+clone)\b/g)) {
      findings.push({ severity: "error", rule: "offline-reproducibility", file, line: lineOf(content, match.index), message: "Task invokes a network client directly; declare sources through SRC_URI" });
    }
    if (/^FILESEXTRAPATHS:prepend\s*=\s*"(?!\$\{THISDIR\})/m.test(content)) {
      findings.push({ severity: "warning", rule: "files-path", file, message: "FILESEXTRAPATHS should normally be anchored at ${THISDIR}" });
    }
    const fileFindings = findings.slice(findingStart);
    const errors = fileFindings.filter((finding) => finding.severity === "error").length;
    const baseEvidence = {
      kind: "source" as const,
      executionDomain: "source" as const,
      source: file,
      locator: `sha256 ${sha256(content)}`,
      confidence: "high" as const,
      capturedAt: new Date().toISOString(),
      sha256: sha256(content)
    };
    evidence.push({
      id: `ev-${sha256(`${file}:${sha256(content)}:${JSON.stringify(fileFindings)}`).slice(0, 16)}`,
      ...baseEvidence,
      claimType: "diagnosis",
      fact: `Static Yocto review found ${errors} error(s), ${fileFindings.length - errors} warning/info item(s) in ${file}`
    });
    if (errors === 0) evidence.push({
      id: `ev-${sha256(`${file}:${sha256(content)}:configuration`).slice(0, 16)}`,
      ...baseEvidence,
      claimType: "configuration",
      fact: `Source configuration ${file} passed static Yocto review with content hash ${sha256(content)}`
    });
  }
  return { findings, passed: !findings.some((finding) => finding.severity === "error"), evidence };
}
