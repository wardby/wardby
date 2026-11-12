/**
 * The part of jsdom's API the server uses. jsdom ships no types, and @types/jsdom pulls the DOM
 * lib into the whole server program (it changes `fetch`/`BodyInit` and breaks existing code), so
 * the server declares only what it calls. Extend this as needed; keep it to real jsdom members.
 */
declare module "jsdom" {
  export interface DomAttr {
    readonly name: string;
    value: string;
  }
  export interface DomNode {
    readonly nodeType: number;
    textContent: string | null;
    readonly isConnected: boolean;
    readonly parentElement: DomElement | null;
    readonly childNodes: ArrayLike<DomNode> & Iterable<DomNode>;
    contains(other: DomNode | null): boolean;
    insertBefore<T extends DomNode>(node: T, child: DomNode | null): T;
  }
  export interface DomParent {
    querySelector(selectors: string): DomElement | null;
    querySelectorAll(selectors: string): ArrayLike<DomElement> & Iterable<DomElement>;
    readonly children: ArrayLike<DomElement> & Iterable<DomElement>;
  }
  export interface DomElement extends DomNode, DomParent {
    readonly localName: string;
    readonly tagName: string;
    id: string;
    readonly namespaceURI: string | null;
    readonly attributes: ArrayLike<DomAttr> & Iterable<DomAttr>;
    innerHTML: string;
    lang: string;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    getAttributeNS(namespace: string | null, localName: string): string | null;
    removeAttributeNS(namespace: string | null, localName: string): void;
    closest(selectors: string): DomElement | null;
    /** A template element's contents (a document fragment). Other elements differ: meta's is a string. */
    readonly content?: unknown;
    matches(selectors: string): boolean;
    remove(): void;
  }
  export interface DomDocument extends DomNode, DomParent {
    title: string;
    readonly head: DomElement;
    readonly body: DomElement;
    readonly documentElement: DomElement;
    getElementById(id: string): DomElement | null;
    createElement(tagName: string): DomElement;
  }
  export interface DomWindow {
    readonly document: DomDocument;
    close(): void;
  }
  /**
   * Receives the page's console calls and jsdom's own errors. A new one forwards nothing; the
   * default one (no option given) prints jsdom errors, which can quote the input, to stderr.
   */
  export class VirtualConsole {
    constructor();
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
  export interface ConstructorOptions {
    virtualConsole?: VirtualConsole;
  }
  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: DomWindow;
    serialize(): string;
  }
}
