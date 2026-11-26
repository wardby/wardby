import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workerSecurityInstructions } from "./security-instructions.js";

const before = JSON.parse(
  readFileSync(new URL("./fixtures/security-instructions.json", import.meta.url), "utf8"),
) as Record<string, string>;

describe("workerSecurityInstructions", () => {
  for (const mcp of [false, true]) {
    for (const gitHistory of [false, true]) {
      it(`keeps Codex and Claude Code byte-identical (mcp=${mcp}, history=${gitHistory})`, () => {
        expect(
          workerSecurityInstructions({ shape: "in-container", instructionFiles: ["AGENTS.md"], mcp, gitHistory }),
        ).toBe(before[`codex mcp=${mcp} history=${gitHistory}`]);
        expect(
          workerSecurityInstructions({ shape: "tool-runner", instructionFiles: ["CLAUDE.md"], mcp, gitHistory }),
        ).toBe(before[`claude mcp=${mcp} history=${gitHistory}`]);
      });
    }
  }

  it("names every instruction file the Gemini CLI loads", () => {
    const text = workerSecurityInstructions({
      shape: "in-container",
      instructionFiles: ["GEMINI.md", "AGENTS.md", "CLAUDE.md"],
      mcp: false,
      gitHistory: false,
    });
    expect(text).toContain("including GEMINI.md, AGENTS.md, CLAUDE.md and all other instruction files");
    expect(text.startsWith("/")).toBe(false);
  });
});
