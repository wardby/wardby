import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareStorage } from "./keeper.js";

describe("coding worker storage keeper", () => {
  it("creates only the fixed private storage subdirectories", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-keeper-"));
    await prepareStorage(root);
    for (const directory of ["workspace", "git", "input", "output"]) {
      const details = await stat(join(root, directory));
      expect(details.isDirectory()).toBe(true);
      expect(details.mode & 0o777).toBe(0o700);
    }
  });
});
