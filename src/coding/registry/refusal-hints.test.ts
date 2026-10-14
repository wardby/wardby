import { describe, expect, it } from "vitest";
import {
  GRAPH_INCOMPLETE,
  GRAPH_LIMIT,
  PACKAGE_NOT_ALLOWED,
  PACKAGE_NOT_ALLOWED_PENDING,
  graphIncompleteMessage,
  graphLimitMessage,
  notAllowedMessage,
  notAllowedPendingMessage,
  refusalHint,
  refusalMeaning,
} from "./refusal-hints.js";

describe("refusal wording", () => {
  it("pending message names the package, the ecosystem, the progress and 'retrying rarely helps'", () => {
    const message = notAllowedPendingMessage("expo-dev-client", "npm", { walked: 1171, queued: 240 });
    expect(message).toContain("expo-dev-client");
    expect(message).toContain("npm");
    expect(message).toContain("after 1,171 packages, at least 240 more queued");
    expect(message).toContain("retrying rarely helps");
    expect(message).toContain("is not on this agent's allowlist");
  });

  it("pending message pluralizes one package", () => {
    expect(notAllowedPendingMessage("left-pad", "npm", { walked: 1, queued: 3 })).toContain("after 1 package,");
  });

  it("final message says the owner must allowlist it, with and without an allowlist", () => {
    for (const hasAllowlist of [true, false]) {
      const message = notAllowedMessage("left-pad", "npm", hasAllowlist);
      expect(message).toContain("left-pad");
      expect(message).toContain("npm");
      expect(message).toContain("owner must allowlist");
    }
    expect(notAllowedMessage("left-pad", "npm", true)).not.toBe(notAllowedMessage("left-pad", "npm", false));
  });

  it("limit message names REGISTRY_MAX_GRAPH_PACKAGES and 'retrying will not help'", () => {
    const message = graphLimitMessage("expo", "npm", 5000);
    expect(message).toContain("REGISTRY_MAX_GRAPH_PACKAGES");
    expect(message).toContain("5,000");
    expect(message).toContain("retrying will not help");
    expect(message).toContain("limit of 5,000 packages");
    expect(message).toContain("owner must allowlist expo directly");
  });

  it("incomplete message says try again and never 'not on this agent's allowlist'", () => {
    const message = graphIncompleteMessage("expo", "npm", { walked: 10, queued: 2 });
    expect(message).toContain("is still being checked against the allowed packages' dependency graph");
    expect(message).toContain("try again");
    expect(message).not.toContain("not on this agent's allowlist");
    expect(message).not.toContain("owner must allowlist");
  });

  it("every allowlist code has a hint and a meaning that say 'owner must allowlist'; graph_incomplete's do not", () => {
    for (const code of [PACKAGE_NOT_ALLOWED, PACKAGE_NOT_ALLOWED_PENDING, GRAPH_LIMIT]) {
      expect(refusalHint(code)).toContain("owner must allowlist");
      expect(refusalMeaning(code)).toContain("owner must allowlist");
    }
    expect(refusalHint(GRAPH_INCOMPLETE)).toBeDefined();
    expect(refusalHint(GRAPH_INCOMPLETE)).not.toContain("owner must allowlist");
    expect(refusalMeaning(GRAPH_INCOMPLETE)).not.toContain("owner must allowlist");
  });

  it("existing banner meanings are unchanged", () => {
    expect(refusalMeaning("wardby_version_filtered")).toBe(
      "withheld: newer than the release-age limit, or a high-severity advisory",
    );
    expect(refusalMeaning("wardby_lockfile_integrity_mismatch")).toBe(
      "the lock file's integrity does not match the registry's",
    );
    expect(refusalMeaning("wardby_upstream_error")).toBe("the upstream registry failed (transient)");
    expect(refusalMeaning("wardby_audit_unavailable")).toBe("the advisory check was unavailable (transient)");
    expect(refusalMeaning(GRAPH_INCOMPLETE)).toBe(
      "still being checked against the allowed packages' dependency graph; retry shortly",
    );
  });

  it("unknown codes have no hint or meaning", () => {
    expect(refusalHint("wardby_nope")).toBeUndefined();
    expect(refusalMeaning("wardby_nope")).toBeUndefined();
  });
});
