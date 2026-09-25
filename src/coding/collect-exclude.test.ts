import { describe, expect, it } from "vitest";
import {
  BUILTIN_COLLECT_EXCLUDE_NAMES,
  collectExclusions,
  gitExcludePathspecs,
  isCollectExcluded,
  normalizeCollectExclusions,
  tarExcludeArgs,
  validateCollectExcludePath,
} from "./collect-exclude.js";

describe("collectExclusions", () => {
  it("always includes the built-in names and dedupes paths", () => {
    expect(collectExclusions(["web/dist", "web/dist", "build"])).toEqual({
      names: [...BUILTIN_COLLECT_EXCLUDE_NAMES],
      paths: ["web/dist", "build"],
    });
  });

  it.each(["/abs", "./rel", "a/../b", "a//b", "a/*", "a?", "[x]", "back\\slash", "", "a\u0001b", "x".repeat(513)])(
    "rejects the unsafe path %j",
    (path) => {
      expect(() => validateCollectExcludePath(path)).toThrow("collect_exclude_path_invalid");
    },
  );

  it("rejects more than 64 paths", () => {
    expect(() => collectExclusions(Array.from({ length: 65 }, (_, i) => `p${i}`))).toThrow(
      "collect_exclude_path_invalid",
    );
  });
});

describe("normalizeCollectExclusions", () => {
  it("accepts a stored list and rejects anything else", () => {
    expect(normalizeCollectExclusions(["web/dist"]).paths).toEqual(["web/dist"]);
    expect(normalizeCollectExclusions(undefined).paths).toEqual([]);
    expect(() => normalizeCollectExclusions("web/dist")).toThrow("collect_exclude_invalid");
    expect(() => normalizeCollectExclusions([1])).toThrow("collect_exclude_invalid");
  });
});

describe("isCollectExcluded", () => {
  const exclusions = collectExclusions(["web/dist"]);
  it.each([
    ["node_modules", true],
    ["web/node_modules/react/index.js", true],
    ["pkg/__pycache__/x.pyc", true],
    ["web/dist", true],
    ["web/dist/app.js", true],
    ["web/distribution/app.js", false],
    ["src/node_modules_helper.ts", false],
    ["src/app.ts", false],
  ])("%s -> %s", (path, expected) => {
    expect(isCollectExcluded(path, exclusions)).toBe(expected);
  });
});

describe("renderings", () => {
  const exclusions = collectExclusions(["web/dist"]);
  it("renders GNU tar options: unanchored names, then anchored paths", () => {
    const args = tarExcludeArgs(exclusions);
    expect(args[0]).toBe("--no-anchored");
    expect(args).toContain("--exclude=node_modules");
    expect(args.slice(args.indexOf("--anchored"))).toEqual(["--anchored", "--exclude=./web/dist"]);
  });

  it("renders Git exclude pathspecs for names at any depth and for literal paths", () => {
    const specs = gitExcludePathspecs(exclusions);
    expect(specs).toContain(":(exclude,glob)**/node_modules/**");
    expect(specs).toContain(":(exclude,literal)web/dist");
  });
});
