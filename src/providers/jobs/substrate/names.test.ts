import { describe, expect, it } from "vitest";
import { MCP_TOKEN_HEADER } from "../../../coding/mcp-token.js";
import { assertValidBlobKey } from "../../storage/types.js";
import {
  BLOB,
  isSubstrateImageItem,
  MCP_TOKEN_EGRESS_HEADER,
  REPO_BLOB,
  actorNamesFor,
  agentActorName,
  substrateRunToken,
  templateName,
  templateRoleOf,
  toolActorName,
  toolActorSubject,
} from "./names.js";

describe("substrate names", () => {
  it("derives stable, label-safe names from the run id", () => {
    const t = substrateRunToken("Run_ABC/123");
    expect(t).toMatch(/^wr-[0-9a-f]{20}$/);
    expect(substrateRunToken("Run_ABC/123")).toBe(t);
    expect(agentActorName(t)).toMatch(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])$/);
    expect(toolActorSubject("wardby-runs", t)).toBe(`actor/wardby-runs/${t}-tool`);
  });
  it("reads a template name's role back, and nothing else", () => {
    for (const role of ["agent", "tool", "codex"] as const) {
      expect(templateRoleOf(templateName(role, "r@sha256:aa", 1000, 2 ** 30, "v1"))).toBe(role);
    }
    for (const name of [
      "",
      "wardby-agent-",
      "wardby-agent-0123456789abcdeF",
      "wardby-agent-0123456789abcdef0",
      "wardby-other-0123456789abcdef",
      "xwardby-tool-0123456789abcdef",
      "wardby-tool-0123456789abcdef\n",
    ]) {
      expect(templateRoleOf(name)).toBeUndefined();
    }
  });
  it("names templates by content", () => {
    const a = templateName("agent", "r@sha256:aa", 1000, 2 ** 30, "v1");
    expect(a).toMatch(/^wardby-agent-[0-9a-f]{16}$/);
    expect(templateName("agent", "r@sha256:bb", 1000, 2 ** 30, "v1")).not.toBe(a);
    expect(templateName("agent", "r@sha256:aa", 1000, 2 ** 30, "v2")).not.toBe(a);
    expect(templateName("agent", "r@sha256:aa", 1000, 2 ** 30, "v1")).toBe(a);
  });
  it("names a Codex template with its own role, never an agent template's name", () => {
    const codex = templateName("codex", "r@sha256:aa", 1000, 2 ** 30, "v1");
    expect(codex).toMatch(/^wardby-codex-[0-9a-f]{16}$/);
    expect(codex.slice("wardby-codex-".length)).not.toBe(
      templateName("agent", "r@sha256:aa", 1000, 2 ** 30, "v1").slice("wardby-agent-".length),
    );
  });
  it("lists a run's actors by shape", () => {
    const t = substrateRunToken("x");
    expect(actorNamesFor(t, "pair")).toEqual([agentActorName(t), toolActorName(t)]);
    expect(actorNamesFor(t, "single")).toEqual([agentActorName(t)]);
  });
  it("names the MCP egress header the proxy reads", () => {
    expect(MCP_TOKEN_EGRESS_HEADER.toLowerCase()).toBe(MCP_TOKEN_HEADER);
  });
  it("keys the bridge refusal once per run", () => {
    expect(BLOB.bridgeRefused("wr-00000000000000000000")).toBe(
      "substrate/runs/wr-00000000000000000000/bridge-refused.json",
    );
    assertValidBlobKey(BLOB.bridgeRefused("wr-00000000000000000000"));
  });
  it("keys the image report once per run", () => {
    expect(BLOB.imageIncomplete("wr-00000000000000000000")).toBe(
      "substrate/runs/wr-00000000000000000000/image-incomplete.json",
    );
    assertValidBlobKey(BLOB.imageIncomplete("wr-00000000000000000000"));
  });
  it("accepts only the image check's items", () => {
    for (const item of ["user", "runner", "tar", "workspace", "run_dir"]) expect(isSubstrateImageItem(item)).toBe(true);
    for (const value of ["other", "", "Runner", 1, null, undefined, {}, ["tar"]]) {
      expect(isSubstrateImageItem(value)).toBe(false);
    }
  });
  it("produces valid blob keys", () => {
    const t = substrateRunToken("x");
    for (const key of Object.values(BLOB)) assertValidBlobKey(key(t));
  });

  describe("REPO_BLOB", () => {
    const t = "wr-00000000000000000000";

    it("keys an extra repository's seed and workspace under repos/<name>", () => {
      expect(REPO_BLOB.seed(t, "extra-alpha")).toBe(
        "substrate/runs/wr-00000000000000000000/repos/extra-alpha/seed.tar",
      );
      expect(REPO_BLOB.workspace(t, "extra-alpha")).toMatch(/\/repos\/extra-alpha\/workspace\.tar$/);
      expect(REPO_BLOB.workspace(t, "extra-alpha", 1)).toMatch(/\/repos\/extra-alpha\/workspace\.tar$/);
      expect(REPO_BLOB.workspace(t, "extra-alpha", 3)).toMatch(/\/repos\/extra-alpha\/workspace-3\.tar$/);
      assertValidBlobKey(REPO_BLOB.seed(t, "extra-alpha"));
      assertValidBlobKey(REPO_BLOB.workspace(t, "extra-alpha", 3));
    });

    it.each(["workspace", "../x", "a/b", ""])("refuses a name that is not a link name: %j", (name) => {
      expect(() => REPO_BLOB.seed(t, name)).toThrow("substrate_repository_name_invalid");
      expect(() => REPO_BLOB.workspace(t, name)).toThrow("substrate_repository_name_invalid");
    });

    it("lists BLOB's keys", () => {
      expect(Object.keys(BLOB)).toEqual([
        "input",
        "toolSetup",
        "seed",
        "result",
        "transcript",
        "planFiles",
        "workspace",
        "exit",
        "done",
        "started",
        "bridgeRefused",
        "imageIncomplete",
      ]);
    });
  });
});
