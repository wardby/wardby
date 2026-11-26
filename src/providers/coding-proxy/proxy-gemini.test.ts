import { describe, expect, it } from "vitest";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { CodingProxy, capabilityHash } from "./proxy.js";
import { shippedCatalog } from "../llm/catalog.js";
import { entryOf } from "../llm/catalog-types.js";
import { VERTEX_CREDENTIAL_REF } from "./gemini-upstream.js";
import { gemini, STUDIO, VERTEX_US } from "./gemini.test-support.js";
// Import only what the current task's tests use (lint refuses unused imports); later tasks extend this list.

describe("gemini-generate-content sessions", () => {
  it("creates an AI Studio and a Vertex session and stores the web-tool policy (default off)", async () => {
    const studio = await gemini();
    const vertex = await gemini({ model: VERTEX_US, webTools: "search" });
    const read = async (h: Awaited<ReturnType<typeof gemini>>) =>
      (await h.ledger.findSessionByCapabilityHash(capabilityHash(h.session.capability)))!;
    expect((await read(studio)).webTools).toBe("off");
    expect((await read(vertex)).webTools).toBe("search");
    expect((await read(vertex)).protocol).toBe("gemini-generate-content");
  });

  it("refuses a Gemini session without terms, with a non-Gemini entry, or with the wrong credential kind", async () => {
    const proxy = new CodingProxy({ ledger: new MemoryProxyLedger(), credentials: { resolve: async () => "x" } });
    const base = {
      runId: "r",
      protocol: "gemini-generate-content" as const,
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
    };
    const studio = entryOf(shippedCatalog().require(STUDIO));
    const vertex = entryOf(shippedCatalog().require(VERTEX_US));
    const sonnet = entryOf(shippedCatalog().require("claude-sonnet-5"));
    await expect(
      proxy.createSession({ ...base, credentialRef: "env:GEMINI_API_KEY", allowedModels: [STUDIO] }),
    ).rejects.toThrow("invalid_proxy_model_terms");
    await expect(
      proxy.createSession({
        ...base,
        credentialRef: "env:GEMINI_API_KEY",
        allowedModels: ["claude-sonnet-5"],
        terms: { version: "v", entry: sonnet },
      }),
    ).rejects.toThrow("invalid_proxy_model_terms");
    await expect(
      proxy.createSession({
        ...base,
        credentialRef: VERTEX_CREDENTIAL_REF,
        allowedModels: [STUDIO],
        terms: { version: "v", entry: studio },
      }),
    ).rejects.toThrow("invalid_proxy_credential_reference");
    await expect(
      proxy.createSession({
        ...base,
        credentialRef: "env:GEMINI_API_KEY",
        allowedModels: [VERTEX_US],
        terms: { version: "v", entry: vertex },
      }),
    ).rejects.toThrow("invalid_proxy_credential_reference");
  });

  it("refuses an unknown web-tool policy, and any policy but off on another protocol", async () => {
    const proxy = new CodingProxy({
      ledger: new MemoryProxyLedger(),
      credentials: { resolve: async () => "x" },
      pricing: () => ({ encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 }),
    });
    const entry = entryOf(shippedCatalog().require(STUDIO));
    await expect(
      proxy.createSession({
        runId: "a",
        credentialRef: "env:GEMINI_API_KEY",
        protocol: "gemini-generate-content",
        allowedModels: [STUDIO],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        terms: { version: "v", entry },
        webTools: "everything" as never,
      }),
    ).rejects.toThrow("invalid_proxy_web_tools");
    await expect(
      proxy.createSession({
        runId: "b",
        credentialRef: "openai/a",
        protocol: "openai-responses",
        allowedModels: ["test-model"],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        webTools: "search",
      }),
    ).rejects.toThrow("invalid_proxy_web_tools");
  });
});
