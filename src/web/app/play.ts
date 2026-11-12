/**
 * Play: click through the design like a prototype. The board is a frame with
 * `sandbox="allow-top-navigation-by-user-activation"` (never allow-scripts or allow-same-origin) whose
 * `srcdoc` is the server's frame HTML (frames.ts, play mode). A board link there is
 * `href="#board-<id>" target="_top"`, which only changes this page's fragment; every other link has no
 * href. So navigation is the fragment: `hashchange` → nextPlayState → the new board in the frame.
 * The page's own fragment is remembered on open and restored on exit.
 */
import type { FrameBoard } from "./api.js";
import { h } from "./dom.js";
import { openOverlay } from "./overlay.js";

export type { FrameBoard };

export interface PlayState {
  stack: string[];
}

const BOARD_HASH = /^#board-(.+)$/;

/** A `#board-<id>` fragment for a known board pushes it; anything else (or the board already shown) changes nothing. */
export function nextPlayState(state: PlayState, hash: string, ids: ReadonlySet<string>): PlayState {
  const m = BOARD_HASH.exec(hash);
  if (!m || !ids.has(m[1]) || state.stack[state.stack.length - 1] === m[1]) return state;
  return { stack: [...state.stack, m[1]] };
}

const WIDTHS = { Tablet: 768, Phone: 390 } as const;
type Device = "Desktop" | "Tablet" | "Phone";

/** Opens Play at `startId` over `root`; the returned function closes it and restores the page's fragment. */
export function openPlay(root: HTMLElement, frames: FrameBoard[], startId: string): () => void {
  const byId = new Map(frames.map((f) => [f.id, f]));
  const ids: ReadonlySet<string> = new Set(byId.keys());
  const first = byId.has(startId) ? startId : (frames[0]?.id ?? "");
  const remembered = location.hash;
  const setHash = (hash: string) =>
    history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);

  let state: PlayState = { stack: first ? [first] : [] };
  let device: Device = "Desktop";
  let overlay: ReturnType<typeof openOverlay> | null = null;

  const close = () => {
    if (!overlay) return;
    overlay.dispose();
    overlay = null;
    removeEventListener("hashchange", onHash);
    setHash(remembered);
  };
  overlay = openOverlay(root, { className: "play", label: "Play" }, close);

  const frame = h("iframe", { class: "play-frame" });
  frame.setAttribute("sandbox", "allow-top-navigation-by-user-activation");
  const stage = h("div", { class: "play-stage" }, frame);
  const bar = h("div", { class: "play-bar", tabIndex: -1, role: "toolbar", aria: { label: "Play" } });
  const boardBtns = new Map<string, HTMLButtonElement>();
  const deviceBtns = new Map<Device, HTMLButtonElement>();
  const backBtn = h("button", { type: "button", onClick: () => back() }, "Back");
  const exitBtn = h("button", { type: "button", class: "primary", onClick: close }, "Exit");

  const current = () => state.stack[state.stack.length - 1];

  const render = () => {
    const board = byId.get(current());
    if (board) {
      frame.title = board.name;
      frame.srcdoc = board.html;
    }
    frame.style.width = `${device === "Desktop" ? (board?.width ?? 1280) : WIDTHS[device]}px`;
    for (const [id, btn] of boardBtns) {
      btn.className = id === current() ? "on" : "";
      btn.setAttribute("aria-current", String(id === current()));
    }
    for (const [d, btn] of deviceBtns) {
      btn.className = d === device ? "on" : "";
      btn.setAttribute("aria-pressed", String(d === device));
    }
    backBtn.disabled = state.stack.length < 2;
  };

  const back = () => {
    if (state.stack.length < 2) return;
    state = { stack: state.stack.slice(0, -1) };
    setHash(`#board-${current()}`);
    render();
  };

  const onHash = () => {
    const next = nextPlayState(state, location.hash, ids);
    if (next === state) return;
    state = next;
    render();
  };
  addEventListener("hashchange", onHash);

  for (const f of frames) {
    const btn = h(
      "button",
      { type: "button", data: { board: f.id }, onClick: () => (location.hash = `#board-${f.id}`) },
      f.name,
    );
    boardBtns.set(f.id, btn);
  }
  for (const d of ["Desktop", "Tablet", "Phone"] as const) {
    const btn = h(
      "button",
      {
        type: "button",
        data: { device: d },
        onClick: () => {
          device = d;
          render();
        },
      },
      d,
    );
    deviceBtns.set(d, btn);
  }
  bar.append(
    h("b", {}, "Play"),
    h("div", { class: "group boards-fallback", role: "group", aria: { label: "Boards" } }, ...boardBtns.values()),
    h("div", { class: "group", role: "group", aria: { label: "Device" } }, ...deviceBtns.values()),
    backBtn,
    exitBtn,
  );
  overlay.el.append(bar, stage);

  if (first) setHash(`#board-${first}`);
  render();
  bar.focus();
  return close;
}
