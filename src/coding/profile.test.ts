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
      allowedEgress: [],
      protectedPaths: [...DEFAULT_PROTECTED_PATHS],
      toolchain: "node",
      toolchainVersion: null,
      workerImageRef: null,
    });
  });

  it.each([
    { repository: "https://token@github.com/openai/example" },
    { repository: "openai/example", baseRef: "-c core.hooksPath=/tmp/pwn" },
    { repository: "openai/example", timeoutSec: 59 },
    { repository: "openai/example", timeoutSec: 7201 },
    { repository: "openai/example", allowedEgress: ["https://registry.npmjs.org"] },
    { repository: "openai/example", allowedEgress: ["127.0.0.1"] },
    { repository: "openai/example", allowedEgress: ["999.999.999.999"] },
    { repository: "openai/example", allowedEgress: ["*.npmjs.org"] },
    { repository: "openai/example", protectedPaths: ["../secrets"] },
    { repository: "openai/example", protectedPaths: ["/etc/passwd"] },
    { repository: "openai/example", credential: "secret" },
    { repository: "openai/example", toolchain: "node-cobol" },
    { repository: "openai/example", workerImageRef: "reevo-coding-worker:latest" },
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

  it("normalizes and deduplicates host and protected-path policy", () => {
    const parsed = CodingProfileSchema.parse({
      repository: "openai/example",
      allowedEgress: ["Registry.NPMJS.org", "registry.npmjs.org"],
      protectedPaths: [".github/workflows/**", ".github/workflows/**", "CODEOWNERS"],
    });
    expect(parsed.allowedEgress).toEqual(["registry.npmjs.org"]);
    expect(parsed.protectedPaths).toEqual([".github/workflows/**", "CODEOWNERS"]);
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
