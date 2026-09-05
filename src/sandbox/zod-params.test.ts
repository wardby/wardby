import { describe, expect, it } from "vitest";
import { deriveJsonSchema, validateParams } from "./zod-params.js";

const CITY_DAYS_SCHEMA = "z.object({ city: z.string(), days: z.number().max(10) })";

describe("deriveJsonSchema", () => {
  it("derives JSON Schema matching the Zod shape", async () => {
    const result = await deriveJsonSchema(CITY_DAYS_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const schema = result.value as any;
      expect(schema.type).toBe("object");
      expect(schema.properties.city).toEqual({ type: "string" });
      expect(schema.properties.days).toEqual({ type: "number", maximum: 10 });
      expect(schema.required).toEqual(["city", "days"]);
    }
  });

  it("fails at registration (not later) for malformed schema source", async () => {
    const result = await deriveJsonSchema("this is not valid javascript {{{");
    expect(result.ok).toBe(false);
  });

  it("fails for source that doesn't produce a Zod schema", async () => {
    const result = await deriveJsonSchema("{ notASchema: true }");
    expect(result.ok).toBe(false);
  });
});

describe("validateParams", () => {
  it("passes through a valid argument set", async () => {
    const result = await validateParams(CITY_DAYS_SCHEMA, { city: "Boston", days: 3 });
    expect(result).toEqual({ ok: true, value: { city: "Boston", days: 3 } });
  });

  it("produces a validation error result for invalid args, not a crash", async () => {
    const result = await validateParams(CITY_DAYS_SCHEMA, { city: "Boston", days: 30 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("thrown");
      expect(result.errorMessage).toMatch(/days/);
    }
  });

  it("rejects missing required fields", async () => {
    const result = await validateParams(CITY_DAYS_SCHEMA, { city: "Boston" });
    expect(result.ok).toBe(false);
  });

  it("rejects extra unrecognized args passed as the wrong type", async () => {
    const result = await validateParams(CITY_DAYS_SCHEMA, { city: 42, days: 3 });
    expect(result.ok).toBe(false);
  });
});
