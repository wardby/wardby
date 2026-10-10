import { describe, expect, it } from "vitest";
import { CodingProfilePatchSchema, CodingProfileSchema, DEFAULT_PROTECTED_PATHS } from "./profile.js";

describe("CodingProfileSchema", () => {
  it("accepts a local repository and normalizes its path; GitHub validation is unchanged", () => {
    expect(CodingProfileSchema.parse({ repository: "local:/srv/repos/app/" }).repository).toBe("local:/srv/repos/app");
    expect(CodingProfileSchema.safeParse({ repository: "local:relative/path" }).success).toBe(false);
    expect(CodingProfileSchema.safeParse({ repository: "local:" }).success).toBe(false);
    expect(CodingProfileSchema.safeParse({ repository: "https://token@github.com/o/r" }).success).toBe(false);
  });

  it("normalizes identifiers and applies fail-safe defaults", () => {
    expect(CodingProfileSchema.parse({ repository: "OpenAI/Example.git" })).toEqual({
      provider: "codex",
      repository: "openai/example",
      baseRef: "main",
      defaultTask: null,
      allowWebhookTaskOverride: false,
      timeoutSec: 1800,
      protectedPaths: [...DEFAULT_PROTECTED_PATHS],
      toolchain: "node",
      toolchainVersion: null,
      workerImageRef: null,
      workspaceDiskMb: null,
      maxTurns: null,
      collectExclude: [],
      packageAllowlist: {},
      packagePolicy: {},
      services: [],
      repoSkills: true,
      claudeBareMode: true,
    });
  });

  it("validates package allowlists per ecosystem", () => {
    const base = { repository: "openai/example" };
    expect(
      CodingProfileSchema.parse({ ...base, packageAllowlist: { npm: ["@heroui/*", "react@^19"], pypi: ["flask>=3"] } })
        .packageAllowlist,
    ).toEqual({ npm: ["@heroui/*", "react@^19"], pypi: ["flask>=3"] });
    expect(() => CodingProfileSchema.parse({ ...base, packageAllowlist: { cargo: ["serde"] } })).toThrow();
    expect(() => CodingProfileSchema.parse({ ...base, packageAllowlist: { npm: ["react@nope"] } })).toThrow();
    expect(() => CodingProfileSchema.parse({ ...base, packagePolicy: { minReleaseAgeDays: 31 } })).toThrow();
  });

  it.each([
    { repository: "https://token@github.com/openai/example" },
    { repository: "openai/example", baseRef: "-c core.hooksPath=/tmp/pwn" },
    { repository: "openai/example", maxTurns: 0 },
    { repository: "openai/example", maxTurns: 1001 },
    { repository: "openai/example", maxTurns: 12.5 },
    { repository: "openai/example", timeoutSec: 59 },
    { repository: "openai/example", timeoutSec: 7201 },
    { repository: "openai/example", allowedEgress: [] },
    { repository: "openai/example", protectedPaths: ["../secrets"] },
    { repository: "openai/example", protectedPaths: ["/etc/passwd"] },
    { repository: "openai/example", credential: "secret" },
    { repository: "openai/example", toolchain: "node-cobol" },
    { repository: "openai/example", workerImageRef: "wardby-coding-worker:latest" },
    { repository: "openai/example", provider: "unknown" },
  ])("rejects unsafe profile %#", (profile) => {
    expect(() => CodingProfileSchema.parse(profile)).toThrow();
  });

  it("accepts a known toolchain, a version string, and a valid immutable workerImageRef", () => {
    const result = CodingProfileSchema.parse({
      repository: "openai/example",
      toolchain: "node-python",
      toolchainVersion: "3.12",
      workerImageRef: `registry.example/byo@sha256:${"e".repeat(64)}`,
    });
    expect(result.toolchain).toBe("node-python");
    expect(result.toolchainVersion).toBe("3.12");
    expect(result.workerImageRef).toBe(`registry.example/byo@sha256:${"e".repeat(64)}`);
  });

  it("accepts the explicit Claude Code provider", () => {
    expect(CodingProfileSchema.parse({ repository: "openai/example", provider: "claude-code" }).provider).toBe(
      "claude-code",
    );
  });

  it("deduplicates protected-path policy", () => {
    const parsed = CodingProfileSchema.parse({
      repository: "openai/example",
      protectedPaths: [".github/workflows/**", ".github/workflows/**", "CODEOWNERS"],
    });
    expect(parsed.protectedPaths).toEqual([".github/workflows/**", "CODEOWNERS"]);
  });

  it("accepts an optional per-agent workspace size between 64 MiB and 32 GiB", () => {
    const base = { repository: "openai/example" };
    expect(CodingProfileSchema.parse(base).workspaceDiskMb).toBeNull();
    expect(CodingProfileSchema.parse({ ...base, workspaceDiskMb: 8192 }).workspaceDiskMb).toBe(8192);
    for (const bad of [32, 64.5, 40_000]) {
      expect(() => CodingProfileSchema.parse({ ...base, workspaceDiskMb: bad })).toThrow();
    }
    expect(CodingProfilePatchSchema.parse({ workspaceDiskMb: null })).toEqual({ workspaceDiskMb: null });
  });

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
});

describe("CodingProfilePatchSchema", () => {
  it("accepts bounded partial updates and explicit default-task clearing", () => {
    expect(
      CodingProfilePatchSchema.parse({ defaultTask: null, allowWebhookTaskOverride: true, timeoutSec: 600 }),
    ).toEqual({
      defaultTask: null,
      allowWebhookTaskOverride: true,
      timeoutSec: 600,
    });
  });

  it("rejects unknown patch fields", () => {
    expect(() => CodingProfilePatchSchema.parse({ dockerSocket: "/var/run/docker.sock" })).toThrow();
  });
});

describe("services", () => {
  it("defaults to none, dedupes, and refuses a malformed name", () => {
    expect(CodingProfileSchema.parse({ repository: "openai/example" }).services).toEqual([]);
    expect(
      CodingProfileSchema.parse({ repository: "openai/example", services: ["postgres", "redis", "postgres"] }).services,
    ).toEqual(["postgres", "redis"]);
    expect(CodingProfileSchema.safeParse({ repository: "openai/example", services: ["Postgres"] }).success).toBe(false);
    expect(CodingProfilePatchSchema.parse({ services: ["redis"] })).toEqual({ services: ["redis"] });
  });
});

describe("repoSkills", () => {
  it("defaults repoSkills to true and accepts false", () => {
    expect(CodingProfileSchema.parse({ repository: "o/r" }).repoSkills).toBe(true);
    expect(CodingProfileSchema.parse({ repository: "o/r", repoSkills: false }).repoSkills).toBe(false);
    expect(CodingProfilePatchSchema.parse({ repoSkills: false })).toEqual({ repoSkills: false });
    expect(() => CodingProfileSchema.parse({ repository: "o/r", repoSkills: "no" })).toThrow();
  });
});

describe("claudeBareMode", () => {
  it("defaults claudeBareMode to true and accepts false", () => {
    expect(CodingProfileSchema.parse({ repository: "o/r" }).claudeBareMode).toBe(true);
    expect(CodingProfileSchema.parse({ repository: "o/r", claudeBareMode: false }).claudeBareMode).toBe(false);
    expect(CodingProfilePatchSchema.parse({ claudeBareMode: false })).toEqual({ claudeBareMode: false });
    expect(() => CodingProfileSchema.parse({ repository: "o/r", claudeBareMode: "no" })).toThrow();
  });
});

describe("protectedPaths exceptions", () => {
  it("defaults to protecting .wardby/ except the service declaration", () => {
    expect(DEFAULT_PROTECTED_PATHS).toEqual([
      ".github/workflows/**",
      ".github/CODEOWNERS",
      "CODEOWNERS",
      "docs/CODEOWNERS",
      ".wardby/**",
      "!.wardby/services.yaml",
    ]);
    expect(CodingProfileSchema.parse({ repository: "openai/example" }).protectedPaths).toEqual([
      ...DEFAULT_PROTECTED_PATHS,
    ]);
  });

  it("accepts a leading ! as an exception next to real patterns", () => {
    expect(
      CodingProfileSchema.parse({
        repository: "openai/example",
        protectedPaths: [".wardby/**", " !.wardby/services.yaml "],
      }).protectedPaths,
    ).toEqual([".wardby/**", "!.wardby/services.yaml"]);
  });

  it.each([
    ["only exceptions", ["!.wardby/services.yaml"]],
    ["an exception with nothing after it", ["CODEOWNERS", "!"]],
    ["a double exception", ["CODEOWNERS", "!!x"]],
    ["an absolute exception", ["CODEOWNERS", "!/etc/passwd"]],
    ["a traversing exception", ["CODEOWNERS", "!../x"]],
    ["a wildcard exception", ["CODEOWNERS", "!**"]],
    ["a wildcard exception under .wardby/", ["CODEOWNERS", "!.wardby/*"]],
    ["a recursive exception under .wardby/", ["CODEOWNERS", "!.wardby/**"]],
    ["a top-level wildcard exception", ["CODEOWNERS", "!*"]],
    ["a wildcard exception over a protected tree", [".github/workflows/**", "!.github/**"]],
    ["a single-character wildcard exception", ["CODEOWNERS", "!docs/CODEOWNER?"]],
  ])("refuses %s", (_label, protectedPaths) => {
    expect(CodingProfileSchema.safeParse({ repository: "openai/example", protectedPaths }).success).toBe(false);
  });

  it("accepts a literal exception to a wildcard pattern", () => {
    expect(
      CodingProfileSchema.parse({ repository: "openai/example", protectedPaths: ["docs/**", "!docs/CODEOWNERS"] })
        .protectedPaths,
    ).toEqual(["docs/**", "!docs/CODEOWNERS"]);
  });
});
