// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ElementAnchor } from "../../core/documents/element-anchors.js";
import type { ThreadView } from "./api.js";
import type { BoardsEditor } from "./boards-editor.js";
import { DesignSurface } from "./design-surface.js";
import { quoteClipped } from "./surface.js";

const anchor = (board: string, over: Partial<ElementAnchor> = {}): ElementAnchor => ({
  type: "element",
  board,
  path: "h1:nth-of-type(1)",
  tag: "h1",
  words: "A short list, made well.",
  dx: 0.5,
  dy: 0.5,
  ...over,
});

const thread = (id: string, a: ElementAnchor): ThreadView => ({
  id,
  number: Number(id),
  status: "open",
  sentAt: null,
  anchor: a,
  comments: [],
});

/** A BoardsEditor stand-in: the board in the canvas, its root element, and no canvas frame. */
function setup(root: HTMLElement | null = null) {
  document.body.replaceChildren();
  let current = "home";
  const boards = {
    currentBoard: () => current,
    selectBoard: vi.fn((id: string) => {
      current = id;
    }),
    root: () => root,
    canvasWindow: () => null,
    editor: { Canvas: { getFrameEl: () => null } },
  } as unknown as BoardsEditor;
  const els = {
    pins: document.body.appendChild(document.createElement("div")),
    commentButton: document.createElement("button"),
    boardsList: document.createElement("ul"),
  };
  const names = () =>
    new Map([
      ["home", "Home"],
      ["menu", "Menu"],
    ]);
  let measuring = false;
  const waiting: (() => void)[] = [];
  const whenIdle = (run: () => void) => (measuring ? waiting.push(run) : run());
  const surface = new DesignSurface(boards, els, names, (b) => b, whenIdle);
  return {
    surface,
    boards,
    measure: (on: boolean) => {
      measuring = on;
      if (!on) waiting.splice(0).forEach((run) => run());
    },
  };
}

describe("DesignSurface", () => {
  it("waits for a fidelity pass to end before reveal switches board", () => {
    const { surface, boards, measure } = setup();
    measure(true);
    surface.reveal(thread("1", anchor("menu")));
    expect(boards.selectBoard).not.toHaveBeenCalled();
    expect(boards.currentBoard()).toBe("home");
    measure(false);
    expect(boards.selectBoard).toHaveBeenCalledWith("menu");
    expect(boards.currentBoard()).toBe("menu");
  });

  it("asks the canvas whether a current-board thread is found, with no claim before it loads", () => {
    const root = document.createElement("div");
    root.innerHTML = "<h1>A short list, made well.</h1>";
    const found = thread("1", anchor("home"));
    const lost = thread("2", anchor("home", { path: "h2:nth-of-type(1)", tag: "h2", words: "Gone for good" }));
    const elsewhere = thread("3", anchor("menu"));
    const unloaded = setup(null);
    unloaded.surface.mark({ threads: [found, lost], draft: null, active: null });
    expect(unloaded.surface.located("1")).toBe(true);
    expect(unloaded.surface.located("2")).toBe(true); // the canvas has not loaded: not "outdated"
    const loaded = setup(root);
    loaded.surface.mark({ threads: [found, lost, elsewhere], draft: null, active: null });
    expect(loaded.surface.located("1")).toBe(true);
    expect(loaded.surface.located("2")).toBe(false);
    expect(loaded.surface.located("3")).toBe(true); // another board: the thread's status decides
  });

  it("cuts only the words of a label, so the board name always shows", () => {
    const { surface } = setup();
    const long = thread("1", anchor("menu", { words: "x".repeat(80) }));
    expect(surface.label(long, 40)).toBe(`“${"x".repeat(40)}…” · Menu`);
    expect(surface.label(thread("2", anchor("menu")), 40)).toBe("“A short list, made well.” · Menu");
    expect(surface.label(thread("3", anchor("home", { words: "", tag: "img" })), 40)).toBe("img · Home");
  });

  it("clips quotes the way the document pages did", () => {
    expect(quoteClipped("short", 10)).toBe("“short”");
    expect(quoteClipped("0123456789abc", 10)).toBe("“0123456789…”");
    expect(quoteClipped("0123456789abc")).toBe("“0123456789abc”");
  });
});
