import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isSafePlanPath as protocolSafe, PLAN_FILES_LIMITS, PLAN_FOLDER_PATH } from "../coding/protocol.js";
import { collectPlanFolder, isSafePlanPath, PLAN_LIMITS, PLAN_ROOT, placePlanFiles } from "./plan-folder.mjs";

let base: string;
let root: string;
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const text = (file: { contentBase64: string }) => Buffer.from(file.contentBase64, "base64").toString("utf8");

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "wardby-plan-"));
  root = join(base, "plan");
});

describe("plan folder", () => {
  it("keeps the protocol's folder, limits and path rule", () => {
    expect(PLAN_ROOT).toBe(PLAN_FOLDER_PATH);
    expect(PLAN_LIMITS).toEqual(PLAN_FILES_LIMITS);
    for (const path of ["plan.md", "a/b.md", "../x", "/x", ".h", "a/b/c/d/e"]) {
      expect(isSafePlanPath(path)).toBe(protocolSafe(path));
    }
  });

  it("places files, then collects every regular file sorted by path", async () => {
    await placePlanFiles(root, [
      { path: "plan.md", contentBase64: b64("# Plan\n") },
      { path: "screens/boards/home.html", contentBase64: b64("<main></main>") },
    ]);
    expect(await readFile(join(root, "plan.md"), "utf8")).toBe("# Plan\n");
    await writeFile(join(root, "api.md"), "# API\n");
    const collected = await collectPlanFolder(root);
    expect(collected.status).toBe("ok");
    if (collected.status !== "ok") return;
    expect(collected.files.map((f) => f.path)).toEqual(["api.md", "plan.md", "screens/boards/home.html"]);
    expect(text(collected.files[1])).toBe("# Plan\n");
  });

  it("a missing folder is an empty plan", async () => {
    expect(await collectPlanFolder(root)).toEqual({ status: "ok", files: [], skipped: [], skippedUnnamed: 0 });
  });

  it("never follows a symlink: a linked file or folder is skipped and listed", async () => {
    await mkdir(root);
    await writeFile(join(base, "secret.txt"), "sk-test-NOT-A-REAL-KEY-0000000000");
    await symlink(join(base, "secret.txt"), join(root, "leak.md"));
    await symlink(base, join(root, "outside"));
    const collected = await collectPlanFolder(root);
    expect(collected).toEqual({ status: "ok", files: [], skipped: ["leak.md", "outside"], skippedUnnamed: 0 });
  });

  it("refuses a root that is itself a symlink", async () => {
    await mkdir(join(base, "elsewhere"));
    await symlink(join(base, "elsewhere"), root);
    expect(await collectPlanFolder(root)).toEqual({ status: "error", error: "plan_folder_invalid" });
    await expect(placePlanFiles(root, [{ path: "a.md", contentBase64: b64("x") }])).rejects.toThrow(
      "plan_folder_invalid",
    );
  });

  it("refuses unsafe input paths", async () => {
    for (const path of ["../escape.md", "/etc/passwd", "a/../../b.md"]) {
      await expect(placePlanFiles(root, [{ path, contentBase64: b64("x") }])).rejects.toThrow("plan_path_invalid");
    }
  });

  it("skips dot entries, too-deep paths and non-UTF-8 files", async () => {
    await mkdir(join(root, "a/b/c/d"), { recursive: true });
    await writeFile(join(root, ".env"), "x");
    await writeFile(join(root, "a/b/c/d/deep.md"), "x");
    await writeFile(join(root, "bin.md"), Buffer.from([0xff, 0xfe]));
    const collected = await collectPlanFolder(root);
    expect(collected).toEqual({ status: "ok", files: [], skipped: ["bin.md"], skippedUnnamed: 2 });
  });

  it("over any limit returns plan_too_large and no files", async () => {
    await mkdir(root);
    await writeFile(join(root, "big.md"), Buffer.alloc(PLAN_LIMITS.maxFileBytes + 1, 97));
    expect(await collectPlanFolder(root)).toEqual({ status: "error", error: "plan_too_large" });
  });

  it("more than maxFiles files is plan_too_large", async () => {
    await mkdir(root);
    for (let i = 0; i <= PLAN_LIMITS.maxFiles; i++) await writeFile(join(root, `f${i}.md`), "x");
    expect(await collectPlanFolder(root)).toEqual({ status: "error", error: "plan_too_large" });
  });
});
