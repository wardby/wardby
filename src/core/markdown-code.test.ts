import { describe, expect, it } from "vitest";
import { withoutMarkdownCode } from "./markdown-code.js";

const hasMention = (markdown: string) => /@wardby/.test(withoutMarkdownCode(markdown));

describe("withoutMarkdownCode", () => {
  it("removes inline code spans, including longer backtick runs", () => {
    expect(hasMention("a comment mentioning `@wardby` continues the work")).toBe(false);
    expect(hasMention("use ``@wardby `review` `` to re-review")).toBe(false);
    expect(hasMention("`@wardby`@wardby")).toBe(true);
    expect(hasMention("`code` then @wardby please fix")).toBe(true);
  });

  it("keeps an unmatched backtick literal, and spans never cross a blank line", () => {
    expect(hasMention("a stray ` then @wardby hi")).toBe(true);
    expect(hasMention("open `span\n\n@wardby hi `close")).toBe(true);
    expect(hasMention("span `across\n@wardby` one paragraph")).toBe(false);
  });

  it("removes fenced code blocks with backticks or tildes, unclosed ones to the end", () => {
    expect(hasMention("Example:\n\n```\n@wardby please fix\n```\n")).toBe(false);
    expect(hasMention("~~~md\n@wardby hi\n~~~")).toBe(false);
    expect(hasMention("````\n```\n@wardby\n```\n````")).toBe(false);
    expect(hasMention("```\n@wardby never closed")).toBe(false);
    expect(hasMention("```\nquoted\n```\n@wardby please fix")).toBe(true);
  });

  it("removes indented code after a blank line, but not a paragraph's or a list item's continuation", () => {
    expect(hasMention("Run:\n\n    @wardby review\n")).toBe(false);
    expect(hasMention("\t@wardby review")).toBe(false);
    expect(hasMention("A paragraph\n    @wardby continues it")).toBe(true);
    expect(hasMention("- item\n\n    @wardby inside the item")).toBe(true);
  });

  it("leaves text without code unchanged", () => {
    const text = "Hi @wardby, please add a joke.\n\nThanks!";
    expect(withoutMarkdownCode(text)).toBe(text);
  });
});
