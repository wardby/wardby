import { parse as parseYaml } from "yaml";
import { DEFAULT_KNOWLEDGE_BUNDLE_PATH } from "./concept.js";

/**
 * Where a repository's knowledge bundle lives (docs/knowledge.md, "Where the
 * bundle lives"): the folder `.wardby/knowledge.yaml` names, else
 * DEFAULT_KNOWLEDGE_BUNDLE_PATH. A missing, unreadable, or invalid file never
 * fails anything: it degrades to the default, with a warning when the file
 * exists but cannot be used.
 */
export const KNOWLEDGE_CONFIG_PATH = ".wardby/knowledge.yaml";
export const KNOWLEDGE_CONFIG_MAX_BYTES = 4 * 1024;
const MAX_BUNDLE_PATH_LENGTH = 200;

export interface KnowledgeLocation {
  bundlePath: string;
  /** Set when `.wardby/knowledge.yaml` exists but was ignored, saying why. */
  warning?: string;
}

export type KnowledgeConfigParse = { ok: true; bundlePath: string } | { ok: false; error: string };

/** `path: <repo-relative folder>`, the file's only key. */
export function parseKnowledgeConfig(text: string): KnowledgeConfigParse {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return { ok: false, error: "it is not valid YAML" };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return { ok: false, error: "it must be a mapping with a `path` key" };
  const keys = Object.keys(doc);
  const unknown = keys.filter((k) => k !== "path");
  if (unknown.length > 0) return { ok: false, error: `unknown key ${unknown.map((k) => `\`${k}\``).join(", ")}` };
  const { path } = doc as { path?: unknown };
  if (typeof path !== "string") return { ok: false, error: "`path` must be a string" };
  return normalizeBundlePath(path);
}

/** A repo-relative POSIX folder, without `./` or trailing slashes, outside `.wardby/` and `.git/`. */
export function normalizeBundlePath(raw: string): KnowledgeConfigParse {
  let path = raw.trim();
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/+$/, "");
  if (path === "" || path === ".") return { ok: false, error: "`path` must name a folder inside the repository" };
  if (path.length > MAX_BUNDLE_PATH_LENGTH)
    return { ok: false, error: `\`path\` must be at most ${MAX_BUNDLE_PATH_LENGTH} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return { ok: false, error: "`path` must be a plain POSIX path" };
  if (path.startsWith("/")) return { ok: false, error: "`path` must be relative to the repository root" };
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".."))
    return { ok: false, error: "`path` must not contain empty, `.` or `..` segments" };
  if (segments[0] === ".wardby" || segments[0] === ".git")
    return { ok: false, error: "`path` must not be inside `.wardby/` or `.git/`" };
  return { ok: true, bundlePath: path };
}

/**
 * The bundle location, given a reader for `.wardby/knowledge.yaml` that
 * returns null when the file does not exist. A reader that throws, like an
 * invalid file, yields the default with a warning.
 */
export async function resolveKnowledgeLocation(
  readConfig: () => Promise<string | null | undefined>,
): Promise<KnowledgeLocation> {
  let text: string | null | undefined;
  try {
    text = await readConfig();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { bundlePath: DEFAULT_KNOWLEDGE_BUNDLE_PATH, warning: ignoredWarning(`it could not be read (${reason})`) };
  }
  if (text === null || text === undefined) return { bundlePath: DEFAULT_KNOWLEDGE_BUNDLE_PATH };
  const parsed = parseKnowledgeConfig(text);
  if (!parsed.ok) return { bundlePath: DEFAULT_KNOWLEDGE_BUNDLE_PATH, warning: ignoredWarning(parsed.error) };
  return { bundlePath: parsed.bundlePath };
}

function ignoredWarning(reason: string): string {
  return `${KNOWLEDGE_CONFIG_PATH} was ignored because ${reason}; using ${DEFAULT_KNOWLEDGE_BUNDLE_PATH}/.`;
}
