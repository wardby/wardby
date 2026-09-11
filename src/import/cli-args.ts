import { parseArgs } from "node:util";
import type { ConflictPolicy } from "./preflight.js";
import type { ImportOptions } from "./index.js";

const VALID_CONFLICT_POLICIES: ConflictPolicy[] = ["fail", "skip", "rename"];

export function parseImportArgs(args: string[]): Omit<ImportOptions, "db" | "env"> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      owner: { type: "string" },
      public: { type: "boolean" },
      "include-secrets": { type: "boolean" },
      "transfer-key": { type: "string" },
      "default-budget": { type: "string" },
      "dry-run": { type: "boolean" },
      prefix: { type: "string" },
      "on-conflict": { type: "string" },
      "allow-open-fetch": { type: "boolean" },
    },
  });

  // Require one positional: the bundle directory
  if (positionals.length === 0) {
    throw new Error("Missing bundle directory positional argument");
  }
  const dir = positionals[0];

  // Parse owner/public
  const isPublic = values.public ?? false;
  const owner = isPublic ? null : (values.owner ?? null);

  // Validate on-conflict
  const onConflict = (values["on-conflict"] ?? "fail") as ConflictPolicy;
  if (!VALID_CONFLICT_POLICIES.includes(onConflict)) {
    throw new Error(
      `Invalid --on-conflict value "${onConflict}". Must be one of: ${VALID_CONFLICT_POLICIES.join(", ")}`
    );
  }

  return {
    dir,
    owner,
    isPublic,
    includeSecrets: values["include-secrets"] ?? false,
    transferKeyPath: values["transfer-key"],
    defaultBudget: values["default-budget"],
    dryRun: values["dry-run"] ?? false,
    prefix: values.prefix ?? "imported-",
    onConflict,
    allowOpenFetch: values["allow-open-fetch"] ?? false,
  };
}
