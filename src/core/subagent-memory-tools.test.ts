import { describe, expect, it } from "vitest";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import {
  PARENT_MEMORY_GET_TOOL,
  SUBAGENT_MEMORY_GET_TOOL,
  SUBAGENT_MEMORY_TOOL_NAMES,
  handleParentMemoryGet,
  handleSubAgentMemoryGet,
} from "./subagent-memory-tools.js";

function fakeMemory(): AgentMemoryStore {
  const store = new Map<string, string>();
  store.set("child-agent:secret-plan", "the plan");
  store.set("root-agent:api-notes", "call the v2 endpoint");
  return {
    async get(agentId, key) {
      return store.get(`${agentId}:${key}`);
    },
    async set() {},
    async list() {
      return [];
    },
    async search() {
      return [];
    },
    async delete() {},
  };
}

interface FakeEdge {
  parentAgentId: string;
  boundName: string;
  childAgentId: string;
}
interface FakeRun {
  id: string;
  agentId: string;
  parentRunId: string | null;
  grantedParentMemoryKeys: string[];
}

function fakeDb(edges: FakeEdge[], runs: FakeRun[], owners: Record<string, string | null> = {}) {
  const runsById = new Map(runs.map((r) => [r.id, r]));
  return {
    // Every agent is owned by "p1" unless a test says otherwise.
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        ownerId: where.id in owners ? owners[where.id] : "p1",
      }),
    },
    agentSubAgent: {
      findUnique: async ({
        where,
      }: {
        where: { parentAgentId_boundName: { parentAgentId: string; boundName: string } };
      }) => {
        const { parentAgentId, boundName } = where.parentAgentId_boundName;
        return edges.find((e) => e.parentAgentId === parentAgentId && e.boundName === boundName) ?? null;
      },
    },
    run: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const r = runsById.get(where.id);
        if (!r) throw new Error(`fakeDb: no run "${where.id}"`);
        return r;
      },
    },
  } as never;
}

describe("SUBAGENT_MEMORY_TOOL_NAMES / defs", () => {
  it("declares exactly the two tool names, matching the defs", () => {
    expect(SUBAGENT_MEMORY_TOOL_NAMES).toEqual(new Set(["subagent_memory_get", "parent_memory_get"]));
    expect(SUBAGENT_MEMORY_GET_TOOL.name).toBe("subagent_memory_get");
    expect(PARENT_MEMORY_GET_TOOL.name).toBe("parent_memory_get");
  });
});

describe("handleSubAgentMemoryGet", () => {
  it("N1: refuses a child owned by someone else (memory is owner-level)", async () => {
    const db = fakeDb([{ parentAgentId: "root-agent", boundName: "planner", childAgentId: "child-agent" }], [], {
      "child-agent": "p2",
    });
    const result = await handleSubAgentMemoryGet(
      JSON.stringify({ boundName: "planner", key: "secret-plan" }),
      "root-agent",
      db,
      fakeMemory(),
    );
    expect(JSON.parse(result)).toMatchObject({ error: "subagent_not_authorized" });
  });

  it("reads the bound child's memory when the AgentSubAgent edge exists", async () => {
    const db = fakeDb([{ parentAgentId: "root-agent", boundName: "planner", childAgentId: "child-agent" }], []);
    const result = await handleSubAgentMemoryGet(
      JSON.stringify({ boundName: "planner", key: "secret-plan" }),
      "root-agent",
      db,
      fakeMemory(),
    );
    expect(JSON.parse(result)).toEqual({ content: "the plan" });
  });

  it("fails closed with no_such_subagent when no edge exists under that boundName", async () => {
    const db = fakeDb([], []);
    const result = await handleSubAgentMemoryGet(
      JSON.stringify({ boundName: "nobody", key: "secret-plan" }),
      "root-agent",
      db,
      fakeMemory(),
    );
    expect(JSON.parse(result)).toMatchObject({ error: "no_such_subagent" });
  });

  it("a caller cannot read another parent's child by guessing its boundName", async () => {
    const db = fakeDb([{ parentAgentId: "other-parent", boundName: "planner", childAgentId: "child-agent" }], []);
    const result = await handleSubAgentMemoryGet(
      JSON.stringify({ boundName: "planner", key: "secret-plan" }),
      "root-agent",
      db,
      fakeMemory(),
    );
    expect(JSON.parse(result)).toMatchObject({ error: "no_such_subagent" });
  });

  it("returns invalid_arguments_json for malformed JSON", async () => {
    const result = await handleSubAgentMemoryGet("{not json", "root-agent", fakeDb([], []), fakeMemory());
    expect(JSON.parse(result)).toMatchObject({ error: "invalid_arguments_json" });
  });

  it("returns validation_failed when a required field is missing", async () => {
    const result = await handleSubAgentMemoryGet(
      JSON.stringify({ boundName: "planner" }),
      "root-agent",
      fakeDb([], []),
      fakeMemory(),
    );
    expect(JSON.parse(result)).toMatchObject({ error: "validation_failed" });
  });
});

describe("handleParentMemoryGet", () => {
  it("reads the parent's memory for a key granted to this exact run", async () => {
    const db = fakeDb(
      [],
      [
        { id: "run-child", agentId: "child-agent", parentRunId: "run-root", grantedParentMemoryKeys: ["api-notes"] },
        { id: "run-root", agentId: "root-agent", parentRunId: null, grantedParentMemoryKeys: [] },
      ],
    );
    const result = await handleParentMemoryGet(JSON.stringify({ key: "api-notes" }), "run-child", db, fakeMemory());
    expect(JSON.parse(result)).toEqual({ content: "call the v2 endpoint" });
  });

  it("fails closed with no_parent_run for a top-level run", async () => {
    const db = fakeDb([], [{ id: "run-root", agentId: "root-agent", parentRunId: null, grantedParentMemoryKeys: [] }]);
    const result = await handleParentMemoryGet(JSON.stringify({ key: "api-notes" }), "run-root", db, fakeMemory());
    expect(JSON.parse(result)).toMatchObject({ error: "no_parent_run" });
  });

  it("fails closed with key_not_granted for a key outside this run's ephemeral grant", async () => {
    const db = fakeDb(
      [],
      [
        { id: "run-child", agentId: "child-agent", parentRunId: "run-root", grantedParentMemoryKeys: ["other-key"] },
        { id: "run-root", agentId: "root-agent", parentRunId: null, grantedParentMemoryKeys: [] },
      ],
    );
    const result = await handleParentMemoryGet(JSON.stringify({ key: "api-notes" }), "run-child", db, fakeMemory());
    expect(JSON.parse(result)).toMatchObject({ error: "key_not_granted" });
  });

  it("a sibling run's grant does not leak to this run — the grant is per-run, never a standing allowlist", async () => {
    const db = fakeDb(
      [],
      [
        { id: "run-sibling", agentId: "child-agent", parentRunId: "run-root", grantedParentMemoryKeys: ["api-notes"] },
        { id: "run-child", agentId: "child-agent", parentRunId: "run-root", grantedParentMemoryKeys: [] },
        { id: "run-root", agentId: "root-agent", parentRunId: null, grantedParentMemoryKeys: [] },
      ],
    );
    const result = await handleParentMemoryGet(JSON.stringify({ key: "api-notes" }), "run-child", db, fakeMemory());
    expect(JSON.parse(result)).toMatchObject({ error: "key_not_granted" });
  });
});
