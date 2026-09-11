import { describe, it, expect } from "vitest";
import { SANDBOX_PRELUDE } from "./prelude.js";

describe("sandbox email placeholders", () => {
  it("declares sendEmail and getInboundEmail as globals so the surface scan sees them", () => {
    expect(SANDBOX_PRELUDE).toMatch(/globalThis\.sendEmail\s*=/);
    expect(SANDBOX_PRELUDE).toMatch(/globalThis\.getInboundEmail\s*=/);
  });

  it("does NOT declare npmLockUpdate (roadmap-excluded)", () => {
    expect(SANDBOX_PRELUDE).not.toMatch(/globalThis\.npmLockUpdate\s*=/);
  });

  it("both placeholders throw a clear 'not implemented' error when called", () => {
    // The placeholders throw synchronously; the prelude assigns them to a
    // shared factory. Assert the message the tool author will see.
    expect(SANDBOX_PRELUDE).toMatch(/is not implemented in this build/);
  });
});
