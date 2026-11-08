import { describe, expect, it } from "vitest";
import {
  bounded,
  displayToolName,
  secretForms,
  stepSummarizer,
  stepSummary,
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

/** Whether any 6-character-or-longer piece of `secret` is in `out`. */
const leaks = (out: string, secret: string): string | undefined => {
  for (let i = 0; i + 6 <= secret.length; i++) if (out.includes(secret.slice(i, i + 6))) return secret.slice(i, i + 6);
  return undefined;
};

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
    expect(stepSummary(tool(`deploy --key ${FAKE_SECRET.slice(0, 12)}`, true), [FAKE_SECRET])).toBe(
      "deploy --key [REDACTED]",
    );
    // Below the minimum length a start is too likely to be ordinary text.
    expect(stepSummary(tool(`x ${FAKE_SECRET.slice(0, 5)}`, true), [FAKE_SECRET])).toBe(`x ${FAKE_SECRET.slice(0, 5)}`);
    // Every text is checked, marked cut or not: a stream can stop mid-secret without saying so.
    expect(stepSummary(tool(`deploy --key ${FAKE_SECRET.slice(0, 12)}`), [FAKE_SECRET])).toBe(
      "deploy --key [REDACTED]",
    );
  });

  it("masks the longest secret start at the end across all secret values", () => {
    const a = "abcdefgh";
    const b = "LONGPREFIX12345abcdefgh";
    expect(stepSummary(tool("x LONGPREFIX12345abcdefg", true), [a, b])).toBe("x [REDACTED]");
    expect(stepSummary(tool("x LONGPREFIX12345abcdefg", true), [b, a])).toBe("x [REDACTED]");
  });

  it("masks a secret start longer than 4 KiB at the end of a cut text", () => {
    const long = `wbLong-${"Q7x".repeat(2000)}-fakeEnd`;
    const out = stepSummary(tool(`run ${long.slice(0, 5000)}`, true), [long]);
    expect(out).toBe("run [REDACTED]");
  });

  it("leaves no secret fragment when the summary cut falls inside a secret", () => {
    const toolOut = stepSummary(tool(`${"a".repeat(90)} ${FAKE_SECRET}`), [FAKE_SECRET]);
    expect(toolOut).toContain("[REDACTED]".slice(0, 5));
    expect(leaks(toolOut, FAKE_SECRET)).toBeUndefined();
    const saidOut = stepSummary(said(`${"b".repeat(110)} ${FAKE_SECRET}`), [FAKE_SECRET]);
    expect(leaks(saidOut, FAKE_SECRET)).toBeUndefined();
  });

  it("leaves no secret fragment when the 16 KiB cut falls inside a secret and whitespace collapses", () => {
    const text = `${" ".repeat(MAX_STEP_TEXT_CHARS - 12)}${FAKE_SECRET}`;
    expect(text.length).toBeGreaterThan(MAX_STEP_TEXT_CHARS);
    const out = stepSummary(tool(text), [FAKE_SECRET]);
    expect(out).toBe("[REDACTED]");
  });

  it("keeps the leading summary of a cut text with no secret in it, and an empty cut text empty", () => {
    const text = "npm test --filter app ".repeat(800);
    expect(text.length).toBeGreaterThan(MAX_STEP_TEXT_CHARS);
    expect(stepSummary(tool(text), [FAKE_SECRET])).toBe(stepSummary(tool(text.slice(0, 2000)), [FAKE_SECRET]));
    expect(stepSummary(tool("", true), [FAKE_SECRET])).toBe("");
  });

  it("leaves a text with no secret in it unchanged, and keeps words next to a masked token", () => {
    const text = "run npm test in src/app and git push origin main";
    expect(stepSummary(said(text), [FAKE_SECRET])).toBe(text);
    expect(stepSummary(said(`use ${FAKE_TOKEN} production-deploy now`), [FAKE_SECRET])).toBe(
      "use [REDACTED] production-deploy now",
    );
  });

  it("builds every form of a value once: as written, collapsed and JSON-escaped, longest first", () => {
    expect(secretForms(['a  "b"'])).toEqual([
      'a  \\\\\\"b\\\\\\"',
      'a \\\\\\"b\\\\\\"',
      'a  \\"b\\"',
      'a \\"b\\"',
      'a  "b"',
      'a "b"',
    ]);
    const summarize = stepSummarizer([FAKE_SECRET]);
    expect(summarize(said(`x ${FAKE_SECRET} y`))).toBe("x [REDACTED] y");
    expect(summarize(tool(`x ${FAKE_SECRET.slice(0, 10)}`, true))).toBe("x [REDACTED]");
  });

  it("bounds text at 16 KiB", () => {
    expect(bounded("z".repeat(MAX_STEP_TEXT_CHARS + 1))).toEqual({
      text: "z".repeat(MAX_STEP_TEXT_CHARS),
      truncated: true,
    });
  });
});

/**
 * Every leak case found in review, on raw step text (as both native and coding runs hand it to the
 * writer), for tool and said steps, with the secret as the agent's own value or as a run's extra
 * value after the agent's. Each asserts no 6-character piece of the secret survives.
 */
describe("leak cases", () => {
  const OWN = "agent-Own-Fake-secret-77";
  const T = FAKE_TOKEN;
  const INNER = `Fq8-Mid-Section-Value-Zz9 ghp_${"b".repeat(36)}-tailEndFakeVal`;
  const CAP = "wbcap_FAKErunCapability0123456789-xyzQ";
  const HEAD = "npm run build in packages/app";
  const P = "correct horse battery staple";
  // [name, text, secrets, cut, words kept]
  const cases: Array<[string, string, string[], boolean, string[]]> = [
    ["a passphrase with other whitespace", "pass is correct  horse\nbattery staple ok", [P], false, ["pass is", "ok"]],
    [
      "a passphrase whose word is itself a secret",
      "pass is correct  horse\nbattery staple ok",
      [P, "battery"],
      false,
      ["ok"],
    ],
    [
      "a passphrase holding a token-shaped word",
      `use correct  horse ${T}\nstaple now`,
      [`correct horse ${T} staple`],
      false,
      ["now"],
    ],
    [
      "a value with its own odd whitespace",
      "echo correct horse battery staple",
      ["correct  horse\nbattery staple"],
      false,
      ["echo"],
    ],
    ["edge tabs and newlines", "pw is hunter22\tfake\n\nvalue ok", ["\n hunter22 fake\tvalue \t"], false, ["ok"]],
    ["a non-breaking space", "pw hunter22\u00a0fake value", ["hunter22 fake value"], false, ["pw"]],
    [
      "a prefix of another secret",
      "use abcdefgh-long-secret-xyz and abcdefgh",
      ["abcdefgh", "abcdefgh-long-secret-xyz"],
      false,
      ["use", "and"],
    ],
    [
      "nested secrets",
      "x outer-AAA-inner-BBB-outer y",
      ["inner-BBB", "outer-AAA-inner-BBB-outer", "AAA-inner"],
      false,
      ["x", "y"],
    ],
    [
      "a password in a DSN",
      "connect postgres://admin:p@ssw0rd-Fake9@db:5432/app now",
      ["p@ssw0rd-Fake9"],
      false,
      ["connect", "now"],
    ],
    [
      "a bearer token followed by more words",
      "curl -H 'Authorization: Bearer abcdefghijklmnopqrstu horse staple' x",
      ["abcdefghijklmnopqrstu horse staple"],
      false,
      ["Authorization"],
    ],
    [
      "an AWS secret key with a longer tail",
      "aws_secret_access_key=AbCdEf1234567890-prod-fake-pw end",
      ["AbCdEf1234567890-prod-fake-pw"],
      false,
      ["end"],
    ],
    [
      "a secret glued after ghp_",
      "ghp_aaaaaaaaaaaaaaaaaaaaFakeSecretXY99-tail-part ok",
      ["FakeSecretXY99-tail-part"],
      false,
      ["ok"],
    ],
    [
      "a secret after a token-prefix lookalike",
      "xsk-ant-abcdefghijklmnopqrst-and-more words",
      ["sk-ant-abcdefghijklmnopqrst-and-more"],
      false,
      ["words"],
    ],
    ["a token word at the start of a passphrase", `pass ${T} horse battery ok`, [`${T} horse battery`], false, ["ok"]],
    ["a token word at the end of a passphrase", `pass horse battery ${T} ok`, [`horse battery ${T}`], false, ["ok"]],
    ["a JSON-escaped secret", 'echo "{\\"pw\\":\\"qu\\"ote-Fake1\\"}"', ['qu"ote-Fake1'], false, ["echo"]],
    ["regex specials", "run a.*+?^${}()|[]\\b-Fake end", ["a.*+?^${}()|[]\\b-Fake"], false, ["run", "end"]],
    [
      "a cut secret: head present, tail cut",
      `deploy --key ${FAKE_SECRET.slice(0, 12)}`,
      [FAKE_SECRET],
      true,
      ["deploy --key"],
    ],
    ["a cut passphrase with other whitespace", "unlock correct  horse\nbatt", [P, "battery"], true, ["unlock"]],
    [
      "a cut passphrase inside a token-shaped word",
      `unlock correct horse ${T.slice(0, 12)}`,
      [`correct horse ${T} staple`],
      true,
      ["unlock"],
    ],
    [
      "a cut secret with an inner token (probe12)",
      `${HEAD}\n\nrun ghp_${"a".repeat(20)}${INNER.slice(0, -6)}`,
      [INNER],
      true,
      [HEAD],
    ],
    [
      "a cut secret inside its inner token (probe12)",
      `run ghp_${"a".repeat(20)}${INNER.slice(0, 64)}`,
      [INNER],
      true,
      ["run"],
    ],
    ["a cut secret glued after ghp_ (probe9c)", `ghp_${"a".repeat(20)}${CAP.slice(0, 24)}`, [CAP], true, []],
    [
      "a cut secret behind URL credentials (probe12)",
      "connect https://user:pAss-Fake:word/with-slash-and",
      ["pAss-Fake:word/with-slash-and-more-chars"],
      true,
      ["connect"],
    ],
    [
      "a cut secret starting with userinfo (probe14)",
      "git clone h://u:p@Kz6FakePieceHeadxxyyzz-more-fa",
      ["u:p@Kz6FakePieceHeadxxyyzz-more-fake"],
      true,
      ["git clone"],
    ],
    [
      "a cut secret overlapping a whole one",
      "x XXXXXXXX-secretB-Fake",
      ["XXXXXXXX-secretB-Fake", "secretB-Fake-and-more"],
      true,
      ["x"],
    ],
    ["a secret ending exactly at the cut", `${HEAD}\n\nexport KEY=${CAP}`, [CAP], true, [HEAD]],
  ];
  // probe16: a crossing secret written with other whitespace.
  const S16 = `Fq8-Mid-Section-Value-Zz9 ghp_${"b".repeat(36)} tailEndFakeVal`;
  const written16 = S16.replace(" tail", `${"\n".repeat(500)}tail`);
  cases.push([
    "a cut secret with other whitespace (probe16)",
    `run ghp_${"a".repeat(20)}${written16.slice(0, -6)}`,
    [S16],
    true,
    ["run"],
  ]);
  cases.push([
    "a cut secret with other whitespace, no glued head (probe16)",
    `run ${written16.slice(0, -6)}`,
    [S16],
    true,
    ["run"],
  ]);

  for (const [name, text, secrets, truncated, kept] of cases) {
    for (const kind of ["tool", "said"] as const) {
      for (const [whose, values] of [
        ["own", secrets],
        ["extra", [OWN, ...secrets]],
      ] as const) {
        it(`${name} (${kind}, ${whose} value)`, () => {
          const out = stepSummary({ kind, text, truncated }, values);
          for (const secret of secrets) {
            if (secret.length > 6) expect(leaks(out, secret.trim()), out).toBeUndefined();
          }
          expect(out).toContain("[REDACTED]");
          for (const word of kept) expect(out).toContain(word);
        });
      }
    }
  }

  // probe14/15: a whole secret followed by filler, in a text marked cut, at many filler lengths.
  it("masks a whole secret followed by any amount of filler in a cut text", () => {
    for (let f = 40; f <= 200; f++) {
      const text = `deploy${"\n".repeat(300)}run ghp_${"a".repeat(20)}${INNER}${"x".repeat(f)}${"\n".repeat(50)}`;
      for (const kind of ["tool", "said"] as const) {
        const out = stepSummary({ kind, text, truncated: true }, [OWN, INNER]);
        expect(leaks(out, INNER), `f=${f} ${out}`).toBeUndefined();
      }
    }
  });
});

/** Leaks in how step text is extracted and flagged, found in review (fake values). */
describe("extraction leak cases", () => {
  const OWN = "agent-Own-Fake-secret-77";
  const both = (secret: string) =>
    [
      ["own", [secret]],
      ["extra", [OWN, secret]],
    ] as const;

  it("masks a secret start at the end of a step not marked cut (a stream that stopped early)", () => {
    const S = "FaKeSeCrEt-9x7Q2mZ4pL";
    for (const [whose, values] of both(S)) {
      for (const kind of ["said", "tool"] as const) {
        const out = stepSummary({ kind, text: `The key is ${S.slice(0, 14)}`, truncated: false }, values);
        expect(out, `${kind} ${whose}`).toBe("The key is [REDACTED]");
      }
    }
  });

  it("marks a free-form input cut when later lines are dropped, so a multi-line secret's first line is masked", () => {
    const M = "FAKE_USER=alice-Q9z\nFAKE_PASS=pw-7731xyz";
    const patch = toolStepText("apply_patch", JSON.stringify({ input: `${M}\nmore` }));
    expect(patch).toEqual({ text: "FAKE_USER=alice-Q9z", truncated: true });
    const echoed = toolStepText("apply_patch", JSON.stringify({ input: `echo ${M}` }));
    const plain = toolStepText("custom", JSON.stringify(`${M}\nrest`));
    expect(plain.truncated).toBe(true);
    expect(toolStepText("custom", JSON.stringify("one line\n\n  "))).toEqual({ text: "one line", truncated: false });
    for (const [whose, values] of both(M)) {
      for (const step of [patch, echoed, plain]) {
        const out = stepSummary({ kind: "tool", ...step }, values);
        expect(leaks(out, "FAKE_USER=alice-Q9z"), `${whose} ${out}`).toBeUndefined();
        expect(leaks(out, "FAKE_PASS=pw-7731xyz")).toBeUndefined();
      }
    }
  });

  it("decodes cut-off JSON whose end is an escaped backslash or a partial \\u escape", () => {
    for (const secret of ["Fake/Slash-Secret-77", "Fäke-Ümlaut-Secret-77"]) {
      const encoded = secret.replace(/\//g, "\\/").replace(/[^ -~]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`);
      for (const end of ["\\u00", "\\\\", "\\"]) {
        const step = toolStepText("Bash", `{"command":"curl -u ${encoded} x${end}`);
        expect(step.truncated).toBe(true);
        for (const [whose, values] of both(secret)) {
          const out = stepSummary({ kind: "tool", ...step }, values);
          expect(out, `${whose} ${end}`).toMatch(/^curl -u \[REDACTED\] x\\?$/);
        }
      }
    }
    expect(toolStepText("Bash", '{"command":"echo a\\\\').text).toBe("echo a\\");
    expect(toolStepText("Bash", '{"command":"echo a\\u00e').text).toBe("echo a");
  });

  it("shows only the marker for a cut-off field that still won't decode", () => {
    // A raw control character is not valid inside a JSON string.
    expect(toolStepText("Bash", '{"command":"echo Fake\\/Secret\tvalue')).toEqual({
      text: "[REDACTED]",
      truncated: true,
    });
  });
});

describe("cost", () => {
  // Deterministic pseudo-random hex, so the test never depends on Math.random.
  let seed = 7;
  const hex = (n: number): string =>
    Array.from({ length: n }, () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return "0123456789abcdef"[seed >>> 28];
    }).join("");
  const secrets = Array.from({ length: 200 }, () => hex(4096));

  it("handles a 16 KiB flood of literal markers against 200 secrets of 4 KiB, cut or not", () => {
    const text = Array.from({ length: 1500 }, () => `${REDACTED_TEXT}${hex(1)}`)
      .join("")
      .slice(0, MAX_STEP_TEXT_CHARS);
    const summarize = stepSummarizer(secrets);
    const started = performance.now();
    for (const truncated of [false, true]) {
      const out = summarize({ kind: "tool", text, truncated });
      expect(out.startsWith(REDACTED_TEXT)).toBe(true);
    }
    // Generous for a loaded CI machine; it runs in a few milliseconds.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("stays linear on self-similar secrets at the end of a cut text", () => {
    const similar = Array.from({ length: 200 }, (_, i) => `${"a".repeat(8000)}Z${"a".repeat(8000)}${i}`);
    const started = performance.now();
    expect(stepSummary({ kind: "tool", text: "a".repeat(MAX_STEP_TEXT_CHARS), truncated: true }, similar)).toBe(
      REDACTED_TEXT,
    );
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
