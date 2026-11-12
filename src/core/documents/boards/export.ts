/**
 * The whole-prototype export (spec "Export"): one HTML file with a board switcher and working
 * links. The switcher is the only script, allowed by its hash in the file's own CSP; the boards
 * travel as inert JSON and render in srcdoc frames sandboxed without scripts (links rewritten by
 * frames.ts, ruling D5). The frame keeps allow-same-origin only so a board link can move the top
 * page's fragment when the file is opened from disk (Chromium refuses that navigation from an
 * opaque origin); the page CSP and the absence of allow-scripts keep boards inert (ruling T9-1). The boards were redacted when stored, so
 * this file holds no secret value (a test with a fake value proves it).
 */
import { createHash } from "node:crypto";
import { escapeHtml, scriptJson } from "../../html-escape.js";

export const SWITCHER_SCRIPT =
  '(()=>{const B=JSON.parse(document.getElementById("boards").textContent);' +
  'const f=document.getElementById("f"),nav=document.getElementById("nav");' +
  'for(const b of B){const a=document.createElement("a");a.href="#board-"+b.id;a.dataset.id=b.id;a.textContent=b.name;nav.append(a);}' +
  "function show(){const m=/^#board-([a-z0-9-]+)$/.exec(location.hash);const b=B.find(x=>m&&x.id===m[1])||B[0];" +
  'f.srcdoc=b.html;f.style.width=b.width+"px";for(const a of nav.children)a.className=a.dataset.id===b.id?"on":"";}' +
  'addEventListener("hashchange",show);show();})();';

const SCRIPT_HASH = createHash("sha256").update(SWITCHER_SCRIPT).digest("base64");

/** A safe file-name stem for a title ("design" when nothing is left). */
export function exportSlug(title: string, fallback = "design"): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function prototypeFile(input: {
  title: string;
  boards: { id: string; name: string; width: number; html: string }[];
}): string {
  const csp = `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`;
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title)}</title>` +
    "<style>html,body{margin:0;background:#eef0f4;font:14px system-ui,sans-serif}" +
    "nav{display:flex;gap:6px;padding:8px 12px;background:#fff;border-bottom:1px solid #d6dae1;flex-wrap:wrap}" +
    "nav a{color:#1b1f27;text-decoration:none;border:1px solid #d6dae1;border-radius:6px;padding:3px 9px}" +
    "nav a.on{background:#1b1f27;color:#fff}iframe{display:block;margin:16px auto;height:calc(100vh - 80px);max-width:100%;border:0;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.1)}</style>" +
    `</head><body><nav id="nav" aria-label="Boards"></nav>` +
    `<iframe id="f" title="Board" sandbox="allow-same-origin allow-top-navigation-by-user-activation"></iframe>` +
    `<script type="application/json" id="boards">${scriptJson(input.boards)}</script>` +
    `<script>${SWITCHER_SCRIPT}</script></body></html>\n`
  );
}
