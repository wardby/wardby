import { describe, it, expect } from "vitest";
import { parseImportArgs } from "./cli-args.js";

describe("parseImportArgs", () => {
  it("parses the bundle dir and owner with defaults", () => {
    const o = parseImportArgs(["/tmp/bundle", "--owner", "sub-1"]);
    expect(o.dir).toBe("/tmp/bundle");
    expect(o.owner).toBe("sub-1");
    expect(o.prefix).toBe("imported-");
    expect(o.onConflict).toBe("fail");
    expect(o.dryRun).toBe(false);
  });
  it("parses --public, --dry-run, --include-secrets, --on-conflict rename", () => {
    const o = parseImportArgs([
      "/tmp/b",
      "--public",
      "--dry-run",
      "--include-secrets",
      "--transfer-key",
      "/k.pem",
      "--on-conflict",
      "rename",
    ]);
    expect(o.isPublic).toBe(true);
    expect(o.dryRun).toBe(true);
    expect(o.includeSecrets).toBe(true);
    expect(o.transferKeyPath).toBe("/k.pem");
    expect(o.onConflict).toBe("rename");
  });
  it("throws when the bundle dir positional is missing", () => {
    expect(() => parseImportArgs(["--owner", "s"])).toThrow(/bundle/i);
  });
  it("throws on an invalid --on-conflict value", () => {
    expect(() => parseImportArgs(["/tmp/b", "--on-conflict", "explode"])).toThrow(/on-conflict/);
  });
});
