import { describe, expect, it } from "vitest";
import type { AgentMemoryStore, AgentMemorySearchHit } from "../providers/memory/types.js";
import { MEMORY_TOOL_DEFS, MEMORY_TOOL_NAMES, handleMemoryTool } from "./memory-tools.js";

function fakeMemory(): AgentMemoryStore & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(agentId, key) {
      return store.get(`${agentId}:${key}`);
    },
    async set(agentId, key, content) {
      if (content === "TOO_BIG") throw new Error("memory_content_limit");
      store.set(`${agentId}:${key}`, content);
    },
    async list(agentId) {
      const p = `${agentId}:`;
      return [...store.keys()]
        .filter((k) => k.startsWith(p))
        .map((k) => k.slice(p.length))
        .sort();
    },
    async search(agentId, query): Promise<AgentMemorySearchHit[]> {
      const p = `${agentId}:`;
      return [...store.entries()]
        .filter(([k, content]) => k.startsWith(p) && content.includes(query))
        .map(([k, content]) => ({ key: k.slice(p.length), content, rank: 1 }));
    },
    async delete(agentId, key) {
      store.delete(`${agentId}:${key}`);
    },
  };
}

describe("MEMORY_TOOL_DEFS / MEMORY_TOOL_NAMES", () => {
  it("declares exactly the four built-in tool names, matching the defs", () => {
    expect(MEMORY_TOOL_NAMES).toEqual(new Set(["memory_get", "memory_set", "memory_list", "memory_search"]));
    expect(MEMORY_TOOL_DEFS.map((d) => d.name).sort()).toEqual([...MEMORY_TOOL_NAMES].sort());
  });
});

describe("handleMemoryTool", () => {
  it("memory_set then memory_get round-trips", async () => {
    const memory = fakeMemory();
    const setResult = await handleMemoryTool("memory_set", JSON.stringify({ key: "k", content: "v" }), "a1", memory);
    expect(JSON.parse(setResult)).toEqual({ ok: true });

    const getResult = await handleMemoryTool("memory_get", JSON.stringify({ key: "k" }), "a1", memory);
    expect(JSON.parse(getResult)).toEqual({ content: "v" });
  });

  it("memory_get returns null content for a missing key rather than erroring", async () => {
    const result = await handleMemoryTool("memory_get", JSON.stringify({ key: "missing" }), "a1", fakeMemory());
    expect(JSON.parse(result)).toEqual({ content: null });
  });

  it("memory_list returns stored keys", async () => {
    const memory = fakeMemory();
    await handleMemoryTool("memory_set", JSON.stringify({ key: "a", content: "1" }), "a1", memory);
    await handleMemoryTool("memory_set", JSON.stringify({ key: "b", content: "2" }), "a1", memory);

    const result = await handleMemoryTool("memory_list", "{}", "a1", memory);
    expect(JSON.parse(result)).toEqual({ keys: ["a", "b"] });
  });

  it("memory_search returns matching hits", async () => {
    const memory = fakeMemory();
    await handleMemoryTool("memory_set", JSON.stringify({ key: "a", content: "dark mode" }), "a1", memory);

    const result = await handleMemoryTool("memory_search", JSON.stringify({ query: "dark" }), "a1", memory);
    expect(JSON.parse(result)).toEqual({ hits: [{ key: "a", content: "dark mode", rank: 1 }] });
  });

  it("scopes every call to the given agentId — one agent never sees another's memory", async () => {
    const memory = fakeMemory();
    await handleMemoryTool("memory_set", JSON.stringify({ key: "k", content: "a1-secret" }), "a1", memory);

    const result = await handleMemoryTool("memory_get", JSON.stringify({ key: "k" }), "a2", memory);
    expect(JSON.parse(result)).toEqual({ content: null });
  });

  it("treats an empty argsJson as {} rather than failing to parse", async () => {
    const result = await handleMemoryTool("memory_list", "", "a1", fakeMemory());
    expect(JSON.parse(result)).toEqual({ keys: [] });
  });

  it("returns invalid_arguments_json for malformed JSON rather than throwing", async () => {
    const result = await handleMemoryTool("memory_get", "{not json", "a1", fakeMemory());
    expect(JSON.parse(result)).toMatchObject({ error: "invalid_arguments_json" });
  });

  it("returns validation_failed for args that don't match the tool's schema", async () => {
    const result = await handleMemoryTool("memory_get", JSON.stringify({ wrong: "field" }), "a1", fakeMemory());
    expect(JSON.parse(result)).toMatchObject({ error: "validation_failed" });
  });

  it("returns unknown_tool for a name outside the memory tool set", async () => {
    const result = await handleMemoryTool("memory_delete", "{}", "a1", fakeMemory());
    expect(JSON.parse(result)).toMatchObject({ error: "unknown_tool" });
  });

  it("maps a provider error into a friendly {error, message} result rather than throwing", async () => {
    const memory = fakeMemory();
    const result = await handleMemoryTool("memory_set", JSON.stringify({ key: "k", content: "TOO_BIG" }), "a1", memory);
    expect(JSON.parse(result)).toMatchObject({ error: "memory_content_limit" });
  });
});
