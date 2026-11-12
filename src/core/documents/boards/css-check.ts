/**
 * CSS reference check for boards (spec "Board format v1" rule 3 and "Security"): a board's CSS
 * may not load anything from outside the board. Style sheets and style attributes are parsed
 * with PostCSS and their values with postcss-value-parser; names are compared after resolving
 * CSS escapes (`\75 rl(` is `url(` to a browser). The result is a list of problem kinds, never
 * the offending text.
 */
import postcss from "postcss";
import valueParser from "postcss-value-parser";

export type CssProblem = "external_url" | "import" | "expression" | "style_close";

/** References a board may use: data: images and in-document fragments. */
const ALLOWED_REF = /^(?:data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]|#)/i;
/** Functions whose string arguments are URLs (besides url(), whose argument always is). */
const STRING_URL_FUNCTIONS = new Set(["image-set", "-webkit-image-set", "image", "src"]);
const SCRIPT_LIKE = /expression\s*\(|-moz-binding|behaviou?r\s*:/i;
const SCRIPT_LIKE_PROP = /^(?:behaviou?r|-moz-binding)$/i;

/** Resolves CSS escapes (CSS Syntax 4.3.7) so names compare as a browser reads them. */
export function cssUnescape(text: string): string {
  return text.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\r\n|([\s\S]))/g,
    (whole, hex: string | undefined, ch: string | undefined) => {
      if (hex !== undefined) {
        const cp = parseInt(hex, 16);
        return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "\ufffd" : String.fromCodePoint(cp);
      }
      if (ch === undefined || ch === "\n" || ch === "\r" || ch === "\f") return ""; // escaped newline: removed
      return ch;
    },
  );
}

const IDENT_CHAR = /[\w\u0080-\uffff-]/;
const HEX = /[0-9a-fA-F]/;

/**
 * Names of function tokens whose name contains a CSS escape (`\75 rl(`), which
 * postcss-value-parser cannot read. A linear scan of the raw text, so quoting tricks built from
 * escapes cannot hide one, and so long input cannot make it slow.
 */
function escapedFunctionNames(text: string): string[] {
  const names: string[] = [];
  let start = -1;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length && !/[\n\r\f]/.test(text[i + 1])) {
      if (start < 0) start = i;
      escaped = true;
      i++;
      if (HEX.test(text[i])) {
        let n = 1;
        while (n < 6 && i + 1 < text.length && HEX.test(text[i + 1])) {
          i++;
          n++;
        }
        if (i + 1 < text.length && /[ \t\n\r\f]/.test(text[i + 1])) i++;
      }
    } else if (IDENT_CHAR.test(c)) {
      if (start < 0) start = i;
    } else {
      if (c === "(" && start >= 0 && escaped) names.push(cssUnescape(text.slice(start, i)).toLowerCase());
      start = -1;
      escaped = false;
    }
  }
  return names;
}

function valueProblems(value: string, out: Set<CssProblem>): void {
  if (SCRIPT_LIKE.test(cssUnescape(value))) out.add("expression");
  for (const name of escapedFunctionNames(value)) {
    // A board never needs an escaped function name; one that reads as a URL function is refused outright.
    if (name === "url" || STRING_URL_FUNCTIONS.has(name)) out.add("external_url");
  }
  valueParser(value).walk((node) => {
    if (node.type !== "function") return;
    const name = cssUnescape(node.value).toLowerCase();
    if (name === "url") {
      const arg = node.nodes
        .map((n) => (n.type === "string" ? n.value : n.type === "space" ? "" : valueParser.stringify(n)))
        .join("")
        .trim();
      if (!ALLOWED_REF.test(arg)) out.add("external_url");
    } else if (STRING_URL_FUNCTIONS.has(name)) {
      for (const n of node.nodes) if (n.type === "string" && !ALLOWED_REF.test(n.value.trim())) out.add("external_url");
    }
  });
}

/**
 * Problems in a style sheet, or with `declarations: true` in a style attribute's declarations;
 * [] when clean. Throws nothing. CSS PostCSS cannot parse is still scanned as plain text, because
 * a browser recovers from errors such as an unclosed block and would load what it references.
 */
export function checkCss(css: string, { declarations = false }: { declarations?: boolean } = {}): CssProblem[] {
  const out = new Set<CssProblem>();
  if (/<\/style/i.test(css)) out.add("style_close");
  let root: postcss.Root;
  try {
    root = postcss.parse(declarations ? `x{${css}}` : css);
  } catch {
    if (/@import/i.test(cssUnescape(css))) out.add("import");
    valueProblems(css, out);
    return [...out];
  }
  root.walkAtRules((rule) => {
    const name = cssUnescape(rule.name).toLowerCase();
    if (name === "import") out.add("import");
    else if (name !== "namespace") valueProblems(rule.params, out);
  });
  root.walkDecls((decl) => {
    if (SCRIPT_LIKE_PROP.test(cssUnescape(decl.prop))) out.add("expression");
    valueProblems(decl.value, out);
  });
  return [...out];
}
