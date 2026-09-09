import { describe, it, expect } from "vitest";
import { supportedGlobalsFromPrelude, scanToolCode, SPEC_UNSUPPORTED_HOST_APIS } from "./tool-scan.js";

// Mirror the real prelude after Part A: fetch/datastore/parseHTML plus the two
// throwing email placeholders. npmLockUpdate is absent — as in the real build.
const FAKE_PRELUDE = `
  globalThis.fetch = async (u) => __bridge_fetch(u);
  globalThis.datastore = { get() {} };
  globalThis.parseHTML = (h) => __bridge_parseHTML(h);
  globalThis.sendEmail = __unimplemented("sendEmail");
  globalThis.getInboundEmail = __unimplemented("getInboundEmail");
`;

describe("tool-scan", () => {
  const supported = supportedGlobalsFromPrelude(FAKE_PRELUDE);

  it("extracts globalThis names from the prelude, including the placeholders", () => {
    expect(supported.has("fetch")).toBe(true);
    expect(supported.has("datastore")).toBe(true);
    expect(supported.has("sendEmail")).toBe(true);
    expect(supported.has("getInboundEmail")).toBe(true);
    expect(supported.has("npmLockUpdate")).toBe(false);
  });

  it("accepts a tool that only uses supported APIs", () => {
    expect(scanToolCode("const r = await fetch('https://x'); await datastore.get('k');", supported).ok).toBe(true);
  });

  it("accepts a tool that calls sendEmail — a throwing placeholder, imported faithfully", () => {
    expect(scanToolCode("await sendEmail({ to: 'x' });", supported).ok).toBe(true);
  });

  it("accepts a tool that calls getInboundEmail", () => {
    expect(scanToolCode("const m = getInboundEmail();", supported).ok).toBe(true);
  });

  it("rejects a tool that calls npmLockUpdate (roadmap-excluded, not in the sandbox)", () => {
    const r = scanToolCode("await npmLockUpdate();", supported);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejectedApis).toEqual(["npmLockUpdate"]);
  });

  it("does not reject a substring match (npmLockUpdateHelper is not npmLockUpdate)", () => {
    expect(scanToolCode("const npmLockUpdateHelper = 1;", supported).ok).toBe(true);
  });

  it("stops rejecting an API once the prelude supports it", () => {
    const withNpm = supportedGlobalsFromPrelude(FAKE_PRELUDE + "\nglobalThis.npmLockUpdate = () => {};");
    expect(scanToolCode("await npmLockUpdate({});", withNpm).ok).toBe(true);
  });

  it("names only the roadmap-excluded API", () => {
    expect([...SPEC_UNSUPPORTED_HOST_APIS]).toEqual(["npmLockUpdate"]);
  });
});
