import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { sha256 } from "./fs-utils.js";
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
      if (!/^LICENSE\s*(?:\?|\+|:)?=/m.test(content)) findings.push({ severity: "error", rule: "license", file, message: "Recipe does not declare LICENSE" });
      if (!/^LIC_FILES_CHKSUM\s*(?:\?|\+|:)?=/m.test(content)) findings.push({ severity: "warning", rule: "license-checksum", file, message: "Recipe does not declare LIC_FILES_CHKSUM" });
      if (/^SRC_URI.*(?:https?|git):\/\//m.test(content) && !/SRC_URI\[[^\]]*(?:sha256sum|md5sum)\]/m.test(content) && !/SRCREV\s*=/m.test(content)) {
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
    evidence.push({
      id: `ev-${sha256(`${file}:${sha256(content)}:${JSON.stringify(fileFindings)}`).slice(0, 16)}`,
      kind: "source",
      executionDomain: "source",
      claimType: "diagnosis",
      source: file,
      locator: `sha256 ${sha256(content)}`,
      fact: `Static Yocto review found ${errors} error(s), ${fileFindings.length - errors} warning/info item(s) in ${file}`,
      confidence: "high",
      capturedAt: new Date().toISOString(),
      sha256: sha256(content)
    });
  }
  return { findings, passed: !findings.some((finding) => finding.severity === "error"), evidence };
}
