import { describe, expect, it } from "vitest";
import { collapseWithMap, joinDetail, stepDetailer } from "./detail.js";
import { collapseWhitespace, stepSummarizer } from "./summarize.js";
import {
  DETAIL_INPUT_CHARS,
  DETAIL_OUTPUT_CHARS,
  DETAIL_OUTPUT_HEADING,
  DETAIL_SAID_CHARS,
  MAX_RESULT_OUTPUT_CHARS,
  MAX_STEP_DETAIL_CHARS,
  MAX_STEP_TEXT_CHARS,
  tailOf,
} from "./types.js";

// Fake values only: never real credentials.
const FAKE_SECRET = "wbFake-Secret-Value-7f3a91";
const FAKE_MULTILINE = "wbFake-line-one-4c2d\nwbFake-line-two-9e1b";
const FAKE_CAPABILITY = `rrp_${"F".repeat(43)}`;
const FAKE_TOKEN = "ghp_FAKEfakeFAKEfake0123456789abcd";
/** A per-run value the agent's own secrets do not cover (as the writer's extraSecretValues). */
const FAKE_EXTRA = "wbFake-run-extra-0d5e88c1";
const REDACTED_TEXT = "[REDACTED]";

const tool = (input: string, truncated = false) =>
  ({
    kind: "tool",
    callId: "c1",
    tool: "Bash",
    text: "x",
    truncated: false,
    input,
    inputTruncated: truncated,
  }) as const;
const said = (text: string) => ({ kind: "said", callId: "said:1", text, truncated: false }) as const;

/** Every 6-character window of `secret`, as written and whitespace-collapsed. */
function fragments(secret: string): string[] {
  const out = new Set<string>();
  for (const form of [secret, collapseWhitespace(secret)]) {
    for (let i = 0; i + 6 <= form.length; i++) out.add(form.slice(i, i + 6));
  }
  return [...out];
}

/** Asserts no 6-character fragment of any secret survives in `text`. */
function expectNoFragment(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    for (const fragment of fragments(secret)) {
      if (text.includes(fragment)) throw new Error(`fragment ${JSON.stringify(fragment)} survived`);
    }
  }
}

describe("stepDetailer", () => {
  const detail = stepDetailer([FAKE_SECRET, FAKE_MULTILINE, FAKE_CAPABILITY]);
  const all = [FAKE_SECRET, FAKE_MULTILINE, FAKE_CAPABILITY];

  it("removes every secret value from a tool input, keeping its lines", () => {
    const out = detail.step(tool(`{"command":"curl -H 'X: ${FAKE_SECRET}' \\\n https://example.invalid"}`));
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("\n");
  });

  it("removes a JSON-escaped multi-line secret and one written with other whitespace", () => {
    const escaped = JSON.stringify({ key: FAKE_MULTILINE });
    expect(detail.step(tool(escaped))).not.toMatch(/wbFake-line-(one|two)/);
    const respaced = "said:\n wbFake-line-one-4c2d   \t wbFake-line-two-9e1b\n";
    const out = detail.step({ kind: "said", callId: "said:1", text: respaced, truncated: false });
    expect(out).not.toMatch(/wbFake-line-(one|two)/);
    expect(out.startsWith("said:\n")).toBe(true);
  });

  it("masks token shapes and the run's capability", () => {
    const out = detail.step(tool(`echo ${FAKE_TOKEN} ${FAKE_CAPABILITY}`));
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).not.toContain(FAKE_CAPABILITY);
  });

  it("redacts before the cut: a secret across the input bound leaves nothing of it", () => {
    const input = `${"a".repeat(DETAIL_INPUT_CHARS - 10)}${FAKE_SECRET}${"b".repeat(100)}`;
    const out = detail.step(tool(input));
    expect(out.length).toBeLessThanOrEqual(DETAIL_INPUT_CHARS);
    expect(out).not.toContain(FAKE_SECRET.slice(0, 6));
    expect(out.endsWith("…")).toBe(true);
    expectNoFragment(out, all);
  });

  it("masks a secret's start at the end of a cut input (the tail check)", () => {
    const out = detail.step(tool(`token=${FAKE_SECRET.slice(0, 14)}`, true));
    expect(out).not.toContain(FAKE_SECRET.slice(0, 14));
    expect(out).toBe(`token=${REDACTED_TEXT}`);
  });

  it("masks a secret's start at the end of a text not marked cut (a stream that stopped early)", () => {
    expect(detail.step(said(`ends with ${FAKE_SECRET.slice(0, 9)}`))).toBe(`ends with ${REDACTED_TEXT}`);
    // A multi-line secret's start, written with other whitespace, at the end.
    const out = detail.step(said("ends with\nwbFake-line-one-4c2d \n  wbFake-li"));
    expect(out).toBe(`ends with\n${REDACTED_TEXT}`);
  });

  it("cuts a said step to DETAIL_SAID_CHARS, after redaction", () => {
    const text = `${FAKE_SECRET} ${"x".repeat(DETAIL_SAID_CHARS * 2)}`;
    const out = detail.step({ kind: "said", callId: "said:1", text, truncated: false });
    expect(out.length).toBeLessThanOrEqual(DETAIL_SAID_CHARS);
    expect(out).not.toContain(FAKE_SECRET);
  });

  it("a said step cut across a secret at the 8 KiB bound leaves nothing of it", () => {
    const text = `${"x".repeat(DETAIL_SAID_CHARS - 12)}${FAKE_MULTILINE}${"y".repeat(50)}`;
    const out = detail.step(said(text));
    expect(out.length).toBeLessThanOrEqual(DETAIL_SAID_CHARS);
    expectNoFragment(out, all);
  });

  it("uses a tool's summary text when no input was sent", () => {
    const out = detail.step({
      kind: "tool",
      callId: "c1",
      tool: "Bash",
      text: `echo ${FAKE_SECRET}`,
      truncated: false,
    });
    expect(out).toBe(`echo ${REDACTED_TEXT}`);
  });

  it("keeps the end of a tool's output, redacted, with the heading", () => {
    const output = `${"line\n".repeat(2000)}${FAKE_SECRET}\nexit 1`;
    const out = detail.output({ output, outputCut: true });
    expect(out.startsWith(DETAIL_OUTPUT_HEADING)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(DETAIL_OUTPUT_HEADING.length + DETAIL_OUTPUT_CHARS);
    expect(out).not.toContain(FAKE_SECRET);
    expect(out.endsWith("exit 1")).toBe(true);
  });

  it("masks a secret's end at the start of an output whose head was cut (the head check)", () => {
    const out = detail.output({ output: `${FAKE_SECRET.slice(-14)} done\nnext`, outputCut: true });
    expect(out).not.toContain(FAKE_SECRET.slice(-14));
    // The partial first line is dropped; only the cut marker stands in for it.
    expect(out).toBe(`${DETAIL_OUTPUT_HEADING}…next`);
    // With no line break after the cut, nothing but the marker is shown.
    expect(detail.output({ output: `${FAKE_SECRET.slice(-14)} done`, outputCut: true })).toBe(
      `${DETAIL_OUTPUT_HEADING}…`,
    );
  });

  it("the head check finds a multi-line secret's end written with other whitespace", () => {
    const out = detail.output({ output: "-4c2d \t\n wbFake-line-two-9e1b\nok", outputCut: true });
    expectNoFragment(out, all);
    expect(out).toBe(`${DETAIL_OUTPUT_HEADING}…ok`);
  });

  it("the head check runs when the source sent more than MAX_RESULT_OUTPUT_CHARS", () => {
    const output = `${FAKE_SECRET}${"q".repeat(MAX_RESULT_OUTPUT_CHARS - 10)}`;
    const out = detail.output({ output, outputCut: false });
    expectNoFragment(out, all);
  });

  it("leaves a secret-like start alone when the output's head was not cut", () => {
    // Without a cut, the text's start is the output's start: a 14-character suffix there is not a secret.
    const out = detail.output({ output: `${FAKE_SECRET.slice(-14)} done`, outputCut: false });
    expect(out).toBe(`${DETAIL_OUTPUT_HEADING}${FAKE_SECRET.slice(-14)} done`);
  });

  it("an output cut by the 2 KB bound across a secret leaves nothing of it", () => {
    const output = `${FAKE_SECRET}${"z".repeat(DETAIL_OUTPUT_CHARS - 8)}`;
    const out = detail.output({ output, outputCut: false });
    expect(out).not.toContain(FAKE_SECRET.slice(-6));
    expectNoFragment(out, all);
  });

  it("masks a secret's start at the end of an output (the tail check)", () => {
    const out = detail.output({ output: `listing\n${FAKE_CAPABILITY.slice(0, 20)}` });
    expect(out).toBe(`${DETAIL_OUTPUT_HEADING}listing\n${REDACTED_TEXT}`);
  });

  it("masks secrets glued to other text and to each other", () => {
    const text = `pre${FAKE_SECRET}${FAKE_CAPABILITY}mid${FAKE_SECRET}${FAKE_SECRET}post`;
    expect(detail.step(said(text))).toBe(`pre${REDACTED_TEXT}mid${REDACTED_TEXT}post`);
    expect(detail.output({ output: text, outputCut: false })).toBe(
      `${DETAIL_OUTPUT_HEADING}pre${REDACTED_TEXT}mid${REDACTED_TEXT}post`,
    );
  });

  it("masks JSON-escaped and double-escaped multi-line secrets in output", () => {
    const once = JSON.stringify({ key: FAKE_MULTILINE });
    const twice = JSON.stringify({ log: once });
    for (const output of [once, twice]) {
      const out = detail.output({ output, outputCut: false });
      expectNoFragment(out, all);
    }
  });

  it("keeps a text with no secret exactly, line breaks and spacing included", () => {
    const text = "line one\n\n  indented two\tand a tab\r\nlast line \n";
    expect(detail.step(said(text))).toBe(text);
    expect(detail.step(tool(text))).toBe(text);
    expect(detail.output({ output: text, outputCut: false })).toBe(`${DETAIL_OUTPUT_HEADING}${text}`);
    // A cut head loses its partial first line only.
    expect(detail.output({ output: text, outputCut: true })).toBe(
      `${DETAIL_OUTPUT_HEADING}…${text.slice(text.indexOf("\n") + 1)}`,
    );
  });

  it("redacts at least what the summary redacts for the same text", () => {
    const summarize = stepSummarizer(all);
    const texts = [
      `a ${FAKE_SECRET} b`,
      "x\nwbFake-line-one-4c2d\n\n\twbFake-line-two-9e1b y",
      JSON.stringify({ k: FAKE_MULTILINE }),
      `tail ${FAKE_SECRET.slice(0, 10)}`,
      `t ${FAKE_TOKEN} Bearer\n  abc.def`,
    ];
    for (const text of texts) {
      expect(summarize({ kind: "said", text, truncated: false })).not.toMatch(/wbFake|ghp_|abc\.def/);
      expect(detail.step(said(text))).not.toMatch(/wbFake|ghp_|abc\.def/);
    }
  });
});

describe("stepDetailer against the agent's values and the run's extras", () => {
  // The writer passes the agent's secret values followed by the run's own (extraSecretValues).
  const own = [FAKE_SECRET];
  const extras = [FAKE_EXTRA, FAKE_CAPABILITY];
  const detail = stepDetailer([...own, ...extras]);

  it("masks both, whole and across each cut", () => {
    expect(detail.step(said(`${FAKE_SECRET} ${FAKE_EXTRA}`))).toBe(`${REDACTED_TEXT} ${REDACTED_TEXT}`);
    expect(detail.step(tool(`x ${FAKE_EXTRA.slice(0, 12)}`, true))).toBe(`x ${REDACTED_TEXT}`);
    expect(detail.output({ output: `${FAKE_EXTRA.slice(-12)} y\nz`, outputCut: true })).toBe(
      `${DETAIL_OUTPUT_HEADING}…z`,
    );
  });
});

describe("collapseWithMap", () => {
  it("collapses exactly as summaries do, mapping each character back to its source", () => {
    for (const text of ["", "   ", " a  b\n\tc ", "a\r\n b", "x"]) {
      const { collapsed, from, to } = collapseWithMap(text);
      expect(collapsed).toBe(collapseWhitespace(text));
      for (let i = 0; i < collapsed.length; i++) {
        const source = text.slice(from[i], to[i]);
        expect(collapsed[i] === " " ? /^\s+$/.test(source) : source === collapsed[i]).toBe(true);
      }
    }
  });
});

describe("joinDetail and tailOf", () => {
  it("appends within the column bound", () => {
    expect(joinDetail("input", "\n\nout")).toBe("input\n\nout");
    expect(joinDetail(null, "out")).toBe("out");
    expect(joinDetail("a".repeat(MAX_STEP_DETAIL_CHARS), "more").length).toBe(MAX_STEP_DETAIL_CHARS);
  });

  it("takes the end of a text", () => {
    expect(tailOf("abcdef", 3)).toEqual({ text: "def", cut: true });
    expect(tailOf("ab", 3)).toEqual({ text: "ab", cut: false });
    expect(tailOf("q".repeat(MAX_RESULT_OUTPUT_CHARS + 1)).text.length).toBe(MAX_RESULT_OUTPUT_CHARS);
  });
});

describe("cost", () => {
  // Deterministic pseudo-random hex, so the test never depends on Math.random.
  let seed = 11;
  const hex = (n: number): string =>
    Array.from({ length: n }, () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return "0123456789abcdef"[seed >>> 28];
    }).join("");
  const secrets = Array.from({ length: 200 }, () => hex(4096));

  it("handles 200 secrets of 4 KiB on a 16 KiB text, at every cut", () => {
    const filler = (n: number) => hex(n).replace(/[0-9]/g, "g");
    // A whole secret first, a secret's start last: the input and said heads, the output's end.
    const text = `${secrets[3]}\n${filler(MAX_STEP_TEXT_CHARS - secrets[3].length - 92)}\n${secrets[7].slice(0, 90)}`;
    // An output whose head was cut inside a secret.
    const output = `${secrets[5].slice(-90)}\n${filler(MAX_RESULT_OUTPUT_CHARS - 91)}`;
    const detail = stepDetailer(secrets);
    const started = performance.now();
    const step = detail.step(said(text));
    const input = detail.step(tool(text, true));
    const tail = detail.output({ output: text, outputCut: true });
    const head = detail.output({ output, outputCut: true });
    const elapsed = performance.now() - started;
    expect(text.length).toBe(MAX_STEP_TEXT_CHARS);
    expect(step.startsWith(`${REDACTED_TEXT}\n`)).toBe(true);
    expect(input.startsWith(`${REDACTED_TEXT}\n`)).toBe(true);
    // The 2 KiB cut lands mid-line in the filler, so that partial line is dropped.
    expect(tail).toBe(`${DETAIL_OUTPUT_HEADING}…${REDACTED_TEXT}`);
    expect(head.startsWith(`${DETAIL_OUTPUT_HEADING}…`)).toBe(true);
    const short = detail.output({ output: output.slice(0, 200), outputCut: true });
    expect(short).toBe(`${DETAIL_OUTPUT_HEADING}…${output.slice(91, 200)}`);
    for (const out of [step, input, tail, head]) expectNoFragment(out, [secrets[3], secrets[5], secrets[7]]);
    console.info(`detail cost: 200 x 4 KiB secrets, 16 KiB text, 4 calls: ${elapsed.toFixed(1)} ms`);
    // Generous for a loaded CI machine; it runs in a few milliseconds.
    expect(elapsed).toBeLessThan(2000);
  });

  it("stays linear on self-similar secrets at both edges of a cut text", () => {
    // Half end in the text's start (the head check), half start with its end (the tail check).
    const similar = Array.from({ length: 200 }, (_, i) =>
      i % 2 ? `${i}${"a".repeat(8000)}Z${"a".repeat(8000)}` : `${"a".repeat(8000)}Z${"a".repeat(8000)}${i}`,
    );
    const detail = stepDetailer(similar);
    const started = performance.now();
    expect(detail.output({ output: "a".repeat(MAX_RESULT_OUTPUT_CHARS), outputCut: true })).toBe(
      `${DETAIL_OUTPUT_HEADING}…`,
    );
    // The longest secret start it ends in is masked wherever it occurs, as summaries mask it.
    expect(detail.step(tool(`${"b".repeat(100)}${"a".repeat(MAX_STEP_TEXT_CHARS - 100)}`, true))).toBe(
      `${"b".repeat(100)}${REDACTED_TEXT}`,
    );
    const elapsed = performance.now() - started;
    console.info(`detail cost: 200 self-similar 16 KiB secrets, both edges: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("cut heads and PEM edges", () => {
  const detail = stepDetailer([FAKE_SECRET]);
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCFAKEFAKEFAKE";
  const pem = `-----BEGIN PRIVATE KEY-----\n${`${body}\n`.repeat(40)}-----END PRIVATE KEY-----\n`;

  it("shows no key body when the output's head cut removed the BEGIN line", () => {
    const out = detail.output({ output: `${pem.slice(100)}after`, outputCut: true });
    expect(out).not.toContain(body);
    expect(out).toBe(`${DETAIL_OUTPUT_HEADING}…after`);
    const spaced = detail.output({ output: `${pem.slice(100)}ok\nnext`, outputCut: true });
    expect(spaced).not.toContain(body);
    expect(spaced).toBe(`${DETAIL_OUTPUT_HEADING}…ok\nnext`);
  });

  it("masks a dangling END from the text's start even when the first line break is inside the key", () => {
    const out = detail.output({ output: `${pem.slice(60)}\nafter`, outputCut: true });
    expect(out).not.toContain(body);
    expect(out).toBe(`${DETAIL_OUTPUT_HEADING}…\nafter`);
  });

  it("masks a BEGIN with no END through the end of an input", () => {
    const input = `cat key\n${pem.slice(0, 600)}`;
    const out = detail.step(tool(input));
    expect(out).not.toContain(body);
    expect(out).toBe(`cat key\n${REDACTED_TEXT}`);
    expect(detail.output({ output: `x\n${pem.slice(0, 600)}`, outputCut: false })).toBe(
      `${DETAIL_OUTPUT_HEADING}x\n${REDACTED_TEXT}`,
    );
  });

  it("shows no AWS secret key value when its label was cut off", () => {
    const line = "aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY";
    const out = detail.output({ output: `${line.slice(10)}\nnext`, outputCut: true });
    expect(out).not.toContain("wJalrXUtnFEMI");
    expect(out).toBe(`${DETAIL_OUTPUT_HEADING}…next`);
  });

  it("shows no URL credentials when the scheme was cut off", () => {
    const out = detail.output({ output: "ser:pa55word@host.invalid/x\nnext", outputCut: true });
    expect(out).not.toContain("pa55word");
    expect(out).toBe(`${DETAIL_OUTPUT_HEADING}…next`);
  });

  it("drops the partial first line after the 2 KiB cut too, within the bound", () => {
    const output = `${"x".repeat(3000)}\nrest one\nrest two`;
    const out = detail.output({ output, outputCut: false });
    expect(out).toBe(`${DETAIL_OUTPUT_HEADING}…rest one\nrest two`);
    const long = detail.output({ output: `${"x".repeat(3000)}`, outputCut: false });
    expect(long).toBe(`${DETAIL_OUTPUT_HEADING}…`);
    const lines = detail.output({ output: "line\n".repeat(1000), outputCut: false });
    expect(lines.length).toBeLessThanOrEqual(DETAIL_OUTPUT_HEADING.length + DETAIL_OUTPUT_CHARS);
  });
});
