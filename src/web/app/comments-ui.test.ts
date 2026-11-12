// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Api, DocumentPayload, ThreadView } from "./api.js";
import { CommentsUI } from "./comments-ui.js";
import type { AnchorSurface } from "./surface.js";

const thread = (id: string, status = "open"): ThreadView => ({
  id,
  number: Number(id),
  status,
  sentAt: null,
  anchor: { type: "text", quote: `q${id}`, prefix: "", suffix: "" },
  comments: [
    {
      id: `c${id}`,
      author: { kind: "member", name: "Ana" },
      body: "Hi",
      createdAt: new Date().toISOString(),
      editedAt: null,
      mine: true,
    },
  ],
});

function setup(threads: ThreadView[]) {
  let handlers!: Parameters<AnchorSurface["connect"]>[0];
  const surface: AnchorSurface = {
    draft: vi.fn(() => ({ anchor: { type: "text" as const, quote: "new", prefix: "", suffix: "" }, quote: "new" })),
    mark: vi.fn(),
    point: vi.fn(() => ({ x: 10, y: 10 })),
    reveal: vi.fn(),
    label: (t) => ("quote" in t ? `“${t.quote}”` : `“${(t.anchor as { quote: string }).quote}”`),
    connect: (h) => {
      handlers = h;
    },
    suspend: vi.fn(),
  };
  const el = () => document.body.appendChild(document.createElement("div"));
  const api = { mentions: async () => ({ candidates: [] }), load: async () => payload } as unknown as Api;
  const payload = {
    document: { canSend: false },
    me: { kind: "member", name: "Ana", access: "comment" },
    threads,
    mentionedGuests: [],
  } as unknown as DocumentPayload;
  const ui = new CommentsUI(
    { api, surface, stage: el(), page: el(), panel: el(), count: el(), onViewer: () => undefined },
    payload.me,
  );
  ui.apply(payload);
  return { ui, surface, handlers: () => handlers };
}

describe("CommentsUI with a surface", () => {
  it("passes every thread; the surface filters", () => {
    const { surface, handlers } = setup([thread("1"), thread("2", "resolved")]);
    const last = vi.mocked(surface.mark).mock.calls.at(-1)![0];
    expect(last.threads.map((t) => t.id)).toEqual(["1", "2"]); // the surface hides resolved marks itself
    handlers().activate("1");
    expect(document.querySelector(".cpop")).not.toBeNull();
    expect(document.querySelector(".cpop")!.textContent).toContain("“q1”");
  });

  it("starts a draft from the surface and closes on Escape", () => {
    const { ui, surface } = setup([]);
    ui.startComment();
    expect(surface.draft).toHaveBeenCalled();
    expect(vi.mocked(surface.mark).mock.calls.at(-1)![0].draft).toMatchObject({ quote: "new" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".cpop")).toBeNull();
  });

  it("shows the surface's reason when there is nothing to comment on", () => {
    const { ui, surface } = setup([]);
    vi.mocked(surface.draft).mockReturnValueOnce("Select some words to comment on (up to 500 characters).");
    ui.startComment();
    expect(document.body.textContent).toContain("Select some words");
  });

  it("suspends the surface and starts no draft while suspended", () => {
    const { ui, surface } = setup([]);
    ui.suspend(true);
    expect(surface.suspend).toHaveBeenCalledWith(true);
    ui.startComment();
    expect(surface.draft).not.toHaveBeenCalled();
    expect(document.querySelector(".cpop")).toBeNull();
    ui.suspend(false);
    expect(surface.suspend).toHaveBeenLastCalledWith(false);
  });
});
