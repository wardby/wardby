import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { resolvedFromDefinition } from "../../coding/services/catalog.js";
import { WARM_FINGERPRINT } from "./types.js";
import {
  canonicalJson,
  servicesFingerprint,
  systemPromptSha256,
  warmFingerprint,
  type WarmFingerprintInput,
  type WarmMcpToolPin,
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

describe("warmFingerprint MCP tool pins", () => {
  const PINS: WarmMcpToolPin[] = [
    { serverId: "srv-docs", exposedName: "docs__search" },
    { serverId: "srv-issues", exposedName: "issues__get" },
  ];
  const WITH = { ...INPUT, mcpTools: PINS };

  it("is today's fingerprint without pins", () => {
    const golden = "3c002da7b8612c87bd6ee1970a57542b28c5c23b8f65d5df50d4b698aed1e1df";
    expect(warmFingerprint(INPUT)).toBe(golden);
    expect(warmFingerprint({ ...INPUT, mcpTools: [] })).toBe(golden);
  });

  it("pins the canonical JSON with pins", () => {
    expect(canonicalJson({ ...INPUT, mcpTools: PINS })).toBe(
      '{"agentId":"agent-1","cpu":1,"diskMb":512,"mcpTools":[{"exposedName":"docs__search","serverId":"srv-docs"},{"exposedName":"issues__get","serverId":"srv-issues"}],"memoryMb":1024,"model":"claude-sonnet-5","provider":"claude-code","repository":"openai/example","secrets":[],"systemPromptSha256":"465b460d16929578f1309cdae3f261f0e98dde7d633069f552a9207d7b0c6e42","toolImage":"registry.example/claude-tools@sha256:' +
        "c".repeat(64) +
        '","workerImage":"registry.example/claude@sha256:' +
        "a".repeat(64) +
        '"}',
    );
    expect(warmFingerprint(WITH)).toBe("63df6d9077c7607299329afbf4424930a8183d1987cd0fc16f47a535dc12c713");
  });

  it("ignores pin order and extra pin fields", () => {
    const base = warmFingerprint(WITH);
    expect(warmFingerprint({ ...INPUT, mcpTools: [...PINS].reverse() })).toBe(base);
    const fat = PINS.map((pin) => ({ ...pin, definition: { description: "x", inputSchema: {} } }));
    expect(warmFingerprint({ ...INPUT, mcpTools: fat })).toBe(base);
  });

  it.each([
    ["an exposedName", [{ serverId: "srv-docs", exposedName: "docs__find" }, PINS[1]]],
    ["a serverId", [{ serverId: "srv-docs-2", exposedName: "docs__search" }, PINS[1]]],
    ["a dropped pin", [PINS[0]]],
    ["no pins", []],
  ] as const)("changes with %s", (_label, pins) => {
    expect(warmFingerprint({ ...INPUT, mcpTools: pins })).not.toBe(warmFingerprint(WITH));
  });
});

describe("warmFingerprint services", () => {
  const entry = (name: string, version: string) =>
    resolvedFromDefinition(BUILTIN_CODING_SERVICES.find((s) => s.name === name && s.version === version)!);
  const postgres16 = entry("postgres", "16");
  const redis7 = entry("redis", "7");

  it("leaves a fingerprint without services unchanged", () => {
    expect(warmFingerprint({ ...INPUT, services: undefined })).toBe(warmFingerprint(INPUT));
    expect(warmFingerprint(INPUT)).toBe("3c002da7b8612c87bd6ee1970a57542b28c5c23b8f65d5df50d4b698aed1e1df");
  });

  it("changes with the services and their order does not matter", () => {
    const both = servicesFingerprint([postgres16, redis7]);
    expect(both).toBe(servicesFingerprint([redis7, postgres16]));
    expect(both).not.toBe(servicesFingerprint([postgres16]));
    expect(servicesFingerprint([postgres16])).not.toBe(
      servicesFingerprint([{ ...postgres16, startCommand: ["other"] }]),
    );
    expect(servicesFingerprint([])).toBeUndefined();
    expect(servicesFingerprint(undefined)).toBeUndefined();
  });

  it("pins the hash", () => {
    const hash = servicesFingerprint([postgres16]);
    expect(hash).toBe("3fef43fb0210cf8b3d48921c76eaa0011d4a2ce8e325201d2fc30e41122c8c56");
    expect(warmFingerprint({ ...INPUT, services: hash })).not.toBe(warmFingerprint(INPUT));
  });

  it("carries a hash, never a service value", () => {
    const fake = {
      ...postgres16,
      serviceEnv: { ...postgres16.serviceEnv, FAKE_SERVICE: "FAKE_SERVICE_ENV_VALUE_0001" },
    };
    const hash = servicesFingerprint([fake]);
    expect(hash).toMatch(WARM_FINGERPRINT);
    const input = { ...INPUT, services: hash };
    expect(canonicalJson(input)).toContain(hash);
    expect(canonicalJson(input)).not.toContain("FAKE_SERVICE_ENV_VALUE_0001");
    expect(hash).not.toBe(servicesFingerprint([postgres16]));
  });
});
