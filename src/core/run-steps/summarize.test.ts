import { describe, expect, it } from "vitest";
import {
  bounded,
  displayToolName,
  maskForTransport,
  MAX_MARKERS_CHECKED,
  maskTruncatedTail,
  secretForms,
  stepSummarizer,
  stepSummary,
  summaryCacheStats,
  toolInputText,
  toolStepText,
} from "./summarize.js";
import { MAX_STEP_TEXT_CHARS, MAX_SUMMARY_CHARS, SAID_SUMMARY_CHARS, TOOL_SUMMARY_CHARS } from "./types.js";

// Fake values only: never a real credential.
const FAKE_SECRET = "wbFake-Secret-Value-7f3a91";
const FAKE_TOKEN = "ghp_FAKEfakeFAKEfake0123456789abcd";
const REDACTED_TEXT = "[REDACTED]";

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
    expect(toolStepText("Bash", '{"command": "npm te')).toEqual({ text: "npm te", truncated: true });
    expect(toolStepText("Bash", '{"command": "npm test", "timeout_ms": 5')).toEqual({
      text: "npm test",
      truncated: false,
    });
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

  const fragmentOf = (out: string) => {
    for (let i = 0; i + 6 <= FAKE_SECRET.length; i++) {
      for (let j = i + 6; j <= FAKE_SECRET.length; j++) if (out.includes(FAKE_SECRET.slice(i, j))) return true;
    }
    return false;
  };

  it("leaves no secret fragment when the summary cut falls inside a secret", () => {
    const toolOut = stepSummary(tool(`${"a".repeat(90)} ${FAKE_SECRET}`), [FAKE_SECRET]);
    expect(toolOut).toContain("[REDACTED]".slice(0, 5));
    expect(fragmentOf(toolOut)).toBe(false);
    const saidOut = stepSummary(said(`${"b".repeat(110)} ${FAKE_SECRET}`), [FAKE_SECRET]);
    expect(fragmentOf(saidOut)).toBe(false);
  });

  it("leaves no secret fragment when the 16 KiB cut falls inside a secret and whitespace collapses", () => {
    const text = `${" ".repeat(MAX_STEP_TEXT_CHARS - 12)}${FAKE_SECRET}`;
    expect(text.length).toBeGreaterThan(MAX_STEP_TEXT_CHARS);
    const out = stepSummary(tool(text), [FAKE_SECRET]);
    expect(out).toBe("[REDACTED]");
    expect(fragmentOf(out)).toBe(false);
  });

  describe("a passphrase written with other whitespace", () => {
    const PASSPHRASE = "correct horse battery staple";
    const words = /correct|horse|battery|staple/;

    it("is redacted in a said step after whitespace collapses", () => {
      const out = stepSummary(said("the passphrase is correct  horse\nbattery staple ok"), [PASSPHRASE]);
      expect(out).toBe("the passphrase is [REDACTED] ok");
      expect(out).not.toMatch(words);
    });

    it("is redacted in a tool step, and a value with its own odd whitespace is matched collapsed", () => {
      expect(stepSummary(tool("echo correct\thorse  battery\n staple | gpg"), [PASSPHRASE])).toBe(
        "echo [REDACTED] | gpg",
      );
      expect(stepSummary(tool("echo correct horse battery staple"), ["correct  horse\nbattery staple"])).toBe(
        "echo [REDACTED]",
      );
    });

    it("leaves no word of it when the summary cut falls inside it", () => {
      const out = stepSummary(tool(`${"a".repeat(95)} correct  horse\nbattery   staple`), [PASSPHRASE]);
      expect(out).toHaveLength(TOOL_SUMMARY_CHARS);
      expect(out).not.toMatch(words);
    });

    it("masks its start at the end of a cut-off text after whitespace collapses", () => {
      expect(stepSummary(tool("unlock correct  horse\nbatt", true), [PASSPHRASE])).toBe("unlock [REDACTED]");
    });
  });

  it("masks the longest secret prefix at the end across all secret values", () => {
    const a = "abcdefgh";
    const b = "LONGPREFIX12345abcdefgh";
    expect(maskTruncatedTail("x LONGPREFIX12345abcdefg", [a, b])).toBe("x [REDACTED]");
    expect(maskTruncatedTail("x LONGPREFIX12345abcdefg", [b, a])).toBe("x [REDACTED]");
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

  it("marks a step it cut at 16 KiB as truncated", () => {
    const masked = maskForTransport({
      steps: [{ kind: "said", callId: "c1", text: "z".repeat(MAX_STEP_TEXT_CHARS + 5), truncated: false }],
      results: [],
    });
    expect(masked.steps[0].text).toHaveLength(MAX_STEP_TEXT_CHARS);
    expect(masked.steps[0].truncated).toBe(true);
  });
});

describe("overlapping secrets", () => {
  const P = "correct horse battery staple";
  const P2 = `correct horse ${FAKE_TOKEN} staple`;
  const words = /correct|horse|battery|staple/;

  it("redacts a passphrase whose word is itself a secret, written with other whitespace", () => {
    const out = stepSummary({ kind: "said", text: "pass is correct  horse\nbattery staple ok", truncated: false }, [
      P,
      "battery",
    ]);
    expect(out).toBe("pass is [REDACTED] ok");
    expect(out).not.toMatch(words);
  });

  it("redacts a passphrase holding a token-shaped word, written with other whitespace", () => {
    expect(
      stepSummary({ kind: "said", text: `use correct  horse ${FAKE_TOKEN}\nstaple now`, truncated: false }, [P2]),
    ).toBe("use [REDACTED] now");
  });

  it("redacts it after the proxy masked the token-shaped word (coding runs)", () => {
    const [sent] = maskForTransport({
      steps: [{ kind: "said", callId: "s", text: `use ${P2} now`, truncated: false }],
      results: [],
    }).steps;
    expect(stepSummary(sent, [P2])).toBe("use [REDACTED] now");
  });

  it("masks a cut-off start of the passphrase when a shorter secret is inside it", () => {
    expect(stepSummary({ kind: "tool", text: "unlock correct  horse\nbatt", truncated: true }, [P, "battery"])).toBe(
      "unlock [REDACTED]",
    );
  });

  it("marks a step truncated when token masking pushes it past 16 KiB, so no secret start survives", () => {
    const text = "a://b:c@ ".repeat(4) + " ".repeat(16_308) + FAKE_SECRET;
    expect(text.length).toBeLessThanOrEqual(MAX_STEP_TEXT_CHARS);
    const [sent] = maskForTransport({
      steps: [{ kind: "tool", callId: "c", tool: "Bash", text, truncated: false }],
      results: [],
    }).steps;
    expect(sent.truncated).toBe(true);
    expect(stepSummary(sent, [FAKE_SECRET])).toBe(
      "a://[REDACTED]@ a://[REDACTED]@ a://[REDACTED]@ a://[REDACTED]@ [REDACTED]",
    );
  });

  it("still redacts a value that is wholly token-shaped", () => {
    expect(stepSummary({ kind: "said", text: `a ${FAKE_TOKEN} b`, truncated: false }, [FAKE_TOKEN])).toBe(
      "a [REDACTED] b",
    );
  });
});

describe("a secret a token shape only partly covers", () => {
  /** Whether any 6-character-or-longer piece of `secret` is in `out`. */
  const leaks = (out: string, secret: string): boolean => {
    for (let i = 0; i + 6 <= secret.length; i++) if (out.includes(secret.slice(i, i + 6))) return true;
    return false;
  };
  const coding = (text: string, secrets: string[]): string => {
    const [sent] = maskForTransport({
      steps: [{ kind: "said", callId: "s", text, truncated: false }],
      results: [],
    }).steps;
    return stepSummary(sent, secrets);
  };
  const native = (text: string, secrets: string[]): string =>
    stepSummary({ kind: "said", text, truncated: false }, secrets);
  const cases: Array<[string, string, string, string[]]> = [
    [
      "a password in URL credentials",
      "connect postgres://admin:p@ssw0rd-Fake9@db:5432/app now",
      "p@ssw0rd-Fake9",
      ["connect", "now"],
    ],
    [
      "a bearer token followed by more words of the secret",
      "Authorization: Bearer abcdefghijklmnopqrstu horse staple",
      "abcdefghijklmnopqrstu horse staple",
      ["Authorization"],
    ],
    [
      "an AWS secret key value with a longer tail",
      "aws_secret_access_key=AbCdEf1234567890-prod-fake-pw end",
      "AbCdEf1234567890-prod-fake-pw",
      ["end"],
    ],
    [
      "a secret glued after a token prefix",
      "ghp_aaaaaaaaaaaaaaaaaaaaFakeSecretXY99-tail-part ok",
      "FakeSecretXY99-tail-part",
      ["ok"],
    ],
  ];
  for (const [name, text, secret, kept] of cases) {
    it(`leaves no piece of ${name} (coding runs)`, () => {
      const out = coding(text, [secret]);
      expect(leaks(out, secret)).toBe(false);
      for (const word of kept) expect(out).toContain(word);
    });
    it(`leaves no piece of ${name} (native runs)`, () => {
      const out = native(text, [secret]);
      expect(leaks(out, secret)).toBe(false);
      for (const word of kept) expect(out).toContain(word);
    });
  }

  it("leaves a text with no secret in it unchanged", () => {
    const text = "run npm test in src/app and git push origin main";
    expect(coding(text, [FAKE_SECRET])).toBe(text);
    expect(native(text, [FAKE_SECRET])).toBe(text);
  });

  it("keeps ordinary words next to a masked token", () => {
    expect(coding(`use ${FAKE_TOKEN} production-deploy now`, [FAKE_SECRET])).toBe(
      "use [REDACTED] production-deploy now",
    );
  });

  it("reuses one batch's forms, and still sees a value added to the same array later", () => {
    const values = [FAKE_SECRET];
    expect(secretForms(values)).toBe(secretForms(values));
    values.push("other-Fake-value-2");
    expect(native("x other-Fake-value-2 y", values)).toBe("x [REDACTED] y");
  });

  it("hands out frozen forms, so a caller can't change the cached list", () => {
    const values = [FAKE_SECRET];
    const forms = secretForms(values) as string[];
    expect(() => forms.push("x")).toThrow(TypeError);
    expect(secretForms(values)).toContain(FAKE_SECRET);
  });

  describe("bounded cost", () => {
    // Deterministic pseudo-random hex, so the test never depends on Math.random.
    let seed = 7;
    const hex = (n: number): string =>
      Array.from({ length: n }, () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return "0123456789abcdef"[seed >>> 28];
      }).join("");
    const secrets = Array.from({ length: 200 }, () => hex(4096));
    const markers = (count: number): string =>
      Array.from({ length: count }, () => `${REDACTED_TEXT}${hex(1)}`).join("");

    it("masks the whole summary when the text holds more than 64 markers", () => {
      const out = native(`x ${markers(MAX_MARKERS_CHECKED + 1)}`, [FAKE_SECRET]);
      expect(out).toBe(REDACTED_TEXT);
    });

    const said = (text: string) => ({ kind: "said" as const, text, truncated: false });

    it("checks 64 markers against 200 secrets of 4 KiB with little work", () => {
      const summarize = stepSummarizer(secrets); // one batch: forms and index built once
      summarize(said(`warm-up ${REDACTED_TEXT} builds-the-index`));
      const before = summaryCacheStats();
      summarize(said(markers(MAX_MARKERS_CHECKED)));
      const after = summaryCacheStats();
      expect(after.work - before.work).toBeLessThan(10_000);
      expect(after.indexBuilds).toBe(before.indexBuilds);
    });

    it("gives up on a text of literal markers without checking them", () => {
      const before = summaryCacheStats();
      const text = markers(1500).slice(0, MAX_STEP_TEXT_CHARS);
      expect(stepSummary({ kind: "tool", text, truncated: false }, secrets)).toBe(REDACTED_TEXT);
      const after = summaryCacheStats();
      expect(after.markerCapStops).toBe(before.markerCapStops + 1);
      expect(after.work).toBe(before.work);
    });

    it("gives up partway through one marker when self-similar secrets make the walk long", () => {
      const similar = Array.from({ length: 200 }, (_, i) => `${"a".repeat(4000)}Z${String(i).padStart(4, "q")}`);
      const summarize = stepSummarizer(similar);
      const before = summaryCacheStats();
      expect(summarize(said(`${REDACTED_TEXT}${"a".repeat(4000)}Q tail`))).toBe(REDACTED_TEXT);
      const after = summaryCacheStats();
      expect(after.workStops).toBe(before.workStops + 1);
      // Stopped at the budget, not after the marker's whole walk.
      expect(after.work - before.work).toBeLessThan(4_100_000);
    });

    it("reuses one agent's cached forms across runs with different extra values", () => {
      const own = ["agent-Fake-secret-1", "agent-Fake-secret-2"];
      const before = summaryCacheStats();
      for (const run of [1, 2, 3]) {
        const capability = `cap-run-${run}-FakeCapability`;
        const out = stepSummarizer([...own], [capability])(said(`use ${own[0]} and ${capability} [REDACTED]x`));
        expect(out).toBe("use [REDACTED] and [REDACTED] [REDACTED]x");
      }
      expect(summaryCacheStats().formBuilds).toBe(before.formBuilds + 1);
    });

    it("does not keep a values list whose index is over the memory bound", () => {
      const huge = Array.from({ length: 200 }, () => hex(4096));
      const step = said(`before-text ${REDACTED_TEXT} after-text-here`);
      stepSummary(step, huge);
      const first = summaryCacheStats();
      expect(first.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      stepSummary(step, huge);
      expect(summaryCacheStats().indexBuilds).toBe(first.indexBuilds + 1);
    });
  });

  it("redacts a secret written JSON-escaped", () => {
    const secret = 'qu"ote-Fake1';
    const out = native('echo "{\\"pw\\":\\"qu\\"ote-Fake1\\"}"', [secret]);
    expect(out).toBe('echo "{\\"pw\\":\\"[REDACTED]\\"}"');
    expect(leaks(out, secret)).toBe(false);
  });
});
