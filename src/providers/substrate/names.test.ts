import { describe, expect, it } from "vitest";
import { nativeActorName, substrateRunToken, templateName } from "./names.js";
import * as coding from "../jobs/substrate/names.js";

describe("shared Substrate names", () => {
  it("pins the run token", () => {
    expect(substrateRunToken("run-1")).toBe("wr-4e65d3fbe8ad6535681b");
  });

  it("pins the template name", () => {
    expect(templateName("agent", "r@sha256:aa", 1000, 2 ** 30, "v1")).toBe("wardby-agent-2c5efced222c5cfb");
  });

  it("names a native run's actor after its run token", () => {
    const name = nativeActorName(substrateRunToken("run-1"));
    expect(name.endsWith("-native")).toBe(true);
    expect(name).toMatch(/^wr-[0-9a-f]{20}-native$/);
  });

  it("is re-exported unchanged by the coding launcher's names", () => {
    expect(coding.substrateRunToken).toBe(substrateRunToken);
    expect(coding.templateName).toBe(templateName);
  });
});
