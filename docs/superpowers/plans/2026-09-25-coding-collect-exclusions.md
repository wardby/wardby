# Coding Collection Exclusions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dependency and cache folders in a coding run's workspace (`node_modules`, `.venv`, caches, plus per-agent paths) are never collected, validated, or committed, so installed packages can never fail a run.

**Architecture:** One module, `src/coding/collect-exclude.ts`, defines the exclusions and renders them three ways: GNU `tar` options (Kubernetes keeper), a matcher for pruning a staging copy (Docker), and Git exclude pathspecs (commit). A new profile field `collectExclude` holds extra repository-relative paths; it is copied onto the run at dispatch and carried to the job spec and the prepared Git workspace, exactly like `protectedPaths`.

**Tech Stack:** TypeScript (Node 24, ESM), Zod, Prisma 6, Vitest, GNU tar, Git.

**Spec:** `docs/superpowers/specs/2026-09-25-coding-package-registry-design.md` (section 4, as amended in Task 6).

## Global Constraints

- Built-in excluded folder names, matched at any depth: `node_modules`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, `.tox`, `.vite`, `.cache`.
- `collectExclude`: at most 64 repository-relative POSIX paths; no leading `/` or `./`, no backslashes, no empty, `.` or `..` segments, no control characters, no glob characters (`*`, `?`, `[`, `]`), at most 512 bytes each. Settable with `agents:write`.
- A run's exclusions are snapshotted at dispatch; later profile edits do not affect it.
- Tracked files under an excluded path must be neither added nor deleted by finalization.
- Every schema change ships with its hand-written migration and a clean drift check (see this worktree's `CLAUDE.md`, "Required drift check"). Never `prisma db push`.
- Commits end with the attribution lines required by the session. Work only on the plan's branch in its worktree, never on `main`.

---

## File Structure

| File                                                                             | Responsibility                                                        |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/coding/collect-exclude.ts` (create)                                         | The exclusion model, validation, matcher, tar options, Git pathspecs. |
| `src/coding/collect-exclude.test.ts` (create)                                    | Unit tests for the module.                                            |
| `src/coding/profile.ts` (modify)                                                 | `collectExclude` profile field.                                       |
| `prisma/schema.prisma` (modify)                                                  | `collectExclude` columns on `CodingAgentProfile` and `CodingRun`.     |
| `prisma/migrations/20260925010000_coding_collect_exclude/migration.sql` (create) | Additive migration.                                                   |
| `src/core/dispatch.ts` (modify)                                                  | Snapshot `collectExclude` onto the run.                               |
| `src/mcp/tools/agents.ts` (modify)                                               | Expose the field in the MCP JSON schema and `storedProfile`.          |
| `src/providers/jobs/types.ts` (modify)                                           | `JobSpec.collectExclude`.                                             |
| `src/providers/executor/container.ts` (modify)                                   | Carry exclusions to the job spec and the VCS input.                   |
| `src/providers/jobs/kubernetes.ts` (modify)                                      | Keeper `tar` excludes.                                                |
| `src/providers/jobs/collect-prune.ts` (create)                                   | Remove excluded paths from a staging copy without following symlinks. |
| `src/providers/jobs/docker.ts` (modify)                                          | Prune the staging copy before validation.                             |
| `src/providers/vcs/types.ts`, `src/providers/vcs/git.ts` (modify)                | Carry exclusions; add Git exclude pathspecs.                          |
| `src/providers/vcs/git-collect-exclude.integration.test.ts` (create)             | Real-Git proof that tracked excluded files survive.                   |
| `docs/coding-worker-isolation.md` (modify)                                       | Document collection exclusions.                                       |

---

### Task 1: The collection-exclusion module

**Files:**

- Create: `src/coding/collect-exclude.ts`
- Test: `src/coding/collect-exclude.test.ts`

**Interfaces:**

- Produces:
  - `BUILTIN_COLLECT_EXCLUDE_NAMES: readonly string[]`
  - `MAX_COLLECT_EXCLUDE_PATHS = 64`
  - `interface CollectExclusions { names: readonly string[]; paths: readonly string[] }`
  - `validateCollectExcludePath(value: string): string` — returns the trimmed path or throws `Error("collect_exclude_path_invalid")`
  - `collectExclusions(paths: readonly string[]): CollectExclusions`
  - `normalizeCollectExclusions(value: unknown): CollectExclusions` — for untrusted stored values; throws `Error("collect_exclude_invalid")`
  - `isCollectExcluded(relativePath: string, exclusions: CollectExclusions): boolean`
  - `tarExcludeArgs(exclusions: CollectExclusions): string[]`
  - `gitExcludePathspecs(exclusions: CollectExclusions): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
// src/coding/collect-exclude.test.ts
import { describe, expect, it } from "vitest";
import {
  BUILTIN_COLLECT_EXCLUDE_NAMES,
  collectExclusions,
  gitExcludePathspecs,
  isCollectExcluded,
  normalizeCollectExclusions,
  tarExcludeArgs,
  validateCollectExcludePath,
} from "./collect-exclude.js";

describe("collectExclusions", () => {
  it("always includes the built-in names and dedupes paths", () => {
    expect(collectExclusions(["web/dist", "web/dist", "build"])).toEqual({
      names: [...BUILTIN_COLLECT_EXCLUDE_NAMES],
      paths: ["web/dist", "build"],
    });
  });

  it.each(["/abs", "./rel", "a/../b", "a//b", "a/*", "a?", "[x]", "back\\slash", "", "a\u0001b", "x".repeat(513)])(
    "rejects the unsafe path %j",
    (path) => {
      expect(() => validateCollectExcludePath(path)).toThrow("collect_exclude_path_invalid");
    },
  );

  it("rejects more than 64 paths", () => {
    expect(() => collectExclusions(Array.from({ length: 65 }, (_, i) => `p${i}`))).toThrow(
      "collect_exclude_path_invalid",
    );
  });
});

describe("normalizeCollectExclusions", () => {
  it("accepts a stored list and rejects anything else", () => {
    expect(normalizeCollectExclusions(["web/dist"]).paths).toEqual(["web/dist"]);
    expect(normalizeCollectExclusions(undefined).paths).toEqual([]);
    expect(() => normalizeCollectExclusions("web/dist")).toThrow("collect_exclude_invalid");
    expect(() => normalizeCollectExclusions([1])).toThrow("collect_exclude_invalid");
  });
});

describe("isCollectExcluded", () => {
  const exclusions = collectExclusions(["web/dist"]);
  it.each([
    ["node_modules", true],
    ["web/node_modules/react/index.js", true],
    ["pkg/__pycache__/x.pyc", true],
    ["web/dist", true],
    ["web/dist/app.js", true],
    ["web/distribution/app.js", false],
    ["src/node_modules_helper.ts", false],
    ["src/app.ts", false],
  ])("%s -> %s", (path, expected) => {
    expect(isCollectExcluded(path, exclusions)).toBe(expected);
  });
});

describe("renderings", () => {
  const exclusions = collectExclusions(["web/dist"]);
  it("renders GNU tar options: unanchored names, then anchored paths", () => {
    const args = tarExcludeArgs(exclusions);
    expect(args[0]).toBe("--no-anchored");
    expect(args).toContain("--exclude=node_modules");
    expect(args.slice(args.indexOf("--anchored"))).toEqual(["--anchored", "--exclude=./web/dist"]);
  });

  it("renders Git exclude pathspecs for names at any depth and for literal paths", () => {
    const specs = gitExcludePathspecs(exclusions);
    expect(specs).toContain(":(exclude,glob)**/node_modules/**");
    expect(specs).toContain(":(exclude,literal)web/dist");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/coding/collect-exclude.test.ts`
Expected: FAIL — `Cannot find module './collect-exclude.js'`.

- [ ] **Step 3: Implement the module**

```ts
// src/coding/collect-exclude.ts
/**
 * Paths a coding run's workspace never sends back: dependency and cache folders
 * (matched by name at any depth) plus per-agent repository-relative paths. The
 * same set is rendered three ways so the Kubernetes keeper's tar, the Docker
 * staging prune, and Git staging all agree on what "excluded" means.
 */
export const BUILTIN_COLLECT_EXCLUDE_NAMES = [
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".tox",
  ".vite",
  ".cache",
] as const;

export const MAX_COLLECT_EXCLUDE_PATHS = 64;
const MAX_PATH_BYTES = 512;
const CONTROL = /[\u0000-\u001F\u007F]/;
const GLOB = /[*?[\]]/;

export interface CollectExclusions {
  names: readonly string[];
  paths: readonly string[];
}

export function validateCollectExcludePath(value: string): string {
  const path = value.trim();
  const valid =
    path.length > 0 &&
    Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES &&
    !CONTROL.test(path) &&
    !GLOB.test(path) &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.startsWith("./") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
  if (!valid) throw new Error("collect_exclude_path_invalid");
  return path;
}

export function collectExclusions(paths: readonly string[]): CollectExclusions {
  if (paths.length > MAX_COLLECT_EXCLUDE_PATHS) throw new Error("collect_exclude_path_invalid");
  return { names: [...BUILTIN_COLLECT_EXCLUDE_NAMES], paths: [...new Set(paths.map(validateCollectExcludePath))] };
}

/** For values read back from the database or a job record, which are untrusted shapes. */
export function normalizeCollectExclusions(value: unknown): CollectExclusions {
  if (value === undefined || value === null) return collectExclusions([]);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("collect_exclude_invalid");
  }
  return collectExclusions(value);
}

export function isCollectExcluded(relativePath: string, exclusions: CollectExclusions): boolean {
  const segments = relativePath.split("/");
  if (segments.some((segment) => exclusions.names.includes(segment))) return true;
  return exclusions.paths.some((path) => relativePath === path || relativePath.startsWith(`${path}/`));
}

/**
 * GNU tar options for `tar -C <workspace> -cf - .`, whose member names start with
 * "./". Names are unanchored (they match any path component); paths are anchored
 * to the archive root. An excluded directory's contents are skipped with it.
 */
export function tarExcludeArgs(exclusions: CollectExclusions): string[] {
  return [
    "--no-anchored",
    ...exclusions.names.map((name) => `--exclude=${name}`),
    "--anchored",
    ...exclusions.paths.map((path) => `--exclude=./${path}`),
  ];
}

/** Git exclude pathspecs, appended after ":/" when staging. */
export function gitExcludePathspecs(exclusions: CollectExclusions): string[] {
  return [
    ...exclusions.names.flatMap((name) => [`:(exclude,glob)**/${name}`, `:(exclude,glob)**/${name}/**`]),
    ...exclusions.paths.map((path) => `:(exclude,literal)${path}`),
  ];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/coding/collect-exclude.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/coding/collect-exclude.ts src/coding/collect-exclude.test.ts
git commit -m "feat(coding): define workspace collection exclusions"
```

---

### Task 2: The `collectExclude` profile field, column, and dispatch snapshot

**Files:**

- Modify: `src/coding/profile.ts:106-160` (fields and both schemas)
- Modify: `prisma/schema.prisma` (`model CodingAgentProfile`, `model CodingRun`)
- Create: `prisma/migrations/20260925010000_coding_collect_exclude/migration.sql`
- Modify: `src/core/dispatch.ts:214` (codingRun create)
- Modify: `src/mcp/tools/agents.ts:127` (`profileJsonSchema`) and `:167-182` (`storedProfile`)
- Test: `src/coding/profile.test.ts`, `src/core/dispatch.test.ts`, `src/mcp/tools/agents.test.ts`

**Interfaces:**

- Consumes: `validateCollectExcludePath`, `MAX_COLLECT_EXCLUDE_PATHS` (Task 1).
- Produces: `CodingProfile.collectExclude: string[]` (default `[]`); `CodingRun.collectExclude` JSON column (default `[]`).

- [ ] **Step 1: Write the failing tests**

In `src/coding/profile.test.ts`, add `collectExclude: [],` to the expected object in "normalizes identifiers and applies fail-safe defaults" (after `workspaceDiskMb: null,`), and add:

```ts
it("accepts per-agent collection exclusions and rejects unsafe paths", () => {
  const base = { repository: "openai/example" };
  expect(CodingProfileSchema.parse({ ...base, collectExclude: ["web/dist", "web/dist"] }).collectExclude).toEqual([
    "web/dist",
  ]);
  for (const bad of [["/abs"], ["a/*"], ["../x"], Array.from({ length: 65 }, (_, i) => `p${i}`)]) {
    expect(() => CodingProfileSchema.parse({ ...base, collectExclude: bad })).toThrow();
  }
  expect(CodingProfilePatchSchema.parse({ collectExclude: [] })).toEqual({ collectExclude: [] });
});
```

In `src/core/dispatch.test.ts`, add after the `workspaceDiskMb` test:

```ts
it("copies the profile's collectExclude onto the run at dispatch", async () => {
  const agent = {
    ...nativeAgent(),
    kind: "coding",
    budgetUsd: 1.25,
    codingProfile: {
      provider: "codex",
      repository: "openai/wardby",
      baseRef: "main",
      defaultTask: "Fix the failing tests",
      timeoutSec: 900,
      allowedEgress: [],
      protectedPaths: [],
      collectExclude: ["web/dist"],
    },
  };
  const state = fakeDb(agent);
  const executor: Executor = { async start() {}, async stop() {} };

  const result = await dispatchRun({ db: state.db, executor, agentId: agent.id });

  expect(state.codingRuns).toEqual([expect.objectContaining({ runId: result?.run.id, collectExclude: ["web/dist"] })]);
});
```

In `src/mcp/tools/agents.test.ts`, add after the `workspaceDiskMb` round-trip test:

```ts
it("collectExclude round-trips through create_agent and update_agent with agents:write", async () => {
  const db = fakeDb();
  const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
  mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write", "agents:read"]));
  registerAgentTools(mcp);
  const client = await connectClient(mcp);

  const created = await client.callTool({
    name: "create_agent",
    arguments: {
      name: "coder",
      systemPrompt: "Make the requested change.",
      model: "gpt-5.6-luna",
      budgetUsd: 0.25,
      kind: "coding",
      codingProfile: { repository: "openai/example", collectExclude: ["web/dist"] },
    },
  });
  expect(created.isError).toBeFalsy();
  const createdAgent = JSON.parse((created.content as { text: string }[])[0].text);
  expect(createdAgent.codingProfile.collectExclude).toEqual(["web/dist"]);

  const updated = await client.callTool({
    name: "update_agent",
    arguments: { id: createdAgent.id, codingProfile: { collectExclude: [] } },
  });
  expect(updated.isError).toBeFalsy();
  expect(JSON.parse((updated.content as { text: string }[])[0].text).codingProfile.collectExclude).toEqual([]);
  await client.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/coding/profile.test.ts src/core/dispatch.test.ts src/mcp/tools/agents.test.ts`
Expected: FAIL — `collectExclude` missing from parsed profiles, from the dispatched run, and from the MCP output.

- [ ] **Step 3: Implement the profile field**

In `src/coding/profile.ts`:

```ts
// with the other imports
import { MAX_COLLECT_EXCLUDE_PATHS, validateCollectExcludePath } from "./collect-exclude.js";

// next to protectedPathSchema
const collectExcludePathSchema = z.string().transform((value, ctx) => {
  try {
    return validateCollectExcludePath(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a repository-relative path without wildcards" });
    return z.NEVER;
  }
});

// in codingProfileFields, after protectedPaths
  collectExclude: z
    .array(collectExcludePathSchema)
    .max(MAX_COLLECT_EXCLUDE_PATHS)
    .transform((paths) => [...new Set(paths)]),

// in CodingProfileSchema, after protectedPaths
    collectExclude: codingProfileFields.collectExclude.default([]),

// in CodingProfilePatchSchema, after protectedPaths
    collectExclude: codingProfileFields.collectExclude.optional(),
```

- [ ] **Step 4: Add the columns and the migration**

In `prisma/schema.prisma`, add after `protectedPaths Json` in **both** `model CodingAgentProfile` and `model CodingRun`:

```prisma
  collectExclude           Json     @default("[]")
```

(Align the column to the model's existing formatting.)

Create `prisma/migrations/20260925010000_coding_collect_exclude/migration.sql`:

```sql
-- Additive: per-agent workspace paths never collected from a coding run. See
-- docs/superpowers/specs/2026-09-25-coding-package-registry-design.md §4.

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN     "collectExclude" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN     "collectExclude" JSONB NOT NULL DEFAULT '[]';
```

Run: `npm run prisma:generate`

- [ ] **Step 5: Snapshot at dispatch and expose through MCP**

In `src/core/dispatch.ts`, inside `tx.codingRun.create({ data: { ... } })`, after the `protectedPaths:` line:

```ts
              collectExclude: agent.codingProfile.collectExclude as Prisma.InputJsonValue,
```

In `src/mcp/tools/agents.ts`, in the coding-profile input JSON schema after `protectedPaths` (line 127):

```ts
    collectExclude: { type: "array", maxItems: 64, items: { type: "string" } },
```

and in `storedProfile()` (lines 167-182, which re-parses the stored row before an update merges into it), after `protectedPaths: profile.protectedPaths,`:

```ts
    collectExclude: profile.collectExclude,
```

(MCP output is the raw Prisma row, so the new column appears in `create_agent`, `get_agent`, and `update_agent` results without a mapper.)

- [ ] **Step 6: Run the tests and the drift check**

Run: `npx vitest run src/coding/profile.test.ts src/core/dispatch.test.ts src/mcp/tools/agents.test.ts`
Expected: PASS.

Then run the drift check exactly as written in this worktree's `CLAUDE.md` ("Required drift check") and `npx prisma validate`.
Expected: `-- This is an empty migration.`

- [ ] **Step 7: Commit**

```bash
git add src/coding/profile.ts src/coding/profile.test.ts prisma/schema.prisma \
  prisma/migrations/20260925010000_coding_collect_exclude src/core/dispatch.ts src/core/dispatch.test.ts \
  src/mcp/tools/agents.ts src/mcp/tools/agents.test.ts
git commit -m "feat(coding): per-agent collectExclude snapshotted at dispatch"
```

---

### Task 3: Kubernetes keeper excludes the paths from its archive

**Files:**

- Modify: `src/providers/jobs/types.ts:14-26` (`JobSpec`)
- Modify: `src/providers/executor/container.ts:55-80` (snapshot type), `:120-150` (row mapping), `:851-861` (`jobSpec` return)
- Modify: `src/providers/jobs/kubernetes.ts` (`RunRecord`, `launch` record creation, `materializeWorkspace`, `extractWorkspace`)
- Test: `src/providers/jobs/kubernetes.test.ts`, `src/providers/executor/container.test.ts`

**Interfaces:**

- Consumes: `CollectExclusions`, `normalizeCollectExclusions`, `collectExclusions`, `tarExcludeArgs` (Task 1); `CodingRun.collectExclude` (Task 2).
- Produces: `JobSpec.collectExclude?: CollectExclusions`; `ContainerRunSnapshot.collectExclude: unknown`.

- [ ] **Step 1: Write the failing tests**

In `src/providers/jobs/kubernetes.test.ts`, next to the `materializeWorkspace` test that pipes `./changed.txt`, add:

```ts
it("excludes dependency folders and per-agent paths from the keeper archive", async () => {
  const h = await harness();
  const handle = await h.launcher.launch({
    ...h.spec,
    collectExclude: { names: ["node_modules"], paths: ["web/dist"] },
  });
  await h.finish(handle);
  const target = join(h.workspaceRoot, h.spec.runId, "workspace");
  let archiveCommand: string[] = [];
  h.api.onExec = async ({ command, stdout }) => {
    if (command[0] === "tar" && command.includes("-cf")) {
      archiveCommand = command;
      const pack = tar.pack();
      pack.entry({ name: "./kept.txt" }, "kept");
      pack.finalize();
      (pack as unknown as Readable).pipe(stdout as PassThrough);
      await new Promise((r) => (stdout as PassThrough).once("finish", r));
    } else stdout?.end();
    return 0;
  };
  await h.launcher.materializeWorkspace(handle, target);
  expect(archiveCommand).toEqual([
    "tar",
    "-C",
    expect.any(String),
    "--no-anchored",
    "--exclude=node_modules",
    "--anchored",
    "--exclude=./web/dist",
    "-cf",
    "-",
    ".",
  ]);
});

it("falls back to the built-in exclusions for a record launched without any", async () => {
  const h = await harness();
  const handle = await h.launcher.launch(h.spec);
  await h.finish(handle);
  let archiveCommand: string[] = [];
  h.api.onExec = async ({ command, stdout }) => {
    if (command[0] === "tar" && command.includes("-cf")) {
      archiveCommand = command;
      const pack = tar.pack();
      pack.finalize();
      (pack as unknown as Readable).pipe(stdout as PassThrough);
      await new Promise((r) => (stdout as PassThrough).once("finish", r));
    } else stdout?.end();
    return 0;
  };
  await h.launcher.materializeWorkspace(handle, join(h.workspaceRoot, h.spec.runId, "workspace"));
  expect(archiveCommand).toContain("--exclude=node_modules");
  expect(archiveCommand).toContain("--exclude=.venv");
});
```

In `src/providers/executor/container.test.ts`, find the test that asserts the launched job spec (search for `lastSpec`) and add:

```ts
it("passes the run's collection exclusions to the job spec", async () => {
  const created = await harness({ collectExclude: ["web/dist"] });
  await created.executor.start("run-1");
  expect(created.jobs.lastSpec?.collectExclude).toEqual({
    names: expect.arrayContaining(["node_modules", ".venv"]),
    paths: ["web/dist"],
  });
});
```

If the container test `harness()` does not yet accept `collectExclude`, extend its option object and the run row it builds with `collectExclude: options.collectExclude ?? []` alongside `protectedPaths`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/providers/jobs/kubernetes.test.ts src/providers/executor/container.test.ts`
Expected: FAIL — the tar command has no exclude options; `lastSpec.collectExclude` is undefined.

- [ ] **Step 3: Add `collectExclude` to the job spec**

In `src/providers/jobs/types.ts`:

```ts
import type { CollectExclusions } from "../../coding/collect-exclude.js";

export interface JobSpec {
  // ...existing fields...
  /** Workspace paths never collected; absent on legacy specs, which get the built-in names. */
  collectExclude?: CollectExclusions;
}
```

In `src/providers/executor/container.ts`:

- Add `collectExclude: unknown;` to the run snapshot interface after `protectedPaths: unknown;`.
- In the row mapping, after `protectedPaths: row.codingRun.protectedPaths,` add `collectExclude: row.codingRun.collectExclude,`.
- Import `normalizeCollectExclusions` from `../../coding/collect-exclude.js`, and in the object `jobSpec` returns add, after `limits: ...,`:

```ts
      collectExclude: normalizeCollectExclusions(run.collectExclude),
```

- [ ] **Step 4: Apply the exclusions in the Kubernetes launcher**

In `src/providers/jobs/kubernetes.ts`:

- Import `collectExclusions, normalizeCollectExclusions, tarExcludeArgs, type CollectExclusions` from `../../coding/collect-exclude.js`.
- Add to the `RunRecord` interface: `collectExclude?: CollectExclusions;`
- Where `launch` builds the new record (the object containing `specHash`, `diskMb`, `createdAt`, `deadlineAt`), add `collectExclude: spec.collectExclude ?? collectExclusions([]),`.
- In `materializeWorkspace`, pass the record's exclusions: change the extraction call to
  `this.extractWorkspace(names, staging, maxBytes, this.transferBudgetMs(record), normalizeCollectExclusions(record.collectExclude?.paths))`
  (paths only: the names are always the current built-in list).
- Change `extractWorkspace`'s signature and exec command:

```ts
  private async extractWorkspace(
    names: RunNames,
    staging: string,
    maxBytes: number,
    timeoutMs: number,
    exclusions: CollectExclusions,
  ) {
    // ...unchanged setup...
    const execution = this.api
      .exec(
        this.namespace,
        names.pod,
        KEEPER_CONTAINER,
        ["tar", "-C", WORKSPACE_STORAGE, ...tarExcludeArgs(exclusions), "-cf", "-", "."],
        { stdout: output, timeoutMs },
      )
    // ...unchanged remainder...
```

Update the method's doc comment: "Excluded dependency and cache paths never leave the pod (see src/coding/collect-exclude.ts)."

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/providers/jobs/kubernetes.test.ts src/providers/executor/container.test.ts`
Expected: PASS, including every pre-existing `materializeWorkspace` test (they match on `command[0] === "tar" && command.includes("-cf")`).

- [ ] **Step 6: Commit**

```bash
git add src/providers/jobs/types.ts src/providers/jobs/kubernetes.ts src/providers/jobs/kubernetes.test.ts \
  src/providers/executor/container.ts src/providers/executor/container.test.ts
git commit -m "feat(jobs): keep excluded workspace paths inside the Kubernetes pod"
```

---

### Task 4: Docker prunes excluded paths before validating

**Files:**

- Create: `src/providers/jobs/collect-prune.ts`
- Test: `src/providers/jobs/collect-prune.test.ts`
- Modify: `src/providers/jobs/docker.ts:591-610` (`materializeWorkspace`), `:327-341` (`materializeDirectory`), and the `DockerArtifactTransfer` interface's `materializeDirectory` signature
- Test: `src/providers/jobs/docker.test.ts`

**Interfaces:**

- Consumes: `CollectExclusions`, `isCollectExcluded`, `normalizeCollectExclusions` (Task 1); `JobSpec.collectExclude` (Task 3).
- Produces: `pruneCollectExcluded(root: string, exclusions: CollectExclusions): Promise<void>`; `DockerArtifactTransfer.materializeDirectory(container, source, destination, maxBytes, exclusions)`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/providers/jobs/collect-prune.test.ts
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExclusions } from "../../coding/collect-exclude.js";
import { pruneCollectExcluded } from "./collect-prune.js";
import { validateMaterializedWorkspace } from "./docker.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pruneCollectExcluded", () => {
  it("removes excluded folders, including escaping symlinks inside them, without following links", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-prune-"));
    const outside = await mkdtemp(join(tmpdir(), "wardby-prune-outside-"));
    roots.push(root, outside);
    await writeFile(join(outside, "keep.txt"), "must survive");
    await mkdir(join(root, "web", "node_modules", "react"), { recursive: true });
    await writeFile(join(root, "web", "node_modules", "react", "index.js"), "x");
    await symlink(outside, join(root, "web", "node_modules", "escape"));
    await mkdir(join(root, "web", "dist"), { recursive: true });
    await writeFile(join(root, "web", "dist", "app.js"), "built");
    await writeFile(join(root, "web", "app.ts"), "source");

    await pruneCollectExcluded(root, collectExclusions(["web/dist"]));

    expect((await readdir(join(root, "web"))).sort()).toEqual(["app.ts"]);
    expect(await readdir(outside)).toEqual(["keep.txt"]);
    await expect(validateMaterializedWorkspace(root, 1024 * 1024)).resolves.toBeUndefined();
  });
});
```

In `src/providers/jobs/docker.test.ts`, find the fake `DockerArtifactTransfer` used by `materializeWorkspace` tests and assert the exclusions reach it:

```ts
it("passes the job's collection exclusions to the workspace transfer", async () => {
  // Build the launcher with the existing fake transfer; record materializeDirectory's 5th argument.
  // Launch with spec.collectExclude = { names: ["node_modules"], paths: ["web/dist"] }, finish the job,
  // call materializeWorkspace, and expect the recorded exclusions to equal that object.
});
```

Write that test concretely against the fake transfer class the file already defines (it records calls in an array; add `exclusions` to what it records).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/providers/jobs/collect-prune.test.ts src/providers/jobs/docker.test.ts`
Expected: FAIL — module missing; transfer not given exclusions.

- [ ] **Step 3: Implement the prune**

```ts
// src/providers/jobs/collect-prune.ts
import { lstat, opendir, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isCollectExcluded, type CollectExclusions } from "../../coding/collect-exclude.js";

/**
 * Deletes every excluded path from a staging copy of a workspace before it is
 * validated. Walks with lstat and never descends through a symlink; `rm` removes
 * a symlink itself, not its target.
 */
export async function pruneCollectExcluded(root: string, exclusions: CollectExclusions): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const handle = await opendir(directory);
    const children: string[] = [];
    for await (const entry of handle) children.push(join(directory, entry.name));
    for (const child of children) {
      const relativePath = relative(root, child).split(sep).join("/");
      if (isCollectExcluded(relativePath, exclusions)) {
        await rm(child, { recursive: true, force: true });
        continue;
      }
      const metadata = await lstat(child);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await visit(child);
    }
  };
  await visit(root);
}
```

- [ ] **Step 4: Prune in the Docker transfer**

In `src/providers/jobs/docker.ts`:

- Import `normalizeCollectExclusions, type CollectExclusions` from `../../coding/collect-exclude.js` and `pruneCollectExcluded` from `./collect-prune.js`.
- Add `exclusions: CollectExclusions` as the fifth parameter of `materializeDirectory` in the `DockerArtifactTransfer` interface and the Node implementation, and prune after the copy:

```ts
  async materializeDirectory(
    container: string,
    source: string,
    destination: string,
    maxBytes: number,
    exclusions: CollectExclusions,
  ): Promise<void> {
    await replaceDirectoryFromStaging(
      destination,
      maxBytes,
      "docker_workspace_destination_invalid",
      async (staging) => {
        await new NodeDockerCommandRunner({ dockerBinary: this.dockerBinary, homeDir: "/tmp", path: this.path }).run([
          "container",
          "cp",
          `${container}:${source}/.`,
          staging,
        ]);
        // Before replaceDirectoryFromStaging validates: excluded folders never count.
        await pruneCollectExcluded(staging, exclusions);
      },
    );
  }
```

- In `materializeWorkspace`, pass `normalizeCollectExclusions(current.spec.collectExclude?.paths)` as the fifth argument.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/providers/jobs/collect-prune.test.ts src/providers/jobs/docker.test.ts src/providers/jobs/workspace-swap.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/jobs/collect-prune.ts src/providers/jobs/collect-prune.test.ts \
  src/providers/jobs/docker.ts src/providers/jobs/docker.test.ts
git commit -m "feat(jobs): prune excluded workspace paths before Docker validation"
```

---

### Task 5: Git staging leaves excluded paths alone

**Files:**

- Modify: `src/providers/vcs/types.ts:6` and `:39` (`VcsPrepareInput`, `PreparedWorkspace`)
- Modify: `src/providers/vcs/git.ts:425` (`git add`), `:615-625` (input normalization), `:645-652` (recovery equality)
- Modify: `src/providers/executor/container.ts:668-676` (preflight return) and `:905-912` (`preflightForCleanup`)
- Create: `src/providers/vcs/git-collect-exclude.integration.test.ts`
- Test: `src/providers/vcs/git.test.ts`

**Interfaces:**

- Consumes: `CollectExclusions`, `normalizeCollectExclusions`, `gitExcludePathspecs` (Task 1).
- Produces: `VcsPrepareInput.collectExclude?: string[]` (paths only); `PreparedWorkspace.collectExclude: string[]`.

- [ ] **Step 1: Write the failing tests**

In `src/providers/vcs/git.test.ts`, add inside `describe("GitVcsProvider")`:

```ts
it("stages with exclude pathspecs so excluded paths are neither added nor deleted", async () => {
  const { provider, git, input } = await harness();
  const prepared = await provider.prepareWorkspace({ ...input, collectExclude: ["web/dist"] });
  await provider.finalizeChanges(prepared);
  const add = git.calls.find((call) => call.args.includes("add"));
  expect(add?.args.slice(add.args.indexOf("--"))).toEqual([
    "--",
    ":/",
    ...gitExcludePathspecs(collectExclusions(["web/dist"])),
  ]);
});

it("treats a changed collectExclude as a different workspace on recovery", async () => {
  const { provider, input } = await harness();
  await provider.prepareWorkspace({ ...input, collectExclude: ["web/dist"] });
  await expect(provider.recoverWorkspace({ ...input, collectExclude: [] })).rejects.toThrow();
});
```

(Import `collectExclusions` and `gitExcludePathspecs` from `../../coding/collect-exclude.js`. If `RecordedCall` names its argv field differently than `args`, use that name.)

Create the real-Git proof:

```ts
// src/providers/vcs/git-collect-exclude.integration.test.ts
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { collectExclusions, gitExcludePathspecs } from "../../coding/collect-exclude.js";

const run = promisify(execFile);
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false"];

describe("collection exclusions at staging (real git)", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  it("keeps a tracked file under an excluded folder and ignores an untracked one", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-collect-exclude-"));
    roots.push(root);
    const work = join(root, "work");
    await run("git", ["init", "--initial-branch=main", work]);
    await mkdir(join(work, "vendor", "node_modules"), { recursive: true });
    await writeFile(join(work, "vendor", "node_modules", "tracked.js"), "tracked\n");
    await writeFile(join(work, "app.ts"), "v1\n");
    await run("git", [...IDENTITY, "add", "."], { cwd: work });
    await run("git", [...IDENTITY, "commit", "-m", "base"], { cwd: work });

    // What collection hands back: excluded folders are absent, a new install folder is present.
    await rm(join(work, "vendor", "node_modules"), { recursive: true });
    await mkdir(join(work, "web", "node_modules", "react"), { recursive: true });
    await writeFile(join(work, "web", "node_modules", "react", "index.js"), "installed\n");
    await writeFile(join(work, "app.ts"), "v2\n");

    const specs = gitExcludePathspecs(collectExclusions([]));
    await run("git", [...IDENTITY, "add", "--all", "--", ":/", ...specs], { cwd: work });
    const { stdout } = await run("git", ["diff", "--cached", "--name-status", "--no-renames", "HEAD"], {
      cwd: work,
    });
    expect(stdout.trim()).toBe("M\tapp.ts");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/providers/vcs/git.test.ts src/providers/vcs/git-collect-exclude.integration.test.ts`
Expected: the unit tests FAIL (`collectExclude` not accepted / no pathspecs). The integration test PASSES already — it proves the pathspec syntax against real Git before the provider uses it.

- [ ] **Step 3: Carry the paths through the VCS types**

In `src/providers/vcs/types.ts`, add to `VcsPrepareInput`:

```ts
  /** Repository-relative paths never collected, in addition to the built-in names. */
  collectExclude?: string[];
```

and to `PreparedWorkspace`:

```ts
  collectExclude: string[];
```

- [ ] **Step 4: Normalize, compare on recovery, and stage with pathspecs**

In `src/providers/vcs/git.ts`:

- Import `gitExcludePathspecs, normalizeCollectExclusions` from `../../coding/collect-exclude.js`.
- In the input normalization (currently `return { runId: input.runId, repository, baseRef, headRef, protectedPaths, continuation };`), compute and return `collectExclude`:

```ts
const collectExclude = [...normalizeCollectExclusions(input.collectExclude ?? []).paths];
return { runId: input.runId, repository, baseRef, headRef, protectedPaths, collectExclude, continuation };
```

- In the recovery comparison that already compares `protectedPaths` element by element, add the same comparison for `collectExclude`:

```ts
      workspace.collectExclude.length !== normalized.collectExclude.length ||
      workspace.collectExclude.some((path, index) => path !== normalized.collectExclude[index]) ||
```

- Replace the staging call in `finalizeChanges`:

```ts
await this.gitFor(prepared, [
  "add",
  "--all",
  "--",
  ":/",
  ...gitExcludePathspecs(normalizeCollectExclusions(prepared.collectExclude)),
]);
```

In `src/providers/executor/container.ts`, add `collectExclude: normalizeCollectExclusions(run.collectExclude).paths as string[],` (or `[...normalizeCollectExclusions(run.collectExclude).paths]`) to the preflight return object after `protectedPaths: profile.protectedPaths,`, and to `preflightForCleanup`'s returned object after `protectedPaths: run.protectedPaths,` (there, skip it if normalization throws, by returning `null` like the existing `protectedPaths` guard).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/providers/vcs src/providers/executor/container.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/vcs/types.ts src/providers/vcs/git.ts src/providers/vcs/git.test.ts \
  src/providers/vcs/git-collect-exclude.integration.test.ts src/providers/executor/container.ts
git commit -m "feat(vcs): stage around excluded paths so tracked files there are untouched"
```

---

### Task 6: Documentation, spec amendment, and full verification

**Files:**

- Modify: `docs/coding-worker-isolation.md` (the "Coding-agent authoring and execution" area, after the tag paragraph)
- Modify: `docs/superpowers/specs/2026-09-25-coding-package-registry-design.md` (sections 1 and 4)

- [ ] **Step 1: Document collection exclusions**

Add to `docs/coding-worker-isolation.md` after the paragraph about the result `tag`:

```markdown
Some workspace folders are never collected from a run: `node_modules`, `.venv`,
`venv`, `__pycache__`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, `.tox`,
`.vite`, and `.cache`, at any depth, plus any repository-relative paths in the
agent's `collectExclude` (for example `web/dist`). On Kubernetes the keeper's
`tar` leaves them out, so they never leave the pod; on Docker they are removed
from the staging copy before it is validated. They therefore never count toward
the entry, size, symlink, or nested-repository checks, and Git staging excludes
them too, so a tracked file under an excluded folder is left unchanged.
```

- [ ] **Step 2: Amend the spec to match what was built**

In the spec's section 1 `collectExclude` bullet, replace "globs" with "repository-relative paths (no wildcards)". In section 4:

- "The profile's `collectExclude` globs." → "The profile's `collectExclude` paths (literal repository-relative paths; each excludes that path and everything under it)."
- Replace the Docker bullet with: "**Docker:** after `docker container cp` fills the staging copy, excluded paths are removed from it (without following symlinks) before `validateMaterializedWorkspace` runs. Moving Docker collection onto `safeExtract` needs a streaming command runner and is left as a separate hardening change."

- [ ] **Step 3: Run the full verification**

Run: `npm run lint && npm run format:check && npm run build && npm test`
Expected: all pass (Postgres from `npm run db:up` must be running for the database tests).

- [ ] **Step 4: Commit**

```bash
git add docs/coding-worker-isolation.md docs/superpowers/specs/2026-09-25-coding-package-registry-design.md
git commit -m "docs: document coding collection exclusions"
```

---

## Self-review notes

- Spec §4 coverage: built-in names (Task 1), profile paths (Task 2), Kubernetes tar (Task 3), Docker (Task 4, amended), commit pathspecs (Task 5), docs (Task 6).
- Deliberate spec amendments, recorded in Task 6: `collectExclude` is literal paths rather than globs (GNU tar and Git glob semantics differ; literal paths render identically in both), and Docker prunes the staging copy instead of moving to `safeExtract`.
