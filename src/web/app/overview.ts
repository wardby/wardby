/**
 * Overview: every board of the design as a scaled-down tile. Each tile is a frame with an empty
 * `sandbox` (no script, no same-origin, no navigation) whose `srcdoc` is the server's frame HTML
 * (frames.ts, overview mode: no links). The frames take no pointer events; a button over each tile
 * picks the board. Server text (board names) is set as text; the HTML only ever goes to `srcdoc`.
 */
import type { FrameBoard } from "./api.js";
import { h } from "./dom.js";
import { openOverlay } from "./overlay.js";

export type { FrameBoard };

const TILE_SCALE = 0.32;
const TILE_FRAME_HEIGHT = 900;

/** Opens the Overview over `root`; the returned function closes it. */
export function openOverview(root: HTMLElement, frames: FrameBoard[], onPick: (id: string) => void): () => void {
  let overlay: ReturnType<typeof openOverlay> | null = null;
  const close = () => {
    overlay?.dispose();
    overlay = null;
  };
  overlay = openOverlay(root, { className: "overview", label: "Overview of all boards" }, close);
  const grid = h("div", { class: "ov-grid" });
  for (const board of frames) {
    const frame = h("iframe", { class: "ov-frame", title: `${board.name} (preview)` });
    frame.setAttribute("sandbox", "");
    frame.setAttribute("tabindex", "-1");
    frame.srcdoc = board.html;
    frame.style.width = `${board.width}px`;
    frame.style.height = `${TILE_FRAME_HEIGHT}px`;
    frame.style.transform = `scale(${TILE_SCALE})`;
    frame.style.transformOrigin = "0 0";
    frame.style.pointerEvents = "none";
    const view = h("div", { class: "ov-view" }, frame);
    view.style.width = `${Math.round(board.width * TILE_SCALE)}px`;
    view.style.height = `${Math.round(TILE_FRAME_HEIGHT * TILE_SCALE)}px`;
    const pick = h(
      "button",
      {
        type: "button",
        class: "ov-pick",
        data: { board: board.id },
        aria: { label: `Open ${board.name}` },
        onClick: () => {
          close();
          onPick(board.id);
        },
      },
      "",
    );
    grid.append(
      h(
        "div",
        { class: "ov-tile" },
        h("div", { class: "ov-stage" }, view, pick),
        h("div", { class: "ov-name" }, board.name),
      ),
    );
  }
  const closeBtn = h("button", { type: "button", class: "primary", onClick: close }, "Close");
  overlay.el.append(
    h(
      "div",
      { class: "ov-bar" },
      h("b", {}, "Overview"),
      h("span", { class: "muted" }, "Pick a board to open it"),
      closeBtn,
    ),
    frames.length ? grid : h("p", { class: "ov-empty" }, "This design has no boards."),
  );
  closeBtn.focus();
  return close;
}
