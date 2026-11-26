/**
 * Presence on the canvas (spec "Presence"): each other person's selected element outlined in their colour with
 * their name ("Bo is typing" while a text box is open), on the board this page shows. Drawn over the canvas frame
 * each animation frame, positioned through CSSOM (the page's CSP allows no inline style attributes).
 */
import type { Editor } from "grapesjs";
import type { DesignSession } from "./session.js";

export function drawOutlines(
  session: DesignSession,
  editor: Editor,
  layer: HTMLElement,
  board: () => string,
): () => void {
  let stopped = false;
  const frame = () => {
    if (stopped) return;
    layer.replaceChildren();
    const frameEl = editor.Canvas.getFrameEl();
    const fr = frameEl?.getBoundingClientRect();
    const host = layer.getBoundingClientRect();
    for (const p of session.peers()) {
      if (p.board !== board() || !p.element || !fr) continue;
      const el = session.elementOf(p.element)?.getEl();
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const box = document.createElement("div");
      box.className = "who";
      box.style.left = `${fr.left - host.left + r.left}px`;
      box.style.top = `${fr.top - host.top + r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      box.style.borderColor = p.color;
      const tag = document.createElement("span");
      tag.textContent = p.typing ? `${p.name} is typing` : p.name;
      tag.style.background = p.color;
      box.append(tag);
      layer.append(box);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return () => {
    stopped = true;
    layer.replaceChildren();
  };
}
