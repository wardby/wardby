import { describe, expect, it } from "vitest";
import { WARM_FINGERPRINT } from "./types.js";
import {
  canonicalJson,
  systemPromptSha256,
  warmFingerprint,
  type WarmFingerprintInput,
  type WarmSecretVersion,
} from "./warm-fingerprint.js";

const API_KEY: WarmSecretVersion = { id: "secret-1", name: "API_KEY", updatedAt: "2026-11-14T10:00:00.000Z" };
const TOKEN: WarmSecretVersion = { id: "secret-2", name: "mcp:docs/TOKEN", updatedAt: "2026-11-14T11:00:00.000Z" };

const INPUT: WarmFingerprintInput = {
  agentId: "agent-1",
  provider: "claude-code",
  model: "claude-sonnet-5",
  workerImage: `registry.example/claude@sha256:${"a".repeat(64)}`,
  toolImage: `registry.example/claude-tools@sha256:${"c".repeat(64)}`,
  cpu: 1,
  memoryMb: 1024,
  diskMb: 512,
  systemPromptSha256: systemPromptSha256("You fix bugs."),
  repository: "openai/example",
  secrets: [],
};

describe("warmFingerprint", () => {
  it("is SHA-256 over the canonical JSON of exactly its fields (pinned)", () => {
    expect(systemPromptSha256("You fix bugs.")).toBe(
      "465b460d16929578f1309cdae3f261f0e98dde7d633069f552a9207d7b0c6e42",
    );
    expect(canonicalJson(INPUT)).toBe(
      '{"agentId":"agent-1","cpu":1,"diskMb":512,"memoryMb":1024,"model":"claude-sonnet-5",' +
        '"provider":"claude-code","repository":"openai/example","secrets":[],' +
        '"systemPromptSha256":"465b460d16929578f1309cdae3f261f0e98dde7d633069f552a9207d7b0c6e42",' +
        `"toolImage":"registry.example/claude-tools@sha256:${"c".repeat(64)}",` +
        `"workerImage":"registry.example/claude@sha256:${"a".repeat(64)}"}`,
    );
    expect(warmFingerprint(INPUT)).toBe("3c002da7b8612c87bd6ee1970a57542b28c5c23b8f65d5df50d4b698aed1e1df");
    expect(warmFingerprint(INPUT)).toMatch(WARM_FINGERPRINT);
  });

  it("is stable whatever order the fields come in, and ignores anything else", () => {
    const reversed = Object.fromEntries(Object.entries(INPUT).reverse()) as unknown as WarmFingerprintInput;
    expect(warmFingerprint(reversed)).toBe(warmFingerprint(INPUT));
    expect(warmFingerprint({ ...INPUT, extra: "ignored" } as WarmFingerprintInput)).toBe(warmFingerprint(INPUT));
  });

  it.each([
    ["agentId", "agent-2"],
    ["provider", "codex"],
    ["model", "claude-opus-5"],
    ["workerImage", `registry.example/claude@sha256:${"b".repeat(64)}`],
    ["toolImage", `registry.example/claude-tools@sha256:${"d".repeat(64)}`],
    ["cpu", 2],
    ["memoryMb", 2048],
    ["diskMb", 1024],
    ["systemPromptSha256", systemPromptSha256("You fix other bugs.")],
    ["repository", "openai/other"],
  ] as const)("changes when %s changes", (field, value) => {
    expect(warmFingerprint({ ...INPUT, [field]: value })).not.toBe(warmFingerprint(INPUT));
  });

  describe("secrets (identity and version only)", () => {
    const WITH = { ...INPUT, secrets: [API_KEY, TOKEN] };

    it("changes when a secret is rotated (a new updatedAt), attached, detached or recreated", () => {
      const base = warmFingerprint(WITH);
      expect(
        warmFingerprint({ ...WITH, secrets: [{ ...API_KEY, updatedAt: "2026-11-14T12:00:00.000Z" }, TOKEN] }),
      ).not.toBe(base);
      expect(warmFingerprint({ ...WITH, secrets: [API_KEY] })).not.toBe(base);
      expect(warmFingerprint({ ...WITH, secrets: [API_KEY, TOKEN, { ...API_KEY, name: "OTHER" }] })).not.toBe(base);
      expect(warmFingerprint({ ...WITH, secrets: [{ ...API_KEY, id: "secret-9" }, TOKEN] })).not.toBe(base);
      expect(warmFingerprint(INPUT)).not.toBe(base);
    });

    it("does not depend on the order the secrets come in", () => {
      expect(warmFingerprint({ ...WITH, secrets: [TOKEN, API_KEY] })).toBe(warmFingerprint(WITH));
    });

    it("takes only the id, name and updatedAt of each: a value passed along is ignored, never hashed", () => {
      const leaky = { ...API_KEY, value: "sk-fake-secret-value-0001" } as WarmSecretVersion;
      expect(warmFingerprint({ ...WITH, secrets: [leaky, TOKEN] })).toBe(warmFingerprint(WITH));
    });
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });
});
