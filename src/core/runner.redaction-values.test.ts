import { describe, expect, it, vi } from "vitest";
import type { SecretsAccessor } from "./secrets.js";
import { readRedactionValues } from "./runner.js";

// Fake values only; assertions compare booleans.
const FAKE_A = "fake-redaction-value-0010";
const FAKE_REFRESH = "fake-redaction-refresh-0011";

describe("readRedactionValues", () => {
  it("rejects when any allowed secret's read fails, so the list is never silently partial", async () => {
    const accessor = {
      get: async (name: string) => {
        if (name === "a") return FAKE_A;
        throw new Error("read failed");
      },
    } as unknown as SecretsAccessor;
    const outcome = await readRedactionValues(accessor, ["a", "b"]).then(
      () => "resolved",
      () => "rejected",
    );
    expect(outcome).toBe("rejected");
  });

  it("returns every value when every read succeeds, and an empty list for no secrets", async () => {
    const accessor = { get: async (name: string) => (name === "a" ? FAKE_A : undefined) } as unknown as SecretsAccessor;
    expect((await readRedactionValues(accessor, ["a", "missing"])).includes(FAKE_A)).toBe(true);
    expect(await readRedactionValues(accessor, [])).toEqual([]);
  });

  it("rejects when a brokered secret's resolve fails", async () => {
    const accessor = {
      get: async () => undefined,
      resolve: async () => {
        throw new Error("resolve failed");
      },
    } as unknown as SecretsAccessor;
    const outcome = await readRedactionValues(accessor, ["a"]).then(
      () => "resolved",
      () => "rejected",
    );
    expect(outcome).toBe("rejected");
  });

  it("reads stored entries when the accessor has them, never resolve (an OAuth secret is not refreshed for a list)", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("secret_reauth_required");
    });
    const accessor = {
      get: async () => undefined,
      resolve,
      storedEntry: async (name: string) =>
        name === "a" ? { value: FAKE_A, broker: null, oauth: { redact: [FAKE_A, FAKE_REFRESH] } } : undefined,
    } as unknown as SecretsAccessor;
    const values = await readRedactionValues(accessor, ["a", "missing"]);
    expect(values.includes(FAKE_A)).toBe(true);
    expect(values.includes(FAKE_REFRESH)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });
});
