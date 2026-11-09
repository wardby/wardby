import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripControlSequences } from "./control-chars.js";

const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;

describe("stripControlSequences", () => {
  it("removes an OSC 52 clipboard write, ended by BEL or by ST", () => {
    expect(stripControlSequences(`a${ESC}]52;c;ZmFrZS1jbGlwYm9hcmQ=${BEL}b`)).toBe("ab");
    expect(stripControlSequences(`a${ESC}]52;c;ZmFrZS1jbGlwYm9hcmQ=${ST}b`)).toBe("ab");
  });

  it("removes an OSC 8 link, keeping only its visible text", () => {
    expect(stripControlSequences(`${ESC}]8;;https://example.invalid/x${BEL}click${ESC}]8;;${BEL} here`)).toBe(
      "click here",
    );
    expect(stripControlSequences(`${ESC}]8;;https://example.invalid/x${ST}click${ESC}]8;;${ST}`)).toBe("click");
  });

  it("removes colour codes and other CSI sequences, 7-bit and C1", () => {
    expect(stripControlSequences(`${ESC}[1;31merror${ESC}[0m: ${ESC}[38;5;208mwarn${ESC}[m`)).toBe("error: warn");
    expect(stripControlSequences(`${ESC}[2J${ESC}[H${ESC}[?25lcleared\u009b31mred`)).toBe("clearedred");
  });

  it("removes a title change, a DCS string and two-character escapes", () => {
    expect(stripControlSequences(`${ESC}]0;fake title${BEL}${ESC}Pq#0${ST}${ESC}7${ESC}(Bok${ESC}8`)).toBe("ok");
  });

  it("removes every other C0 and C1 control character except line breaks and tabs", () => {
    let controls = "";
    for (let code = 0; code < 0x20; code++) controls += String.fromCharCode(code);
    for (let code = 0x7f; code < 0xa0; code++) controls += String.fromCharCode(code);
    expect(stripControlSequences(`x${controls}y`)).toBe("x\t\ny");
  });

  it("turns \\r\\n into \\n and drops a lone \\r", () => {
    expect(stripControlSequences("one\r\ntwo\rthree\r\n")).toBe("one\ntwothree\n");
  });

  it("leaves an unterminated string's payload as plain text, without its introducer", () => {
    expect(stripControlSequences(`a${ESC}]8;;https://example.invalid`)).toBe("a8;;https://example.invalid");
  });

  it("keeps plain text, Unicode included, exactly", () => {
    const text = "plain\ttext\nwith ünïcödé, emoji 🙂 and … ellipsis";
    expect(stripControlSequences(text)).toBe(text);
  });
});

describe("the run pane's copy (plugins/claude-code, which cannot import src/)", () => {
  it("uses the same four patterns", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const source = read("./control-chars.ts");
    const pane = read("../../../plugins/claude-code/hooks/register.tsx");
    const patterns = [...source.matchAll(/^const [A-Z_]+ = \/.*\/g;$/gm)].map((m) => m[0]);
    expect(patterns).toHaveLength(4);
    for (const pattern of patterns) expect(pane).toContain(pattern);
  });
});
