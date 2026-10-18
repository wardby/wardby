import { describe, it, expect } from "vitest";
import {
  secretNamesIn,
  secretInValueMessage,
  maskNamedSecrets,
  SecretInValueError,
  SECRET_CHECK_UNAVAILABLE_MESSAGE,
  createSecretWriteGuard,
} from "./secret-guard.js";

const API = { name: "API_KEY", values: ["fake-secret-value-1234"] };
const DB = { name: "DB_PASSWORD", values: ["fake-db-pass-5678"] };

describe("secret guard", () => {
  it("finds a secret in a plain string", () => {
    expect(secretNamesIn("token=fake-secret-value-1234", [API, DB])).toEqual(["API_KEY"]);
  });
  it("finds a secret inside a JSON value, including escaped forms", () => {
    expect(secretNamesIn({ a: { b: ["x fake-secret-value-1234 y"] } }, [API])).toEqual(["API_KEY"]);
    const quoted = { name: "Q", values: ['fake"quoted"secret', 'fake\\"quoted\\"secret'] };
    expect(secretNamesIn({ s: 'fake"quoted"secret' }, [quoted])).toEqual(["Q"]);
  });
  it("returns every matching name, sorted and unique", () => {
    expect(secretNamesIn(["fake-db-pass-5678", "fake-secret-value-1234", "fake-db-pass-5678"], [DB, API])).toEqual([
      "API_KEY",
      "DB_PASSWORD",
    ]);
  });
  it("skips values shorter than the minimum and clean values", () => {
    expect(secretNamesIn("abc and more", [{ name: "SHORT", values: ["abc"] }])).toEqual([]);
    expect(secretNamesIn("nothing here", [API])).toEqual([]);
  });
  it("the refusal message names the secret, never the value", () => {
    const m = secretInValueMessage(["API_KEY"]);
    expect(m).toMatch(/^secret_in_value: not stored\./);
    expect(m).toMatch(/secret "API_KEY" attached to this agent/);
    expect(m).toMatch(/secrets\.get\("API_KEY"\)/);
    expect(m).not.toContain("fake-secret-value-1234");
    expect(secretInValueMessage(["A_ONE", "B_TWO"])).toMatch(/secrets "A_ONE", "B_TWO" attached/);
    const long = secretInValueMessage(Array.from({ length: 200 }, (_, i) => `SECRET_NAME_${i}`));
    expect(long.length).toBeLessThanOrEqual(1000);
    expect(long).toMatch(/, and \d+ more attached/);
  });
  it("SecretInValueError carries the code, names and message", () => {
    const e = new SecretInValueError(["API_KEY"]);
    expect(e.code).toBe("secret_in_value");
    expect(e.secretNames).toEqual(["API_KEY"]);
    expect(e.message).toBe(secretInValueMessage(["API_KEY"]));
  });
  it("masks every value of every named secret", () => {
    expect(maskNamedSecrets("a fake-secret-value-1234 b fake-db-pass-5678", [API, DB])).toBe(
      "a [REDACTED] b [REDACTED]",
    );
  });
  it("guard refuses with secret_check_unavailable when secrets cannot be read", async () => {
    const guard = createSecretWriteGuard({
      load: async () => {
        throw new Error("db down");
      },
    });
    await expect(guard.assertNoSecrets("agent-1", "x")).rejects.toMatchObject({
      code: "secret_check_unavailable",
      message: SECRET_CHECK_UNAVAILABLE_MESSAGE,
    });
  });
  it("guard passes clean values and refuses secret ones", async () => {
    const guard = createSecretWriteGuard({ load: async () => [API] });
    await guard.assertNoSecrets("agent-1", { ok: "clean" });
    await expect(guard.assertNoSecrets("agent-1", "fake-secret-value-1234")).rejects.toBeInstanceOf(SecretInValueError);
  });
});
