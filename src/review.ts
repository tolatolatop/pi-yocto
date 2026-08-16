import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { LocatedConfig } from "./config.js";
import { pathExists, sha256 } from "./fs-utils.js";
import { runCommand } from "./process.js";
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

function logicalStatements(content: string): string[] {
  return content.replace(/\\\r?\n/g, " ").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function quotedTokens(statement: string): string[] {
  return [...statement.matchAll(/["']([^"']*)["']/g)].flatMap((match) => (match[1] ?? "").split(/\s+/)).filter((token) => /^[A-Za-z0-9][A-Za-z0-9+_.@-]*$/.test(token));
}

async function packageDependencyKinds(located: LocatedConfig, packageName: string): Promise<Array<"RDEPENDS" | "RRECOMMENDS">> {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const kinds = new Set<"RDEPENDS" | "RRECOMMENDS">();
  const inspectLine = (line: string): void => {
    if (/\bRRECOMMENDS(?:[:_]|\s*=)/.test(line)) kinds.add("RRECOMMENDS");
    if (/\bRDEPENDS(?:[:_]|\s*=)/.test(line)) kinds.add("RDEPENDS");
  };
  try {
    const result = await runCommand("rg", ["--files-with-matches", "-g", "*.bb", "-g", "*.bbappend", "-g", "*.inc", escaped, located.config.sourceDir, ...located.config.layers], {
      cwd: located.rootDir,
      timeoutMs: 20_000,
      maxOutputBytes: 2 * 1024 * 1024
    });
    if ([0, 1].includes(result.code)) {
      for (const path of [...new Set(result.stdout.split(/\r?\n/).filter(Boolean))]) {
        const content = await readFile(path, "utf8").catch(() => "");
        for (const statement of logicalStatements(content).filter((line) => line.includes(packageName))) inspectLine(statement);
      }
      return [...kinds];
    }
  } catch { /* fall back to a dependency-free workspace walk */ }

  const pending = [...new Set([located.config.sourceDir, ...located.config.layers].map((root) => resolve(root)))];
  let inspected = 0;
  while (pending.length && inspected < 50_000 && kinds.size < 2) {
    const directory = pending.pop() as string;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if ([".git", ".pi-yocto", "tmp", "sstate-cache", "downloads"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && [".bb", ".bbappend", ".inc"].some((suffix) => entry.name.endsWith(suffix))) {
        inspected += 1;
        const content = await readFile(path, "utf8").catch(() => "");
        if (content.includes(packageName)) for (const statement of logicalStatements(content).filter((line) => line.includes(packageName))) inspectLine(statement);
      }
    }
  }
  return [...kinds];
}

/** Semantic checks that are deterministic without running BitBake. */
export async function semanticMetadataFindings(located: LocatedConfig, file: string, content: string, effectiveContent = content): Promise<ReviewFinding[]> {
  const findings: ReviewFinding[] = [];
  const statements = logicalStatements(effectiveContent);
  for (const statement of statements.filter((line) => /^LIC_FILES_CHKSUM\s*(?:\?|\+|:)?=/.test(line))) {
    if (/;sha256(?:sum)?=/i.test(statement)) findings.push({ severity: "error", rule: "license-checksum-algorithm", file, message: "LIC_FILES_CHKSUM requires md5=<32 hex>; SHA-256 belongs on SRC_URI, not the license entry" });
    for (const match of statement.matchAll(/;md5=([^;"'\s]+)/gi)) {
      const value = match[1] ?? "";
      if (!/^[a-f0-9]{32}$/i.test(value) && !/^\$\{[^}]+\}$/.test(value)) findings.push({ severity: "error", rule: "license-checksum-format", file, message: `LIC_FILES_CHKSUM md5 value must contain exactly 32 hex digits, got '${value}'` });
    }
  }

  const imageRecipe = extname(file) === ".bb" && /(?:^|\/)images\/[^/]+\.bb$/.test(file);
  if (imageRecipe && !/^\s*(?:inherit\s+[^\n]*(?:core-image|image)|(?:require|include)\s+\S*image\S*\.bb)\b/m.test(effectiveContent)) {
    findings.push({ severity: "error", rule: "image-task-graph", file, message: "Image recipe does not inherit an image class or require/include a base image recipe, so do_rootfs/do_image tasks will be missing" });
  }

  for (const statement of statements.filter((line) => /^IMAGE_RRECOMMENDS(?::[^\s=]+)*\s*(?::remove\s*)?=/.test(line))) {
    findings.push({ severity: "error", rule: "package-removal-ineffective-variable", file, message: `IMAGE_RRECOMMENDS is not a standard image solver input and '${statement}' will not suppress a packagegroup recommendation; use image-scoped BAD_RECOMMENDATIONS after proving the edge is RRECOMMENDS` });
  }

  for (const statement of logicalStatements(content).filter((line) => /^IMAGE_INSTALL(?::[^\s=]+)*:remove\s*=/.test(line))) {
    for (const packageName of quotedTokens(statement)) {
      const kinds = await packageDependencyKinds(located, packageName);
      if (kinds.includes("RDEPENDS")) findings.push({ severity: "error", rule: "package-removal-hard-dependency", file, message: `${packageName} is introduced by RDEPENDS; IMAGE_INSTALL:remove cannot remove a hard runtime dependency—change the owning package/packagegroup dependency instead` });
      else if (kinds.includes("RRECOMMENDS")) findings.push({ severity: "error", rule: "package-removal-recommendation", file, message: `${packageName} is introduced by RRECOMMENDS; use BAD_RECOMMENDATIONS for this image instead of IMAGE_INSTALL:remove` });
    }
  }
  if (file.endsWith(".bbappend")) {
    const pn = file.split("/").at(-1)?.replace(/\.bbappend$/, "").split("_")[0] ?? "";
    const flagStatements = statements.map((statement) => ({ statement, match: statement.match(/^(CFLAGS|TARGET_CFLAGS)((?::[^\s=]+)*)\s*(?:\?\?=|\?=|\+=|=\+|:=|=)/) })).filter((item) => item.match);
    for (const { statement, match } of flagStatements) {
      const variable = match?.[1] ?? "";
      const suffixes = (match?.[2] ?? "").split(":").filter(Boolean);
      if (!/-O(?:0|1|2|3|s|z|g|fast)\b/.test(statement)) continue;
      if (variable === "CFLAGS") findings.push({ severity: "error", rule: "optimization-effective-variable", file, message: "Recipe optimization must change TARGET_CFLAGS, because CFLAGS is exported from ${TARGET_CFLAGS}; verify the final bitbake -e value" });
      const overrides = suffixes.filter((suffix) => !["append", "prepend", "remove"].includes(suffix));
      if (overrides.length && overrides.some((override) => override !== `pn-${pn}`)) findings.push({ severity: "error", rule: "optimization-override", file, message: `Optimization override must be recipe-scoped as pn-${pn} (or omitted inside this bbappend), got ${overrides.join(", ")}` });
    }
    const appendsOptimization = flagStatements.some(({ statement }) => /TARGET_CFLAGS(?::[^\s=]+)*:append[^=]*=.*-O(?:0|1|2|3|s|z|g|fast)\b/.test(statement));
    const removesOptimization = flagStatements.some(({ statement }) => /TARGET_CFLAGS(?::[^\s=]+)*:remove[^=]*=.*-O(?:0|1|2|3|s|z|g|fast)\b/.test(statement));
    if (appendsOptimization && !removesOptimization) findings.push({ severity: "error", rule: "optimization-conflict", file, message: "Appending an optimization level requires removing the inherited level from TARGET_CFLAGS so compile argv has exactly one -O flag" });
  }
  return findings;
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
      findings.push(...await semanticMetadataFindings(located, file, content, effectiveContent));
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
