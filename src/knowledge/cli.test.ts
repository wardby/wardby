import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleDirFromConfig, loadBundle, parseKnowledgeArgs } from "./cli.js";

describe("parseKnowledgeArgs", () => {
  it("defaults the dir and root", () => {
    expect(parseKnowledgeArgs(["check"])).toEqual({ dir: undefined, root: ".", strict: false, json: false });
  });
  it("reads flags and an explicit dir", () => {
    expect(parseKnowledgeArgs(["check", "kb", "--root", "/r", "--strict", "--json"])).toEqual({
      dir: "kb",
      root: "/r",
      strict: true,
      json: true,
    });
  });
  it("rejects an unknown subcommand", () => {
    expect(() => parseKnowledgeArgs(["fix"])).toThrow(/usage/i);
  });
});

describe("loadBundle", () => {
  it("loads .md files recursively with bundle-relative keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "index.md"), "x");
    writeFileSync(join(dir, "sub", "a.md"), "y");
    writeFileSync(join(dir, "notes.txt"), "z");
    expect([...loadBundle(dir).keys()].sort()).toEqual(["index.md", "sub/a.md"]);
  });
  it("skips symbolic links, so a link cycle or a dangling link cannot break the walk", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-"));
    const outside = mkdtempSync(join(tmpdir(), "kb-outside-"));
    writeFileSync(join(outside, "secret.md"), "outside the bundle");
    writeFileSync(join(dir, "index.md"), "x");
    symlinkSync(dir, join(dir, "loop"));
    symlinkSync(outside, join(dir, "elsewhere"));
    symlinkSync(join(outside, "secret.md"), join(dir, "linked.md"));
    symlinkSync(join(dir, "missing.md"), join(dir, "dangling.md"));
    expect([...loadBundle(dir).keys()]).toEqual(["index.md"]);
  });
});

describe("bundleDirFromConfig", () => {
  const repo = (config?: string) => {
    const root = mkdtempSync(join(tmpdir(), "kb-root-"));
    if (config !== undefined) {
      mkdirSync(join(root, ".wardby"));
      writeFileSync(join(root, ".wardby", "knowledge.yaml"), config);
    }
    return root;
  };

  it("uses the default when there is no .wardby/knowledge.yaml", () => {
    expect(bundleDirFromConfig(repo())).toEqual({ dir: "docs/knowledge" });
  });

  it("uses the folder the file names", () => {
    expect(bundleDirFromConfig(repo("path: .okf\n"))).toEqual({ dir: ".okf" });
  });

  it("reports an invalid file and checks the default", () => {
    expect(bundleDirFromConfig(repo("path: ../outside\n"))).toEqual({
      dir: "docs/knowledge",
      configError: expect.stringContaining("`..` segments"),
    });
  });
});
