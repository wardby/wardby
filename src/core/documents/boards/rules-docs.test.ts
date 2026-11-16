import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOARD_FORMAT_RULES } from "./rules.js";

describe("board format docs", () => {
  it("help/design-boards-format.md states every rule as the code does", () => {
    const help = readFileSync(new URL("../../../../help/design-boards-format.md", import.meta.url), "utf8");
    for (const rule of BOARD_FORMAT_RULES) expect(help).toContain(rule);
  });
});
