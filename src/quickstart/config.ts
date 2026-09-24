import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type QuickstartProvider = "openai" | "anthropic";
export type McpClient = "none" | "codex" | "claude" | "both";

export interface QuickstartState {
  version: 1;
  projectDir: string;
  composeProject: string;
  postgresPort: number;
  provider: QuickstartProvider;
  model: string;
  packageVersion: string;
  createdAt: string;
}

export interface QuickstartPaths {
  projectDir: string;
  wardbyDir: string;
  envFile: string;
  stateFile: string;
}

export function resolveProjectDir(cwd = process.cwd(), env = process.env): string {
  return resolve(env.WARDBY_PROJECT_DIR || cwd);
}

export function quickstartPaths(projectDir: string): QuickstartPaths {
  const wardbyDir = join(projectDir, ".wardby");
  return {
    projectDir,
    wardbyDir,
    envFile: join(wardbyDir, ".env"),
    stateFile: join(wardbyDir, "state.json"),
  };
}

export function composeProjectName(projectDir: string): string {
  const slug = basename(projectDir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const digest = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 10);
  return `wardby-${slug || "project"}-${digest}`;
}

export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    const rawValue = line.slice(equals + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      try {
        values[key] = JSON.parse(rawValue) as string;
        continue;
      } catch {
        // Preserve malformed quoted values verbatim so setup never destroys them.
      }
    }
    values[key] = rawValue.startsWith("'") && rawValue.endsWith("'") ? rawValue.slice(1, -1) : rawValue;
  }
  return values;
}

export function readQuickstartEnv(paths: QuickstartPaths): Record<string, string> {
  if (!existsSync(paths.envFile)) return {};
  return parseEnvFile(readFileSync(paths.envFile, "utf8"));
}

export function writeQuickstartEnv(paths: QuickstartPaths, values: Record<string, string>): void {
  mkdirSync(paths.wardbyDir, { recursive: true, mode: 0o700 });
  const heading = [
    "# Managed by `wardby quickstart`.",
    "# Keep this file private; it contains local credentials and encryption keys.",
  ];
  const lines = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  writeFileSync(paths.envFile, `${[...heading, ...lines].join("\n")}\n`, { mode: 0o600 });
  chmodSync(paths.wardbyDir, 0o700);
  chmodSync(paths.envFile, 0o600);
}

export function readQuickstartState(paths: QuickstartPaths): QuickstartState | undefined {
  if (!existsSync(paths.stateFile)) return undefined;
  const value = JSON.parse(readFileSync(paths.stateFile, "utf8")) as Partial<QuickstartState>;
  if (
    value.version !== 1 ||
    typeof value.projectDir !== "string" ||
    typeof value.composeProject !== "string" ||
    typeof value.postgresPort !== "number" ||
    (value.provider !== "openai" && value.provider !== "anthropic") ||
    typeof value.model !== "string" ||
    typeof value.packageVersion !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error(`invalid Wardby quickstart state: ${paths.stateFile}`);
  }
  return value as QuickstartState;
}

export function writeQuickstartState(paths: QuickstartPaths, state: QuickstartState): void {
  mkdirSync(paths.wardbyDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(paths.stateFile, 0o600);
}

export function generatedSecret(): string {
  return randomBytes(32).toString("hex");
}

export function ensureWardbyIgnored(projectDir: string): void {
  const gitignore = join(projectDir, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (existing.split(/\r?\n/).some((line) => line.trim() === ".wardby/")) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignore, `${existing}${prefix}\n# Wardby local runtime and credentials\n.wardby/\n`);
}

export function defaultModel(provider: QuickstartProvider): string {
  return provider === "openai" ? "gpt-5.6-luna" : "claude-haiku-4-5";
}

export function providerKeyName(provider: QuickstartProvider): "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" {
  return provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}
