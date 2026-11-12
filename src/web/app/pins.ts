/**
 * Pin geometry for design comments: where a pin goes in the page for an element in the canvas, and
 * the fractions of an element's box a click lands on. Pure: no DOM reads, so it is unit tested.
 */
import { clamp01 } from "../../core/documents/element-anchors.js";

export interface DOMRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The viewport point of a pin: the canvas frame's offset, plus the element's offset inside the frame,
 * plus the fraction (dx, dy) of the element's size.
 */
export function pinPoint(frame: DOMRectLike, el: DOMRectLike, dx: number, dy: number): { x: number; y: number } {
  return { x: frame.left + el.left + el.width * clamp01(dx), y: frame.top + el.top + el.height * clamp01(dy) };
}

/** A click at (clientX, clientY), in the element's own coordinates, as fractions of its box (0-1). */
export function offsetFraction(el: DOMRectLike, clientX: number, clientY: number): { dx: number; dy: number } {
  return {
    dx: el.width > 0 ? clamp01((clientX - el.left) / el.width) : 0,
    dy: el.height > 0 ? clamp01((clientY - el.top) / el.height) : 0,
  };
}
