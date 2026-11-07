import { describe, expect, it } from "vitest";
import {
  bounded,
  displayToolName,
  maskForTransport,
  maskTruncatedTail,
  stepSummary,
  toolInputText,
  toolStepText,
} from "./summarize.js";
import { MAX_STEP_TEXT_CHARS, MAX_SUMMARY_CHARS, SAID_SUMMARY_CHARS, TOOL_SUMMARY_CHARS } from "./types.js";

// Fake values only: never a real credential.
const FAKE_SECRET = "wbFake-Secret-Value-7f3a91";
const FAKE_TOKEN = "ghp_FAKEfakeFAKEfake0123456789abcd";

describe("displayToolName", () => {
  it("names the proxy's tools the way a reader knows them: Claude Code's run_command is Bash", () => {
    expect(displayToolName("mcp__wardby_tools__run_command")).toBe("Bash");
    expect(displayToolName("run_command")).toBe("Bash");
    expect(displayToolName("mcp__wardby_mcp__search_issues")).toBe("mcp:search_issues");
    expect(displayToolName("echo", "mcp__wardby_mcp")).toBe("mcp:echo");
    expect(displayToolName("list_agents", "collaboration")).toBe("collaboration.list_agents");
    expect(displayToolName("exec_command")).toBe("exec_command");
    expect(displayToolName("bad name!")).toBe("tool");
  });
});

describe("toolInputText", () => {
  it.each<[string, unknown, string]>([
    ["Bash", { command: "npm test", timeout_ms: 60000 }, "npm test"],
    ["run_command", { command: "npm test" }, "npm test"],
    ["exec_command", { cmd: "echo hi" }, "echo hi"],
    ["exec_command", { cmd: ["bash", "-lc", "npm run lint"] }, "npm run lint"],
    ["shell", { command: ["git", "status"] }, "git status"],
    ["Grep", { pattern: "TODO", path: "src" }, "TODO in src"],
    ["Read", { file_path: "src/a.ts" }, "src/a.ts"],
    [
      "apply_patch",
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+x\n*** End Patch\n",
      "src/a.ts, src/b.ts",
    ],
    ["exec", 'const r = await tools.exec_command({cmd: "git status --short"}); text(r.output);', "git status --short"],
    ["exec", "\n  text(ALL_TOOLS.length);\n", "text(ALL_TOOLS.length);"],
    ["lookup", { query: "weather", limit: 3 }, "weather"],
    ["lookup", { limit: 3 }, "3"],
    ["lookup", { nested: { a: 1 } }, ""],
    ["lookup", null, ""],
  ])("%s %j -> %j", (tool, input, expected) => {
    expect(toolInputText(tool, input)).toBe(expected);
  });
});

describe("toolStepText", () => {
  it("parses whole arguments, and falls back to the leading field of cut-off JSON", () => {
    expect(toolStepText("exec_command", '{"cmd":"npm test"}')).toEqual({ text: "npm test", truncated: false });
    expect(toolStepText("Bash", '{"command": "npm te')).toEqual({ text: "npm te", truncated: false });
    const long = toolStepText("Bash", JSON.stringify({ command: `echo ${"x".repeat(20_000)}` }));
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(MAX_STEP_TEXT_CHARS);
  });
});

describe("stepSummary", () => {
  const tool = (text: string, truncated = false) => ({ kind: "tool" as const, text, truncated });
  const said = (text: string) => ({ kind: "said" as const, text, truncated: false });

  it("redacts exact values and token shapes before it collapses whitespace and cuts", () => {
    expect(stepSummary(tool(`echo ${FAKE_SECRET}`), [FAKE_SECRET])).toBe("echo [REDACTED]");
    const multiline = "line-one-secret\nline-two-secret";
    expect(stepSummary(tool(`cat <<EOF\n${multiline}\nEOF`), [multiline])).toBe("cat <<EOF [REDACTED] EOF");
    const pushed = stepSummary(tool(`git push https://x:${FAKE_TOKEN}@github.com/o/r`), []);
    expect(pushed).not.toContain(FAKE_TOKEN);
    expect(pushed).toContain("[REDACTED]");
    expect(stepSummary(tool("npm   test\n  --watch"), [])).toBe("npm test --watch");
  });

  it("cuts tool input to 100 characters and model text to 120", () => {
    const cutTool = stepSummary(tool("a".repeat(150)), []);
    expect(cutTool).toHaveLength(TOOL_SUMMARY_CHARS);
    expect(cutTool.endsWith("…")).toBe(true);
    expect(stepSummary(said("b".repeat(150)), [])).toHaveLength(SAID_SUMMARY_CHARS);
    expect(TOOL_SUMMARY_CHARS).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
  });

  it("masks the start of a secret left at the end of a cut-off text", () => {
    const cut = `deploy --key ${FAKE_SECRET.slice(0, 12)}`;
    expect(stepSummary(tool(cut, true), [FAKE_SECRET])).toBe("deploy --key [REDACTED]");
    expect(maskTruncatedTail(`x ${FAKE_SECRET.slice(0, 5)}`, [FAKE_SECRET])).toBe(`x ${FAKE_SECRET.slice(0, 5)}`);
  });

  it("bounds text at 16 KiB", () => {
    expect(bounded("z".repeat(MAX_STEP_TEXT_CHARS + 1))).toEqual({
      text: "z".repeat(MAX_STEP_TEXT_CHARS),
      truncated: true,
    });
  });
});

describe("maskForTransport", () => {
  it("masks token shapes only: the proxy cannot know exact values, the control plane redacts those", () => {
    const masked = maskForTransport({
      steps: [{ kind: "tool", callId: "c1", tool: "Bash", text: `use ${FAKE_TOKEN} ${FAKE_SECRET}`, truncated: false }],
      results: [{ callId: "c0", status: "ok" }],
    });
    expect(masked.steps[0].text).not.toContain(FAKE_TOKEN);
    expect(masked.steps[0].text).toContain(FAKE_SECRET);
    expect(masked.results).toEqual([{ callId: "c0", status: "ok" }]);
  });
});
