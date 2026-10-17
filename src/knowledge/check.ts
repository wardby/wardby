import { redactTokenShapedValues } from "../coding/protocol.js";
import { parseConcept, RESERVED_BUNDLE_FILES } from "./concept.js";
import { spanHash } from "./span-hash.js";

export type CheckSeverity = "error" | "warning";
export type CheckCode =
  | "concept_invalid"
  | "concept_secret"
  | "index_missing"
  | "index_link_broken"
  | "concept_not_indexed"
  | "citation_unverifiable"
  | "citation_stale"
  | "knowledge_config_invalid";
export interface CheckIssue {
  severity: CheckSeverity;
  code: CheckCode;
  file: string;
  message: string;
}
export interface BundleFiles {
  files: Map<string, string>;
}
export type RepoFileReader = (repoRelativePath: string) => string | null;

const LINK = /\]\(([^)#\s]+\.md)(?:#[^)\s]*)?\)/g;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const baseName = (path: string) => path.split("/").pop() ?? path;

function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}

export function checkBundle(bundle: BundleFiles, readRepoFile: RepoFileReader): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const add = (severity: CheckSeverity, code: CheckCode, file: string, message: string) =>
    issues.push({ severity, code, file, message });

  if (!bundle.files.has("index.md")) add("error", "index_missing", "index.md", "the bundle has no root index.md");

  const linked = new Set<string>();
  for (const [path, text] of bundle.files) {
    if (redactTokenShapedValues(text) !== text) add("error", "concept_secret", path, "contains a secret-shaped value");
    if (baseName(path) !== "index.md") continue;
    for (const match of text.matchAll(LINK)) {
      if (URL_SCHEME.test(match[1])) continue;
      const target = normalize(match[1].startsWith("/") ? match[1].slice(1) : dirOf(path) + match[1]);
      linked.add(target);
      if (!bundle.files.has(target)) add("error", "index_link_broken", path, `links to missing ${target}`);
    }
  }

  const fileCache = new Map<string, string | null>();
  const read = (p: string) => {
    if (!fileCache.has(p)) fileCache.set(p, readRepoFile(p));
    return fileCache.get(p) ?? null;
  };

  for (const [path, text] of bundle.files) {
    const base = path.split("/").pop() ?? path;
    if (!path.endsWith(".md") || RESERVED_BUNDLE_FILES.has(base)) continue;
    const parsed = parseConcept(path, text);
    if (!parsed.ok) {
      add("error", "concept_invalid", path, parsed.error);
      continue;
    }
    if (!linked.has(path)) add("warning", "concept_not_indexed", path, "not linked from an index.md");
    for (const citation of parsed.concept.citations) {
      const where = `${citation.path}${citation.lines ? `#L${citation.lines[0]}-L${citation.lines[1]}` : ""}`;
      const source = read(citation.path);
      const actual = source === null ? null : spanHash(source, citation.lines);
      if (actual === null) add("warning", "citation_unverifiable", path, `${where} is missing or out of range`);
      else if (actual !== citation.spanHash)
        add("warning", "citation_stale", path, `${where} changed since it was cited`);
    }
  }
  return issues;
}
