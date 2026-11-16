/**
 * The one error type for code board_format_invalid. It imports nothing, so the sanitiser and the
 * format check share it without an import cycle.
 */

/** The design does not follow board format v1. `problems` are our own fixed text plus board ids. */
export class BoardFormatError extends Error {
  constructor(readonly problems: string[]) {
    super("board_format_invalid");
    this.name = "BoardFormatError";
  }
}
