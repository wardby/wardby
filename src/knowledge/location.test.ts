import { describe, expect, it } from "vitest";
import { DEFAULT_KNOWLEDGE_BUNDLE_PATH } from "./concept.js";
import { normalizeBundlePath, parseKnowledgeConfig, resolveKnowledgeLocation } from "./location.js";

describe("parseKnowledgeConfig", () => {
  it("reads the path key", () => {
    expect(parseKnowledgeConfig("path: .okf\n")).toEqual({ ok: true, bundlePath: ".okf" });
  });

  it("normalizes ./ prefixes and trailing slashes", () => {
    expect(parseKnowledgeConfig("path: ./docs/arch/\n")).toEqual({ ok: true, bundlePath: "docs/arch" });
  });

  it.each([
    ["not YAML", "path: [", "not valid YAML"],
    ["a list", "- .okf\n", "mapping"],
    ["an empty file", "", "mapping"],
    ["an unknown key", "path: .okf\nmode: strict\n", "unknown key `mode`"],
    ["a non-string path", "path: 3\n", "must be a string"],
  ])("refuses %s", (_name, text, error) => {
    const parsed = parseKnowledgeConfig(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toContain(error);
  });
});

describe("normalizeBundlePath", () => {
  it.each([
    ["", "inside the repository"],
    [".", "inside the repository"],
    ["./", "inside the repository"],
    ["/abs/knowledge", "relative to the repository root"],
    ["../outside", "`..` segments"],
    ["docs/../../outside", "`..` segments"],
    ["docs//knowledge", "empty"],
    [".wardby/knowledge", "`.wardby/`"],
    [".git/knowledge", "`.git/`"],
    ["docs\\knowledge", "plain POSIX path"],
    ["docs/\u0000knowledge", "plain POSIX path"],
    ["a".repeat(201), "at most 200 characters"],
  ])("refuses %j", (path, error) => {
    const parsed = normalizeBundlePath(path);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toContain(error);
  });

  it("accepts a hidden folder and a nested folder", () => {
    expect(normalizeBundlePath(".okf")).toEqual({ ok: true, bundlePath: ".okf" });
    expect(normalizeBundlePath("docs/architecture/knowledge")).toEqual({
      ok: true,
      bundlePath: "docs/architecture/knowledge",
    });
  });
});

describe("resolveKnowledgeLocation", () => {
  it("uses the folder the file names", async () => {
    expect(await resolveKnowledgeLocation(async () => "path: .okf\n")).toEqual({ bundlePath: ".okf" });
  });

  it("uses the default, without a warning, when the file does not exist", async () => {
    expect(await resolveKnowledgeLocation(async () => null)).toEqual({ bundlePath: DEFAULT_KNOWLEDGE_BUNDLE_PATH });
    expect(await resolveKnowledgeLocation(async () => undefined)).toEqual({
      bundlePath: DEFAULT_KNOWLEDGE_BUNDLE_PATH,
    });
  });

  it("uses the default, with a warning, when the file is invalid", async () => {
    const location = await resolveKnowledgeLocation(async () => "path: ../outside\n");
    expect(location.bundlePath).toBe(DEFAULT_KNOWLEDGE_BUNDLE_PATH);
    expect(location.warning).toContain(".wardby/knowledge.yaml was ignored");
    expect(location.warning).toContain("`..` segments");
  });

  it("uses the default, with a warning, when the read fails", async () => {
    const location = await resolveKnowledgeLocation(async () => {
      throw new Error("github_file_too_large");
    });
    expect(location).toEqual({
      bundlePath: DEFAULT_KNOWLEDGE_BUNDLE_PATH,
      warning: expect.stringContaining("could not be read (github_file_too_large)"),
    });
  });
});
