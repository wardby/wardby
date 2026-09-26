import { describe, expect, it } from "vitest";
import { Prisma } from "#prisma";
import {
  ToolAttachedError,
  deleteToolGuarded,
  formatAttachedAgents,
  formatToolLine,
  hasToolChanges,
  prepareToolUpdate,
  updateToolGuarded,
  type AuthorizeTool,
} from "./tool-admin.js";

interface Row {
  id: string;
  ownerId: string | null;
  code: string;
}

function fakeDb(tool: Row | null, agents: { id: string; name: string; ownerId: string | null }[]) {
  let current = tool;
  let attachments = agents.map((agent) => ({ toolId: tool?.id ?? "", agent }));
  const isolationLevels: unknown[] = [];
  const tx = {
    tool: {
      findUnique: async () => current,
      update: async ({ data }: { data: Partial<Row> }) => (current = { ...current!, ...data }),
      delete: async () => {
        if (attachments.length > 0) {
          throw new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "test" });
        }
        const deleted = current;
        current = null;
        return deleted;
      },
    },
    agentTool: {
      findMany: async () => attachments.map((a) => ({ agent: a.agent })),
      deleteMany: async ({ where }: { where: { agentId: { in: string[] } } }) => {
        attachments = attachments.filter((a) => !where.agentId.in.includes(a.agent.id));
        return { count: 0 };
      },
    },
  };
  const db = {
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>, options?: { isolationLevel?: unknown }) => {
      isolationLevels.push(options?.isolationLevel);
      return fn(tx);
    },
  };
  return {
    db: db as unknown as Pick<import("#prisma").PrismaClient, "$transaction">,
    isolationLevels,
    tool: () => current,
    attachments: () => attachments.map((a) => a.agent.id),
    hideAttachments: () => {
      tx.agentTool.findMany = async () => [];
    },
  };
}

const allow: AuthorizeTool = (tool) => {
  if (!tool) throw new Error("unknown tool");
};

async function rejection(promise: Promise<unknown>): Promise<ToolAttachedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ToolAttachedError);
  return err as ToolAttachedError;
}

describe("prepareToolUpdate / hasToolChanges", () => {
  it("needs at least one field", () => {
    expect(hasToolChanges({})).toBe(false);
    expect(hasToolChanges({ code: "" })).toBe(true);
  });

  it("re-derives jsonSchema with paramsZod, and reports an invalid one instead of throwing", async () => {
    const good = await prepareToolUpdate({ paramsZod: "z.object({ who: z.string() })", code: "return 1;" });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.data.code).toBe("return 1;");
      expect(JSON.stringify(good.data.jsonSchema)).toContain("who");
    }
    const bad = await prepareToolUpdate({ paramsZod: "not valid zod {{{" });
    expect(bad.ok).toBe(false);
  });
});

describe("updateToolGuarded", () => {
  it("updates in a Serializable transaction when every attached agent shares the tool's owner", async () => {
    const fake = fakeDb({ id: "t1", ownerId: "p1", code: "old" }, [{ id: "a1", name: "mine", ownerId: "p1" }]);
    await updateToolGuarded(fake.db, "t1", { code: "new" }, allow);
    expect(fake.tool()?.code).toBe("new");
    expect(fake.isolationLevels).toEqual([Prisma.TransactionIsolationLevel.Serializable]);
  });

  it("refuses when an agent of another owner (a public one included) holds an owned tool", async () => {
    const fake = fakeDb({ id: "t1", ownerId: "p1", code: "old" }, [
      { id: "a1", name: "mine", ownerId: "p1" },
      { id: "a2", name: "shared", ownerId: null },
    ]);
    const err = await rejection(updateToolGuarded(fake.db, "t1", { code: "new" }, allow));
    expect(err.reason).toBe("other_owners");
    expect(err.agents.map((a) => a.id)).toEqual(["a2"]);
    expect(fake.tool()?.code).toBe("old");
  });

  it("judges a public tool against public agents: an owned agent blocks, a public one doesn't", async () => {
    const onPublic = fakeDb({ id: "t1", ownerId: null, code: "old" }, [{ id: "a1", name: "shared", ownerId: null }]);
    await updateToolGuarded(onPublic.db, "t1", { code: "new" }, allow);
    expect(onPublic.tool()?.code).toBe("new");

    const onOwned = fakeDb({ id: "t1", ownerId: null, code: "old" }, [{ id: "a1", name: "theirs", ownerId: "p2" }]);
    expect((await rejection(updateToolGuarded(onOwned.db, "t1", { code: "new" }, allow))).reason).toBe("other_owners");
    expect(onOwned.tool()?.code).toBe("old");
  });

  it("lets the caller's authorize refuse before anything is read or written", async () => {
    const fake = fakeDb({ id: "t1", ownerId: "p1", code: "old" }, []);
    await expect(
      updateToolGuarded(fake.db, "t1", { code: "new" }, () => {
        throw new Error("denied");
      }),
    ).rejects.toThrow("denied");
    expect(fake.tool()?.code).toBe("old");
  });
});

describe("deleteToolGuarded", () => {
  it("deletes an unattached tool in a Serializable transaction", async () => {
    const fake = fakeDb({ id: "t1", ownerId: "p1", code: "" }, []);
    await expect(deleteToolGuarded(fake.db, "t1", { detach: false, authorize: allow })).resolves.toEqual([]);
    expect(fake.tool()).toBeNull();
    expect(fake.isolationLevels).toEqual([Prisma.TransactionIsolationLevel.Serializable]);
  });

  it("needs detach for the owner's own agents, then detaches only those", async () => {
    const fake = fakeDb({ id: "t1", ownerId: "p1", code: "" }, [{ id: "a1", name: "mine", ownerId: "p1" }]);
    expect((await rejection(deleteToolGuarded(fake.db, "t1", { detach: false, authorize: allow }))).reason).toBe(
      "needs_detach",
    );
    expect(fake.tool()).not.toBeNull();
    await expect(deleteToolGuarded(fake.db, "t1", { detach: true, authorize: allow })).resolves.toEqual(["a1"]);
    expect(fake.tool()).toBeNull();
  });

  it("never detaches another owner's agent, and then detaches nothing at all", async () => {
    const fake = fakeDb({ id: "t1", ownerId: "p1", code: "" }, [
      { id: "a1", name: "mine", ownerId: "p1" },
      { id: "a2", name: "shared", ownerId: null },
    ]);
    const err = await rejection(deleteToolGuarded(fake.db, "t1", { detach: true, authorize: allow }));
    expect(err.reason).toBe("other_owners");
    expect(fake.attachments()).toEqual(["a1", "a2"]);
    expect(fake.tool()).not.toBeNull();
  });

  it("lets the operator detach a public tool from public agents", async () => {
    const fake = fakeDb({ id: "t1", ownerId: null, code: "" }, [{ id: "a1", name: "shared", ownerId: null }]);
    await expect(deleteToolGuarded(fake.db, "t1", { detach: true, authorize: allow })).resolves.toEqual(["a1"]);
  });

  it("turns the RESTRICT foreign key's P2003 (an attachment the check missed) into a race refusal", async () => {
    const fake = fakeDb({ id: "t1", ownerId: "p1", code: "" }, [{ id: "a1", name: "mine", ownerId: "p1" }]);
    fake.hideAttachments();
    expect((await rejection(deleteToolGuarded(fake.db, "t1", { detach: false, authorize: allow }))).reason).toBe(
      "race",
    );
    expect(fake.tool()).not.toBeNull();
  });
});

describe("operator formatting", () => {
  it("lists a tool with its id and owner, or 'public'", () => {
    expect(formatToolLine({ id: "t1", name: "greet", description: "says hi", ownerId: null })).toBe(
      "t1  greet  owner:public  says hi",
    );
    expect(formatToolLine({ id: "t2", name: "greet", description: "d", ownerId: "p1" })).toBe("t2  greet  owner:p1  d");
  });

  it("names every attached agent with its id and owner (the operator may see all of them)", () => {
    expect(
      formatAttachedAgents([
        { id: "a1", name: "mine", ownerId: "p1" },
        { id: "a2", name: "shared", ownerId: null },
      ]),
    ).toBe('"mine" (a1, owner p1), "shared" (a2, public)');
  });
});
