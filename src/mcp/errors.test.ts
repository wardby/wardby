import { describe, expect, it } from "vitest";
import { Prisma } from "#prisma";
import { McpError, mapPrismaError } from "./errors.js";

function knownError(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Invalid `prisma.tool.create()` invocation: raw detail", {
    code,
    clientVersion: "test",
    meta,
  });
}

describe("mapPrismaError", () => {
  it("maps P2002 to a 409 naming the model and the fields from the adapter's index name", () => {
    const mapped = mapPrismaError(
      knownError("P2002", {
        modelName: "Agent",
        driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { index: "Agent_name_key" } } },
      }),
    );
    expect(mapped).toBeInstanceOf(McpError);
    expect((mapped as McpError).httpStatus).toBe(409);
    expect((mapped as McpError).message).toBe("An agent with that name already exists.");
  });

  it("names a per-owner unique without exposing ownerId as a field", () => {
    const mapped = mapPrismaError(
      knownError("P2002", {
        modelName: "BudgetGroup",
        driverAdapterError: {
          cause: { kind: "UniqueConstraintViolation", constraint: { index: "BudgetGroup_ownerId_name_key" } },
        },
      }),
    ) as McpError;
    expect(mapped.message).toBe("A budget group with that name already exists for this owner.");
  });

  it("uses constraint fields or a classic target when the adapter reports them", () => {
    const fromFields = mapPrismaError(
      knownError("P2002", {
        modelName: "Tool",
        driverAdapterError: { cause: { constraint: { fields: ["name"] } } },
      }),
    ) as McpError;
    expect(fromFields.message).toBe("A tool with that name already exists.");
    const fromTarget = mapPrismaError(knownError("P2002", { modelName: "Tool", target: ["name"] })) as McpError;
    expect(fromTarget.message).toBe("A tool with that name already exists.");
  });

  it("falls back to a generic 409 when no model or fields are known", () => {
    const mapped = mapPrismaError(knownError("P2002")) as McpError;
    expect(mapped.httpStatus).toBe(409);
    expect(mapped.message).toBe("A record with those values already exists.");
    expect(mapped.message).not.toContain("prisma");
  });

  it("maps P2003 to a neutral 409 covering both directions of a foreign-key failure", () => {
    // P2003 is a delete blocked by a reference *or* an insert/update pointing
    // at a row that no longer exists (attach_tool racing delete_tool).
    const mapped = mapPrismaError(knownError("P2003", { modelName: "AgentTool" })) as McpError;
    expect(mapped).toBeInstanceOf(McpError);
    expect(mapped.httpStatus).toBe(409);
    expect(mapped.message).toBe(
      "The agent tool conflicts with a related record: it is still referenced by another record, or refers to one that no longer exists.",
    );
  });

  it("maps a serialization failure (P2034) to a 409 asking the client to retry", () => {
    const mapped = mapPrismaError(knownError("P2034")) as McpError;
    expect(mapped).toBeInstanceOf(McpError);
    expect(mapped.httpStatus).toBe(409);
    expect(mapped.message).toBe("A concurrent change conflicted with this one; retry the request.");
  });

  it("maps a serialization failure raised at COMMIT (an unwrapped driver adapter error) the same way", () => {
    const atCommit = Object.assign(new Error("could not serialize access"), {
      name: "DriverAdapterError",
      cause: { originalCode: "40001" },
    });
    expect((mapPrismaError(atCommit) as McpError).httpStatus).toBe(409);
    const other = Object.assign(new Error("connection reset"), {
      name: "DriverAdapterError",
      cause: { originalCode: "08006" },
    });
    expect((mapPrismaError(other) as McpError).httpStatus).toBe(500);
  });

  it("turns every other Prisma error into a generic 500 without the invocation text", () => {
    const errors: unknown[] = [
      knownError("P2025"),
      new Prisma.PrismaClientValidationError("Invalid `prisma.tool.update()` invocation in /srv/app/src/x.ts:12", {
        clientVersion: "test",
      }),
      new Prisma.PrismaClientUnknownRequestError("Invalid `tx.tool.update()` invocation in /srv/app/src/y.ts:3", {
        clientVersion: "test",
      }),
    ];
    for (const err of errors) {
      const mapped = mapPrismaError(err) as McpError;
      expect(mapped).toBeInstanceOf(McpError);
      expect(mapped.httpStatus).toBe(500);
      expect(mapped.message).toMatch(/^Internal database error \(reference: [0-9a-f-]{36}\)\.$/);
      expect(mapped.message).not.toContain("prisma");
      expect(mapped.message).not.toContain("/srv/app");
    }
  });

  it("returns non-Prisma errors, McpErrors included, unchanged", () => {
    const plain = new Error("boom");
    expect(mapPrismaError(plain)).toBe(plain);
    const mcp = new McpError(404, "nope");
    expect(mapPrismaError(mcp)).toBe(mcp);
  });
});
