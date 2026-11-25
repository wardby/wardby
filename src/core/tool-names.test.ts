import { describe, expect, it } from "vitest";
import {
  CODEX_NATIVE_TOOLS_MESSAGE,
  codingAgentAttachProblem,
  NATIVE_TOOL_DESCRIPTION_MAX_CHARS,
  nativeToolDescriptionMessage,
  nativeToolNameMessage,
  duplicateToolNames,
  findSameNamedAttachedTool,
  findSameNamedMcpTool,
  reservedToolNameReason,
  resolveToolRef,
  type ToolLookupDb,
} from "./tool-names.js";

describe("reservedToolNameReason", () => {
  it("rejects every name a built-in shadows at dispatch", () => {
    for (const name of ["memory_get", "memory_set", "subagent_memory_get", "parent_memory_get", "delegate_to_x"]) {
      expect(reservedToolNameReason(name), name).toMatch(/reserved/);
    }
  });

  it("reserves the doc_ prefix, not docs_", () => {
    expect(reservedToolNameReason("doc_get")).toMatch(/reserved/);
    expect(reservedToolNameReason("docs_get")).toBeUndefined();
  });

  it("rejects the jira_* issue-tracker built-in names", () => {
    for (const name of [
      "jira_get_issue",
      "jira_search",
      "jira_comment",
      "jira_edit_own_comment",
      "jira_list_transitions",
      "jira_transition",
      "jira_update_fields",
      "jira_link_issues",
      "jira_get_property",
      "jira_set_property",
    ]) {
      expect(reservedToolNameReason(name), name).toMatch(/reserved for the built-in Jira tools/);
    }
  });

  it("allows an ordinary name, including one merely containing a reserved word", () => {
    for (const name of ["greet", "my_memory_get", "not_delegate_to_x", "jira_other"]) {
      expect(reservedToolNameReason(name), name).toBeUndefined();
    }
  });
});

describe("duplicateToolNames", () => {
  it("returns each repeated name once, in first-seen order", () => {
    expect(duplicateToolNames(["a", "b", "a", "c", "b", "a"])).toEqual(["a", "b"]);
    expect(duplicateToolNames(["a", "b"])).toEqual([]);
  });
});

interface Row {
  id: string;
  name: string;
  ownerId: string | null;
}

function lookupDb(tools: Row[], attachments: { agentId: string; toolId: string }[] = []): ToolLookupDb {
  return {
    tool: {
      findUnique: async ({ where }: { where: { id: string } }) => tools.find((t) => t.id === where.id) ?? null,
      findMany: async ({ where }: { where: { name: string } }) => tools.filter((t) => t.name === where.name),
    },
    agentTool: {
      findFirst: async ({ where }: { where: { agentId: string; toolId: { not: string }; tool: { name: string } } }) => {
        const hit = attachments.find(
          (a) =>
            a.agentId === where.agentId &&
            a.toolId !== where.toolId.not &&
            tools.find((t) => t.id === a.toolId)?.name === where.tool.name,
        );
        return hit ? { tool: tools.find((t) => t.id === hit.toolId)! } : null;
      },
    },
  } as unknown as ToolLookupDb;
}

describe("resolveToolRef", () => {
  it("accepts an id first, then a unique name", async () => {
    const db = lookupDb([
      { id: "t1", name: "greet", ownerId: null },
      { id: "t2", name: "other", ownerId: "p1" },
    ]);
    expect(await resolveToolRef(db, "t2")).toMatchObject({ ok: true, tool: { id: "t2" } });
    expect(await resolveToolRef(db, "greet")).toMatchObject({ ok: true, tool: { id: "t1" } });
  });

  it("reports an unknown tool", async () => {
    expect(await resolveToolRef(lookupDb([]), "nope")).toEqual({ ok: false, error: 'unknown tool "nope".' });
  });

  it("reports an ambiguous name with the candidate ids instead of guessing", async () => {
    const db = lookupDb([
      { id: "t1", name: "greet", ownerId: null },
      { id: "t2", name: "greet", ownerId: "p1" },
    ]);
    const result = await resolveToolRef(db, "greet");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('ambiguous: 2 tools named "greet"; pass the tool id');
    expect(result.error).toContain("t1");
    expect(result.error).toContain("t2");
  });
});

describe("findSameNamedAttachedTool", () => {
  it("finds a different same-named tool already on the agent, ignoring the tool itself", async () => {
    const tools = [
      { id: "t1", name: "greet", ownerId: null },
      { id: "t2", name: "greet", ownerId: "p1" },
    ];
    const db = lookupDb(tools, [{ agentId: "a1", toolId: "t1" }]);
    expect(await findSameNamedAttachedTool(db, "a1", tools[1])).toMatchObject({ id: "t1" });
    expect(await findSameNamedAttachedTool(db, "a1", tools[0])).toBeNull();
    expect(await findSameNamedAttachedTool(db, "a2", tools[1])).toBeNull();
  });
});

describe("findSameNamedMcpTool", () => {
  const rows = [{ agentId: "a1", allowedTools: ["search", "get.logs"], server: { id: "s1", name: "datadog" } }];
  const db = {
    agentMcpServer: {
      findMany: async ({ where }: { where: { agentId: string } }) => rows.filter((r) => r.agentId === where.agentId),
    },
  } as unknown as Parameters<typeof findSameNamedMcpTool>[0];

  it("finds an MCP attachment that exposes the name, after mapping", async () => {
    expect(await findSameNamedMcpTool(db, "a1", "datadog__search")).toEqual({ serverId: "s1", serverName: "datadog" });
    expect(await findSameNamedMcpTool(db, "a1", "datadog__get_logs")).toEqual({
      serverId: "s1",
      serverName: "datadog",
    });
  });

  it("finds nothing for another agent, an unallowed tool, or a name without the separator", async () => {
    expect(await findSameNamedMcpTool(db, "a2", "datadog__search")).toBeNull();
    expect(await findSameNamedMcpTool(db, "a1", "datadog__other")).toBeNull();
    expect(await findSameNamedMcpTool(db, "a1", "search")).toBeNull();
  });
});

describe("codingAgentAttachProblem (every attach path: attach_tool, wardby tool attach, the importer)", () => {
  const fakeDb = (agent: { kind: string; codingProfile: { provider: string } | null } | null) =>
    ({ agent: { findUnique: async () => agent } }) as unknown as Parameters<typeof codingAgentAttachProblem>[0];
  const tool = { name: "code_search", description: "Searches code." };

  it("has nothing to say about a native agent, or an agent that doesn't exist", async () => {
    expect(await codingAgentAttachProblem(fakeDb({ kind: "native", codingProfile: null }), "a1", tool)).toBeUndefined();
    expect(await codingAgentAttachProblem(fakeDb(null), "a1", tool)).toBeUndefined();
  });

  it("refuses a Codex coding agent, and a coding agent with no profile", async () => {
    for (const codingProfile of [{ provider: "codex" }, null]) {
      expect(await codingAgentAttachProblem(fakeDb({ kind: "coding", codingProfile }), "a1", tool)).toBe(
        CODEX_NATIVE_TOOLS_MESSAGE,
      );
    }
  });

  it("takes a tool a Claude Code agent's runs can be offered, and refuses a bad name or an over-long description", async () => {
    const claude = fakeDb({ kind: "coding", codingProfile: { provider: "claude-code" } });
    expect(await codingAgentAttachProblem(claude, "a1", tool)).toBeUndefined();
    expect(await codingAgentAttachProblem(claude, "a1", { ...tool, name: "code search" })).toBe(
      nativeToolNameMessage("code search"),
    );
    expect(await codingAgentAttachProblem(claude, "a1", { ...tool, name: "x".repeat(65) })).toBe(
      nativeToolNameMessage("x".repeat(65)),
    );
    const long = { ...tool, description: "x".repeat(NATIVE_TOOL_DESCRIPTION_MAX_CHARS + 1) };
    expect(await codingAgentAttachProblem(claude, "a1", long)).toBe(nativeToolDescriptionMessage("code_search"));
    expect(
      await codingAgentAttachProblem(claude, "a1", {
        ...tool,
        description: "x".repeat(NATIVE_TOOL_DESCRIPTION_MAX_CHARS),
      }),
    ).toBeUndefined();
  });
});
