/**
 * Full-page modal overlays (Overview, Play, an older version): a layer over the app that takes the
 * keyboard. While one is open, no key reaches the page behind it (the comment shortcuts, the canvas),
 * and Escape asks the overlay to close. Never markup from the server: callers build the content.
 */
import { h } from "./dom.js";

export interface Overlay {
  el: HTMLElement;
  /** Removes the overlay and its key trap; safe to call twice. */
  dispose(): void;
}

/** `onEscape` runs for Escape wherever focus is on the page (key events inside a frame never arrive). */
export function openOverlay(
  root: HTMLElement,
  opts: {
    className: string;
    label: string;
    /** Cut every other key off from the page (default). A layer beside live controls sets false. */ swallowKeys?: boolean;
    /**
     * "dialog" (default): a modal layer over the whole page. "region": a layer over part of a page whose
     * other controls stay usable (not modal).
     */
    role?: "dialog" | "region";
  },
  onEscape: () => void,
): Overlay {
  const region = opts.role === "region";
  const el = h("div", {
    class: `overlay ${opts.className}`,
    role: region ? "region" : "dialog",
    aria: region ? { label: opts.label } : { modal: "true", label: opts.label },
  });
  const trap = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
      return;
    }
    // Tab and activation keys keep their default action; only the page's own key handlers are cut off.
    if (opts.swallowKeys !== false) e.stopPropagation();
  };
  document.addEventListener("keydown", trap, true);
  root.append(el);
  let open = true;
  return {
    el,
    dispose() {
      if (!open) return;
      open = false;
      document.removeEventListener("keydown", trap, true);
      el.remove();
    },
  };
}
