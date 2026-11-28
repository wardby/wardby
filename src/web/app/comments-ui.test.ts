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
  startedByMe: true,
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
  document.body.replaceChildren(); // each test reads only its own dialog
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
    emptyHint: () => "Press C to comment.",
    keysHint: () => "C: new comment",
    isMark: (target) => !!target.closest(".fake-mark"),
    located: vi.fn(() => true),
  };
  const el = () => document.body.appendChild(document.createElement("div"));
  const api = {
    mentions: async () => ({ candidates: [] }),
    load: async () => payload,
    createThread: vi.fn(),
  } as unknown as Api;
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
  return { ui, surface, api, payload, handlers: () => handlers };
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
    vi.mocked(surface.draft).mockReturnValueOnce("Select some words to comment on (up to 10,000 characters).");
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

  it("takes the panel's how-to text and key help from the surface", () => {
    const { ui } = setup([]);
    ui.render();
    expect(document.body.textContent).toContain("No open comments. Press C to comment.");
    expect(document.body.textContent).toContain("C: new comment · J / K: next / previous · Esc: close");
    expect(document.body.textContent).not.toContain("Select some text");
  });

  it("asks the surface whether a thread is located, never for its point, when drawing the panel", () => {
    const { surface } = setup([thread("1")]);
    expect(surface.located).toHaveBeenCalledWith("1");
    expect(surface.point).not.toHaveBeenCalled();
  });

  it("keeps the popover open on a mousedown on one of the surface's marks", () => {
    const { handlers } = setup([thread("1")]);
    handlers().activate("1");
    const mark = document.body.appendChild(document.createElement("button"));
    mark.className = "fake-mark";
    mark.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".cpop")).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".cpop")).toBeNull();
  });

  it("offers Send to agent on a reply; ticked, the reply is posted and then the thread is sent", async () => {
    const { api, payload, ui, handlers } = setup([thread("1"), thread("2", "resolved")]);
    (payload as { document: { canSend: boolean } }).document.canSend = true;
    const calls: string[] = [];
    Object.assign(api, {
      reply: vi.fn(async (id: string) => void calls.push(`reply ${id}`)),
      send: vi.fn(async (ids: string[]) => void calls.push(`send ${ids.join(",")}`)),
    });
    ui.apply(payload);
    const sendBox = () => document.querySelector<HTMLLabelElement>(".cpop label:has(input[data-send])");
    handlers().activate("2");
    expect(sendBox()?.hidden ?? true).toBe(true); // a resolved thread is not sent
    handlers().activate("1");
    expect(sendBox()?.hidden).toBe(false);
    const pop = document.querySelector(".cpop")!;
    pop.querySelector("textarea")!.value = "Still too long";
    pop.querySelector<HTMLInputElement>("input[data-send]")!.checked = true;
    pop.querySelector<HTMLButtonElement>("button.primary")!.click();
    await vi.waitFor(() => expect(calls).toEqual(["reply 1", "send 1"]));
  });

  it("a reply without the box ticked is only a reply; an edit never offers Send to agent", async () => {
    const { api, payload, ui, handlers } = setup([thread("1")]);
    (payload as { document: { canSend: boolean } }).document.canSend = true;
    const reply = vi.fn(async () => undefined);
    const send = vi.fn(async () => undefined);
    Object.assign(api, { reply, send, editComment: vi.fn(async () => undefined) });
    ui.apply(payload);
    handlers().activate("1");
    const pop = document.querySelector(".cpop")!;
    pop.querySelector("textarea")!.value = "Thanks";
    pop.querySelector<HTMLButtonElement>("button.primary")!.click();
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(send).not.toHaveBeenCalled();
  });

  it("a sent thread reads working until the agent replies, then replied", () => {
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    const waiting: ThreadView = { ...thread("1"), sentAt };
    const answered: ThreadView = {
      ...thread("2"),
      sentAt,
      comments: [
        ...thread("2").comments,
        {
          id: "c2b",
          author: { kind: "agent", name: "Agent" },
          body: "Done",
          createdAt: new Date().toISOString(),
          editedAt: null,
          mine: false,
        },
      ],
    };
    const { ui, handlers } = setup([waiting, answered]);
    ui.render();
    const chips = [...document.querySelectorAll(".chip.sent")].map((c) => c.textContent);
    expect(chips).toEqual(["✦ working", "✦ replied"]);
    handlers().activate("1");
    expect(document.querySelector(".cpop .status.sent")?.textContent).toBe("Sent to agent");
    handlers().activate("2");
    expect(document.querySelector(".cpop .status.sent")?.textContent).toBe("Agent replied");
  });

  it("finds a thread created before a failed send by its anchor, not its label", async () => {
    const element = (path: string) => ({
      type: "element" as const,
      board: "home",
      path,
      tag: "p",
      words: "Same words",
      dx: 0.5,
      dy: 0.5,
    });
    const other: ThreadView = { ...thread("1"), anchor: element("main:nth-of-type(1)>p:nth-of-type(1)") };
    const { ui, surface, api, payload } = setup([]);
    (payload as { document: { canSend: boolean } }).document.canSend = true;
    ui.apply(payload);
    const mine = element("main:nth-of-type(1)>p:nth-of-type(2)");
    vi.mocked(surface.draft).mockReturnValueOnce({ anchor: mine, quote: "Same words" });
    // Both threads have the same label; only the anchor tells them apart.
    surface.label = () => "“Same words” · Home";
    const created: ThreadView = { ...thread("2"), anchor: mine };
    vi.mocked(api.createThread).mockImplementationOnce(async () => {
      (payload as { threads: ThreadView[] }).threads = [other, created];
      const { ApiError } = await import("./api.js");
      throw new ApiError("document_agent_unavailable", 409);
    });
    ui.startComment();
    const pop = document.querySelector(".cpop")!;
    pop.querySelector("textarea")!.value = "Hello";
    pop.querySelector<HTMLInputElement>("input[data-send]")!.checked = true;
    pop.querySelector<HTMLButtonElement>("button.primary")!.click();
    await vi.waitFor(() => expect(document.querySelector(".cpop")?.textContent).toContain("#2 on"));
  });
});
