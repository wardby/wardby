import { readFileSync } from "node:fs";

let cached: string | undefined;

export function packageVersion(): string {
  if (cached !== undefined) return cached;
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("invalid_package_version");
  }
  cached = packageJson.version;
  return cached;
}
