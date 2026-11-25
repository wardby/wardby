/** agent-loop.ts's pure parts: the locked-edit reply names the state the document is actually locked in. */
import { describe, expect, it } from "vitest";
import { lockedEditReply, lockedStateForReply } from "./agent-loop.js";

describe("lockedStateForReply", () => {
  it("names each locked state as it is, and anything else (or a deleted document) as approved", () => {
    expect(lockedStateForReply("approved")).toBe("approved");
    expect(lockedStateForReply("rejected")).toBe("rejected");
    expect(lockedStateForReply("archived")).toBe("archived");
    expect(lockedStateForReply("in_review")).toBe("approved");
    expect(lockedStateForReply(null)).toBe("approved");
  });

  it("a document rejected while the agent worked gets a reply that says rejected", () => {
    const reply = lockedEditReply(lockedStateForReply("rejected"), "b");
    expect(reply).toMatch(/^The document was rejected while the agent worked, so its edit was not applied\./);
  });
});
