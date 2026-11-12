/**
 * The comment dialog (comments-ui.ts) works through an anchoring surface: the
 * Markdown text of a document (text-surface.ts) or the boards of a design. The
 * surface owns everything tied to what is commented on (marks, the gesture
 * that starts a comment, where a popover opens); the dialog owns the composer,
 * popover, panel and keys, and is the same for both kinds.
 */
import type { Anchor, ThreadView } from "./api.js";

export interface DraftStart {
  anchor: Anchor;
  quote: string;
}

export interface AnchorSurface {
  /** Where a new comment would go now; a string says why there is none (shown in the panel). */
  draft(): DraftStart | string | null;
  /**
   * Marks for open threads (resolved ones only while active) and the draft; `active` is emphasised.
   * `canStart` (optional, default true): whether a new comment can start now (comment access, no
   * popover open, not suspended), so the surface shows its own start affordance only then.
   */
  mark(state: {
    threads: readonly ThreadView[];
    draft: Anchor | null;
    active: string | null;
    canStart?: boolean;
  }): void;
  /** Viewport point to open a popover at, for a thread id or "draft"; null when its mark is not shown. */
  point(id: string): { x: number; y: number } | null;
  /** Brings a thread's anchor into view (designs also switch board). */
  reveal(thread: ThreadView): void;
  /** The anchor as the threads panel and popover header name it. */
  label(thread: ThreadView | DraftStart): string;
  /** The dialog's callbacks: a mark was clicked, the surface's own gesture started a comment, layout moved. */
  connect(handlers: { activate(id: string): void; start(): void; layout(): void }): void;
  /** Keys the surface owns (designs: C), asked after the dialog's own; true = handled. */
  key?(e: KeyboardEvent, typing: boolean): boolean;
  /** An earlier version is shown: hide the surface's marks and start affordance until resumed. */
  suspend?(on: boolean): void;
}
