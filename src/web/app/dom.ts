/**
 * Tiny DOM builder. Strings become text nodes; there is no innerHTML path,
 * so server text (titles, names, comment bodies) can never become markup.
 */
import { tokenizeBody } from "./comments.js";

export type Child = Node | string | null | undefined | false;

type Props = {
  class?: string;
  hidden?: boolean;
  disabled?: boolean;
  type?: string;
  title?: string;
  role?: string;
  tabIndex?: number;
  aria?: Record<string, string>;
  data?: Record<string, string>;
  attrs?: Record<string, string>;
  onClick?: (e: MouseEvent) => void;
  onMouseDown?: (e: MouseEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onInput?: (e: Event) => void;
  onChange?: (e: Event) => void;
};

const BLOCKED_ATTR = /^(?:on|style$|srcdoc$)/i;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.hidden) el.hidden = true;
  if (props.title !== undefined) el.title = props.title;
  if (props.role) el.setAttribute("role", props.role);
  if (props.tabIndex !== undefined) el.tabIndex = props.tabIndex;
  if (props.type && "type" in el) el.setAttribute("type", props.type);
  if (props.disabled && "disabled" in el) (el as HTMLButtonElement).disabled = true;
  for (const [k, v] of Object.entries(props.aria ?? {})) el.setAttribute(`aria-${k}`, v);
  for (const [k, v] of Object.entries(props.data ?? {})) el.dataset[k] = v;
  for (const [k, v] of Object.entries(props.attrs ?? {})) {
    if (BLOCKED_ATTR.test(k)) throw new Error(`attribute not allowed: ${k}`);
    el.setAttribute(k, v);
  }
  const target: HTMLElement = el;
  if (props.onClick) target.addEventListener("click", props.onClick);
  if (props.onMouseDown) target.addEventListener("mousedown", props.onMouseDown);
  if (props.onKeyDown) target.addEventListener("keydown", props.onKeyDown);
  if (props.onInput) target.addEventListener("input", props.onInput);
  if (props.onChange) target.addEventListener("change", props.onChange);
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

export function clear(el: Element): void {
  el.replaceChildren();
}

/** A comment body with light formatting; every piece is set as text. */
export function renderBody(body: string, names: ReadonlyMap<string, string>): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const t of tokenizeBody(body, names)) {
    if (t.kind === "text") frag.append(t.text);
    else if (t.kind === "br") frag.append(h("br"));
    else if (t.kind === "bold") frag.append(h("b", {}, t.text));
    else if (t.kind === "italic") frag.append(h("i", {}, t.text));
    else if (t.kind === "code") frag.append(h("code", {}, t.text));
    else frag.append(h("span", { class: "mention" }, t.text));
  }
  return frag;
}

/** Positions a fixed element; CSSOM writes are allowed under the page's CSP (no style attributes are parsed). */
export function placeAt(el: HTMLElement, left: number, top: number): void {
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab inside `root`. */
export function trapFocus(root: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => !x.closest("[hidden]"));
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
