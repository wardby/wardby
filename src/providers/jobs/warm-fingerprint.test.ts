import { describe, expect, it } from "vitest";
import { WARM_FINGERPRINT } from "./types.js";
import { canonicalJson, systemPromptSha256, warmFingerprint, type WarmFingerprintInput } from "./warm-fingerprint.js";

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
};

describe("warmFingerprint", () => {
  it("is SHA-256 over the canonical JSON of exactly its fields (pinned)", () => {
    expect(systemPromptSha256("You fix bugs.")).toBe(
      "465b460d16929578f1309cdae3f261f0e98dde7d633069f552a9207d7b0c6e42",
    );
    expect(canonicalJson(INPUT)).toBe(
      '{"agentId":"agent-1","cpu":1,"diskMb":512,"memoryMb":1024,"model":"claude-sonnet-5",' +
        '"provider":"claude-code","repository":"openai/example",' +
        '"systemPromptSha256":"465b460d16929578f1309cdae3f261f0e98dde7d633069f552a9207d7b0c6e42",' +
        `"toolImage":"registry.example/claude-tools@sha256:${"c".repeat(64)}",` +
        `"workerImage":"registry.example/claude@sha256:${"a".repeat(64)}"}`,
    );
    expect(warmFingerprint(INPUT)).toBe("dd43a1345e4ff60f3501b71695a5bd34ac6a9e2584429bc4a042bb56b41ea182");
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

  it("sorts nested keys too", () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });
});
