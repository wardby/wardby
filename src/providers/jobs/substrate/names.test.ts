import { describe, expect, it } from "vitest";
import { assertValidBlobKey } from "../../storage/types.js";
import { BLOB, agentActorName, substrateRunToken, templateName, toolActorSubject } from "./names.js";

describe("substrate names", () => {
  it("derives stable, label-safe names from the run id", () => {
    const t = substrateRunToken("Run_ABC/123");
    expect(t).toMatch(/^wr-[0-9a-f]{20}$/);
    expect(substrateRunToken("Run_ABC/123")).toBe(t);
    expect(agentActorName(t)).toMatch(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])$/);
    expect(toolActorSubject("wardby-runs", t)).toBe(`actor/wardby-runs/${t}-tool`);
  });
  it("names templates by content", () => {
    const a = templateName("agent", "r@sha256:aa", 1000, 2 ** 30);
    expect(a).toMatch(/^wardby-agent-[0-9a-f]{16}$/);
    expect(templateName("agent", "r@sha256:bb", 1000, 2 ** 30)).not.toBe(a);
  });
  it("produces valid blob keys", () => {
    const t = substrateRunToken("x");
    for (const key of Object.values(BLOB)) assertValidBlobKey(key(t));
  });
});
