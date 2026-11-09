/**
 * Step text as plain text: tool output and input are untrusted (repository content, command
 * output), and a reader may show them in a terminal. Whole ANSI escape sequences are removed (CSI
 * such as colour codes; OSC, DCS, SOS, PM and APC strings ended by BEL or ST, such as OSC 8 links
 * and OSC 52 clipboard writes), then every other C0 and C1 control character except `\n` and `\t`.
 * `\r\n` becomes `\n`; a lone `\r` is dropped. Removing characters can only join text, never split
 * it, so a secret split by colour codes is whole again for redaction, which runs after this.
 *
 * No imports: dependency-free, so any reader of step text can share it.
 */

/* eslint-disable no-control-regex -- matching control characters is this file's purpose */
/** OSC, DCS, SOS, PM, APC (7-bit or C1 introducer), up to BEL or ST (ESC \ or C1 ST). */
const STRING_SEQUENCE = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g;
/** CSI (7-bit or C1): parameter bytes, intermediate bytes, one final byte. */
const CSI_SEQUENCE = /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
/** Any other escape sequence (and an unterminated string's introducer): intermediates, one final byte. */
const ESCAPE_SEQUENCE = /\x1b[\x20-\x2f]*[\x30-\x7e]?/g;
/** C0 except \t and \n (\r included), DEL, and C1. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

/** `text` without terminal control sequences or control characters other than `\n` and `\t`. */
export function stripControlSequences(text: string): string {
  return text
    .replace(STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(/\r\n/g, "\n")
    .replace(CONTROL, "");
}
