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

  it("maps P2003 to a 409 'still referenced' error", () => {
    const mapped = mapPrismaError(knownError("P2003", { modelName: "Tool" })) as McpError;
    expect(mapped).toBeInstanceOf(McpError);
    expect(mapped.httpStatus).toBe(409);
    expect(mapped.message).toBe("The tool is still referenced by other records.");
  });

  it("returns every other error unchanged", () => {
    const other = knownError("P2025");
    expect(mapPrismaError(other)).toBe(other);
    const plain = new Error("boom");
    expect(mapPrismaError(plain)).toBe(plain);
    const mcp = new McpError(404, "nope");
    expect(mapPrismaError(mcp)).toBe(mcp);
  });
});
