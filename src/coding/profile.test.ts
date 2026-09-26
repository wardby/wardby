import { describe, expect, it } from "vitest";
import { CodingProfilePatchSchema, CodingProfileSchema, DEFAULT_PROTECTED_PATHS } from "./profile.js";

describe("CodingProfileSchema", () => {
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
      collectExclude: [],
      packageAllowlist: {},
      packagePolicy: {},
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
