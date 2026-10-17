import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { checkBundle } from "./check.js";
import { DEFAULT_KNOWLEDGE_BUNDLE_PATH } from "./concept.js";
import { KNOWLEDGE_CONFIG_PATH, parseKnowledgeConfig } from "./location.js";

const USAGE = "usage: wardby knowledge check [dir] [--root <repo root>] [--strict] [--json]";

export function parseKnowledgeArgs(args: string[]): {
  /** Unset: the folder `.wardby/knowledge.yaml` names under `root`, else the default. */
  dir: string | undefined;
  root: string;
  strict: boolean;
  json: boolean;
} {
  const [sub, ...rest] = args;
  if (sub !== "check") throw new Error(USAGE);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { root: { type: "string" }, strict: { type: "boolean" }, json: { type: "boolean" } },
  });
  if (positionals.length > 1) throw new Error(USAGE);
  return {
    dir: positionals[0],
    root: values.root ?? ".",
    strict: values.strict ?? false,
    json: values.json ?? false,
  };
}

/**
 * Every `.md` file under `dir`, keyed by bundle-relative POSIX path. Entry
 * types come from the directory listing itself (no separate stat, so nothing
 * can change between the check and the read), and symbolic links are skipped:
 * a bundle is plain files, and following links could loop or leave the bundle.
 */
export function loadBundle(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.set(relative(dir, full).split(sep).join("/"), readFileSync(full, "utf8"));
      }
    }
  };
  walk(dir);
  return files;
}

/**
 * The bundle folder when no `dir` is given: the one `.wardby/knowledge.yaml`
 * under `root` names, else the default. An unusable file is reported as an
 * error (the server would ignore it) and the default is checked instead.
 */
export function bundleDirFromConfig(root: string): { dir: string; configError?: string } {
  let text: string;
  try {
    text = readFileSync(join(root, KNOWLEDGE_CONFIG_PATH), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { dir: DEFAULT_KNOWLEDGE_BUNDLE_PATH };
    return { dir: DEFAULT_KNOWLEDGE_BUNDLE_PATH, configError: `it could not be read (${(err as Error).message})` };
  }
  const parsed = parseKnowledgeConfig(text);
  return parsed.ok ? { dir: parsed.bundlePath } : { dir: DEFAULT_KNOWLEDGE_BUNDLE_PATH, configError: parsed.error };
}

export async function knowledgeCommand(args: string[]): Promise<void> {
  const options = parseKnowledgeArgs(args);
  const root = resolve(options.root);
  const located = options.dir === undefined ? bundleDirFromConfig(root) : { dir: options.dir };
  const dir = located.dir;
  const configIssue = located.configError
    ? {
        severity: "error" as const,
        code: "knowledge_config_invalid" as const,
        file: KNOWLEDGE_CONFIG_PATH,
        message: `ignored because ${located.configError}; checked ${DEFAULT_KNOWLEDGE_BUNDLE_PATH}/ instead`,
      }
    : undefined;
  const files = loadBundle(resolve(root, dir));
  const issues = checkBundle({ files }, (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  });
  if (configIssue) issues.unshift(configIssue);
  if (options.json) process.stdout.write(`${JSON.stringify({ issues }, null, 2)}\n`);
  else {
    for (const issue of issues) {
      const where = issue === configIssue ? issue.file : `${dir}/${issue.file}`;
      process.stdout.write(`${issue.severity} ${issue.code} ${where}: ${issue.message}\n`);
    }
    process.stdout.write(
      `${files.size} files checked, ${issues.filter((i) => i.severity === "error").length} errors, ${issues.filter((i) => i.severity === "warning").length} warnings\n`,
    );
  }
  if (issues.some((i) => i.severity === "error" || (options.strict && i.severity === "warning"))) process.exitCode = 1;
}
