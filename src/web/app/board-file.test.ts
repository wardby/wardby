// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { boardIdFor, newBoardFile, parseBoardFile, serializeBoardFile } from "./board-file.js";

const stored =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Home</title>\n' +
  "<style data-wardby-base>body{--x:#fff}.a{color:red}</style>\n<style data-wardby-edits>.a{color:blue}</style>\n" +
  '</head>\n<body class="b"><p class="a">Hi</p></body>\n</html>\n';

describe("board files", () => {
  it("splits base CSS, edits CSS and the body", () => {
    const p = parseBoardFile(stored);
    expect(p).toMatchObject({
      lang: "en",
      title: "Home",
      baseCss: "body{--x:#fff}.a{color:red}",
      editsCss: ".a{color:blue}",
      bodyAttrs: { class: "b" },
    });
    expect(p.bodyHtml).toBe('<p class="a">Hi</p>');
  });
  it("drops data-gjs-* attributes, which GrapesJS would read as component properties", () => {
    const p = parseBoardFile(
      '<html><body data-gjs-type="text"><p data-gjs-name="&lt;img src=x&gt;" DATA-GJS-EDITABLE="true" class="a">Hi</p></body></html>',
    );
    expect(p.bodyHtml).toBe('<p class="a">Hi</p>');
  });
  it("treats every style of an unmarked board as base", () => {
    expect(parseBoardFile("<html><head><style>a{}</style><style>b{}</style></head><body></body></html>").baseCss).toBe(
      "a{}\nb{}",
    );
  });
  it("writes the base unchanged and the editor's CSS as edits", () => {
    const out = serializeBoardFile(parseBoardFile(stored), ".a{color:green}", '<p class="a">Hello</p>');
    expect(out).toContain("<style data-wardby-base>body{--x:#fff}.a{color:red}</style>");
    expect(out).toContain("<style data-wardby-edits>.a{color:green}</style>");
    expect(out).toContain('<body class="b"><p class="a">Hello</p></body>');
  });
});

describe("new boards", () => {
  it("names ids from board names, unique with -2, -3", () => {
    expect(boardIdFor("Opening Hours!", [])).toBe("opening-hours");
    expect(boardIdFor("Menu", ["menu", "menu-2"])).toBe("menu-3");
    expect(boardIdFor("☕", [])).toBe("board");
    expect(boardIdFor("x".repeat(80), [])).toMatch(/^x{34}$/);
  });
  it("starts with the first board's CSS and header, then a heading with its name", () => {
    const out = parseBoardFile(
      newBoardFile(parseBoardFile(stored.replace("<p", '<header class="site">Nav</header><p')), "Events <b>"),
    );
    expect(out.baseCss).toBe("body{--x:#fff}.a{color:red}");
    expect(out.editsCss).toBe(".a{color:blue}");
    expect(out.bodyHtml).toBe('<header class="site">Nav</header><main><h1>Events &lt;b&gt;</h1></main>');
    expect(out.title).toBe("Events <b>");
  });
});
