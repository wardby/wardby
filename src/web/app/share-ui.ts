/**
 * The top bar's Share button, on the document and design pages alike: one click makes a comment link
 * (POST /d/api/<id>/share-links, which a member with write access may call) and copies it. The link is a
 * credential answered once: it lives only in this closure while the note or the fallback box is open, and is
 * never logged, put in a URL or stored. If the clipboard refuses, the link shows in a read-only box with Copy.
 */
import { errorMessage, type Api } from "./api.js";
import { append, clear, h } from "./dom.js";
import { icon } from "./icons.js";

export const SHARE = {
  label: "Share",
  title: "Copy a comment link for someone without an account",
  copied: "Comment link copied. Anyone with it can read and comment for 14 days.",
  copyThis: "Copy this comment link (shown once). Anyone with it can read and comment for 14 days.",
  copy: "Copy",
  done: "Copied",
  field: "Comment link",
} as const;

/** How long the "copied" note stays. The fallback box stays until the viewer closes it (Escape, a click away). */
const NOTE_MS = 6000;

export interface ShareButton {
  /** The button and its note, to place in the top bar's actions. */
  el: HTMLElement;
  /** Shows or hides the button (a member with write access); hiding also forgets any link shown. */
  setAllowed(allowed: boolean): void;
}

export function shareButton(api: Api): ShareButton {
  const button = h(
    "button",
    { type: "button", title: SHARE.title, data: { action: "share" } },
    icon("share"),
    SHARE.label,
  );
  const note = h("div", { class: "share-note", role: "status", hidden: true });
  const el = h("span", { class: "share-wrap" }, button, note);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;

  /** Closes the note or the box; the link it held goes with it (the field is emptied, nothing else kept it). */
  const close = () => {
    clearTimeout(timer);
    clear(note);
    note.hidden = true;
    document.removeEventListener("mousedown", onAway, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onAway = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const show = (...children: (Node | string)[]) => {
    close();
    append(note, ...children);
    note.hidden = false;
    document.addEventListener("mousedown", onAway, true);
    document.addEventListener("keydown", onKey, true);
  };
  const say = (text: string) => {
    show(text);
    timer = setTimeout(close, NOTE_MS);
  };

  /** The clipboard refused: the link in a read-only box, selected, with a Copy button. */
  const showBox = (url: string) => {
    const field = h("input", {
      type: "text",
      class: "share-link",
      attrs: { readonly: "" },
      aria: { label: SHARE.field },
    });
    field.value = url;
    const copy = h("button", { type: "button", class: "tonal" }, SHARE.copy);
    copy.addEventListener("click", () => {
      field.select();
      void navigator.clipboard
        ?.writeText(field.value)
        .then(() => (copy.textContent = SHARE.done))
        .catch(() => undefined);
    });
    show(h("p", {}, SHARE.copyThis), h("div", { class: "share-row" }, field, copy));
    field.focus();
    field.select();
  };

  button.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    close();
    void (async () => {
      try {
        const link = await api.createCommentLink();
        const url = `${location.origin}${link.path}`;
        try {
          if (!navigator.clipboard) throw new Error("no clipboard");
          await navigator.clipboard.writeText(url);
          say(SHARE.copied);
        } catch {
          showBox(url);
        }
      } catch (err) {
        say(errorMessage(err));
      } finally {
        busy = false;
        button.disabled = false;
      }
    })();
  });

  return {
    el,
    setAllowed(allowed: boolean) {
      el.hidden = !allowed;
      if (!allowed) close();
    },
  };
}
