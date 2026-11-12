/**
 * CSS reference check for boards (spec "Board format v1" rule 3 and "Security"): a board's CSS
 * may not load anything from outside the board. The text is split into tokens by a CSS Syntax 3
 * tokenizer (@csstools/css-tokenizer), so strings end where a browser ends them (an unescaped
 * newline makes a bad string, and what follows it is CSS again), escapes in names are resolved
 * (`\75 rl(` is a url token), and comments are skipped the same way. The result is a list of
 * problem kinds, never the offending text.
 */
import { tokenize, TokenType, type CSSToken } from "@csstools/css-tokenizer";

/**
 * - external_url: a url() or image function that loads something other than a data: image or a
 *   #fragment, or whose argument cannot be checked (var(), env(), attr() ...).
 * - import: an @import rule.
 * - expression: expression(), behavior or -moz-binding.
 * - style_close: text that would end the <style> element.
 * - malformed: a tokenizer parse error, such as a string cut by a newline, a broken url() or an
 *   unclosed comment. Parsers disagree on what follows one (PostCSS reads on inside a string
 *   that a browser ends at the newline), so a board never carries one.
 */
export type CssProblem = "external_url" | "import" | "expression" | "style_close" | "malformed";

export interface CssCheckOptions {
  /** The text is a style attribute's declarations rather than a style sheet. */
  declarations?: boolean;
}

/** References a board may use: data: images and in-document fragments. */
const ALLOWED_REF = /^(?:data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]|#)/i;
/** Functions whose arguments are images or URLs: strings, url() or other functions. */
const IMAGE_FUNCTIONS = new Set([
  "image-set",
  "-webkit-image-set",
  "image",
  "-webkit-image",
  "src",
  "cross-fade",
  "-webkit-cross-fade",
]);
/** Functions an image function's direct argument may be, besides a data: string. */
const IMAGE_ARGUMENT_FUNCTIONS = new Set(["url", "type"]);
const GRADIENT = /^(?:-(?:webkit|moz|o)-)?(?:repeating-)?(?:linear|radial|conic)-gradient$|^-webkit-gradient$/;
const SCRIPT_LIKE_IDENT = new Set(["behavior", "behaviour", "-moz-binding"]);

type Frame =
  /** A url("…") function: it must hold exactly one allowed string. */
  | { kind: "url"; seen: boolean; bad: boolean }
  /** An image function: its direct arguments are checked. */
  | { kind: "image" }
  /** Any other function, or a (…), […] or {…} block. */
  | { kind: "other"; closer: TokenType };

/** CSS Syntax 3.3 input preprocessing: newlines normalised, NUL replaced. */
const preprocess = (css: string) => css.replace(/\r\n|[\r\f]/g, "\n").replace(/\0/g, "�");

/**
 * Trims CSS whitespace only (space, tab, newline, CR, form feed). JS `trim()` also strips U+00A0,
 * U+2000-U+200A, U+3000, U+FEFF and others, which a browser's URL parser keeps: `url("\u00a0data:…")`
 * would pass ALLOWED_REF yet load as a same-origin relative URL. Such a value is refused instead.
 */
const cssTrim = (value: string): string => value.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, "");

const valueOf = (t: CSSToken): string => {
  const value = (t[4] as { value?: unknown } | null)?.value;
  return typeof value === "string" ? value : "";
};

/**
 * Problems in a style sheet, or with `declarations: true` in a style attribute's declarations;
 * [] when clean. Throws nothing. Tokenizing never fails, so CSS a parser would reject is still
 * checked token by token (a browser recovers from errors and loads what it can). The same token
 * rules hold for a sheet and a declaration list, so `declarations` changes nothing today.
 */
export function checkCss(css: string, _options: CssCheckOptions = {}): CssProblem[] {
  const out = new Set<CssProblem>();
  if (/<\/style/i.test(css)) out.add("style_close");
  let tokens: CSSToken[];
  try {
    // Any tokenizer parse error (an unclosed comment or string, a bad escape) is refused: a
    // comment left open in one sheet can swallow or expose text joined after it.
    tokens = tokenize({ css: preprocess(css) }, { onParseError: () => out.add("malformed") });
  } catch {
    out.add("malformed");
    return [...out];
  }
  const stack: Frame[] = [];
  const closeFrame = (f: Frame) => {
    if (f.kind === "url" && (f.bad || !f.seen)) out.add("external_url");
  };

  for (const t of tokens) {
    const type = t[0];
    if (type === TokenType.Comment || type === TokenType.Whitespace || type === TokenType.EOF) continue;
    const top = stack[stack.length - 1];
    // Inside url("…") only the one string is allowed; any other token makes it unverifiable.
    if (top?.kind === "url" && type !== TokenType.String && type !== TokenType.CloseParen) top.bad = true;

    switch (type) {
      case TokenType.BadString:
        out.add("malformed");
        break;
      case TokenType.BadURL:
        out.add("malformed");
        out.add("external_url");
        break;
      case TokenType.AtKeyword:
        if (valueOf(t).toLowerCase() === "import") out.add("import");
        break;
      case TokenType.URL:
        if (!ALLOWED_REF.test(cssTrim(valueOf(t)))) out.add("external_url");
        break;
      case TokenType.Ident:
        if (SCRIPT_LIKE_IDENT.has(valueOf(t).toLowerCase())) out.add("expression");
        break;
      case TokenType.String: {
        const value = cssTrim(valueOf(t));
        if (top?.kind === "url") {
          if (top.seen || !ALLOWED_REF.test(value)) top.bad = true;
          top.seen = true;
        } else if (top?.kind === "image" && !ALLOWED_REF.test(value)) out.add("external_url");
        break;
      }
      case TokenType.Function: {
        const name = valueOf(t).toLowerCase();
        if (name === "expression") out.add("expression");
        if (top?.kind === "image" && !IMAGE_ARGUMENT_FUNCTIONS.has(name) && !GRADIENT.test(name)) {
          // var(), env(), attr() or anything else here could stand for a URL string.
          out.add("external_url");
        }
        if (name === "url") stack.push({ kind: "url", seen: false, bad: false });
        else if (IMAGE_FUNCTIONS.has(name)) stack.push({ kind: "image" });
        else stack.push({ kind: "other", closer: TokenType.CloseParen });
        break;
      }
      case TokenType.OpenParen:
      case TokenType.OpenSquare:
      case TokenType.OpenCurly: {
        if (top?.kind === "image") out.add("external_url"); // no image argument is a bare block
        const closer =
          type === TokenType.OpenParen
            ? TokenType.CloseParen
            : type === TokenType.OpenSquare
              ? TokenType.CloseSquare
              : TokenType.CloseCurly;
        stack.push({ kind: "other", closer });
        break;
      }
      case TokenType.CloseParen:
      case TokenType.CloseSquare:
      case TokenType.CloseCurly: {
        // A closer that does not match the innermost block is an ordinary token inside it.
        const expected = top === undefined ? undefined : top.kind === "other" ? top.closer : TokenType.CloseParen;
        if (top && expected === type) {
          stack.pop();
          closeFrame(top);
        } else if (top?.kind === "url") top.bad = true;
        break;
      }
      default:
        // Numbers, dimensions, commas, colons, delims, hashes: nothing loads from them.
        break;
    }
  }
  for (const f of stack) closeFrame(f);
  return [...out];
}
