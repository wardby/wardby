import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Value imports only: `import type`/`export type` are erased at build time.
const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)|(?:^|\n)\s*import\s*["'](\.[^"']+)["']/g;

/** Every relative module (as a src/-relative path) the given entries load at run time, transitively. */
export function relativeImportClosure(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = entries.map((entry) => join(SRC, entry));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3];
      const target = resolve(dirname(file), spec);
      queue.push(target.endsWith(".js") ? target.replace(/\.js$/, ".ts") : target);
    }
  }
  return [...seen].map((file) => relative(SRC, file)).sort();
}

/** The modules in `closure` that no COPY line of `dockerfile` puts in the image. */
export function modulesMissingFromImage(dockerfile: string, closure: readonly string[]): string[] {
  const copied = [...dockerfile.matchAll(/^COPY (?:--from=build \/build\/dist\/|src\/)(\S+)/gm)].map((m) => m[1]);
  return closure.filter((module) => {
    const built = module.replace(/\.ts$/, ".js");
    return !copied.some((source) => source === built || built.startsWith(`${source.replace(/\/$/, "")}/`));
  });
}
