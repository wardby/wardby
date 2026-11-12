/**
 * The part of jsdom's API the server uses. jsdom ships no types, and @types/jsdom pulls the DOM
 * lib into the whole server program (it changes `fetch`/`BodyInit` and breaks existing code), so
 * the server declares only what it calls. Extend this as needed; keep it to real jsdom members.
 */
declare module "jsdom" {
  export interface DomAttr {
    readonly name: string;
    readonly value: string;
  }
  export interface DomNode {
    readonly nodeType: number;
    textContent: string | null;
    readonly isConnected: boolean;
    readonly parentElement: DomElement | null;
    contains(other: DomNode | null): boolean;
  }
  export interface DomParent {
    querySelector(selectors: string): DomElement | null;
    querySelectorAll(selectors: string): ArrayLike<DomElement> & Iterable<DomElement>;
    readonly children: ArrayLike<DomElement> & Iterable<DomElement>;
  }
  export interface DomElement extends DomNode, DomParent {
    readonly localName: string;
    readonly tagName: string;
    readonly namespaceURI: string | null;
    readonly attributes: ArrayLike<DomAttr> & Iterable<DomAttr>;
    innerHTML: string;
    lang: string;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    closest(selectors: string): DomElement | null;
    remove(): void;
  }
  export interface DomDocument extends DomNode, DomParent {
    title: string;
    readonly head: DomElement;
    readonly body: DomElement;
    readonly documentElement: DomElement;
  }
  export interface DomWindow {
    readonly document: DomDocument;
    close(): void;
  }
  export class JSDOM {
    constructor(html?: string);
    readonly window: DomWindow;
    serialize(): string;
  }
}
