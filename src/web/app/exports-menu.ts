/**
 * Exports, for designs and documents alike: the one client for both. HTML files come straight from
 * GET /export; PNG and PDF are jobs (POST /exports, poll the status, fetch the file). Every file goes
 * to the user as a download from a blob URL; server text never reaches the page except as the fixed
 * messages in api.ts (errorMessage).
 */
import { ApiError, errorMessage, type Api, type DownloadedFile, type RenderedFormat } from "./api.js";
import { append, clear, h } from "./dom.js";

const POLL_MS = 1500;
const POLL_LIMIT_MS = 3 * 60 * 1000;

/** Hands a file to the browser as a download. */
export function saveFile(file: DownloadedFile): void {
  const url = URL.createObjectURL(file.blob);
  const link = h("a", { attrs: { href: url, download: file.filename } });
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A PNG or PDF: requests it, polls until it is done (or fails, or takes over three minutes), returns the file. */
export async function renderedExport(
  api: Api,
  opts: { format: RenderedFormat; board?: string; versionNumber?: number },
  pollMs = POLL_MS,
  limitMs = POLL_LIMIT_MS,
): Promise<DownloadedFile> {
  const id = await api.startExport(opts);
  const deadline = Date.now() + limitMs;
  for (;;) {
    const s = await api.exportStatus(id);
    if (s.status === "done") return api.exportBytes(id);
    if (s.status === "failed")
      throw new ApiError(
        s.errorCode && /^[a-z][a-z0-9_]{0,63}$/.test(s.errorCode) ? s.errorCode : "export_failed",
        502,
      );
    if (Date.now() >= deadline) throw new ApiError("export_timeout", 0);
    await wait(pollMs);
  }
}

/** Runs `job`, showing "Rendering…" (when asked) and then nothing or the error text in `note`. */
async function withNote(note: HTMLElement, busyText: string, job: () => Promise<DownloadedFile>): Promise<void> {
  note.textContent = busyText;
  try {
    saveFile(await job());
    note.textContent = "";
  } catch (err) {
    note.textContent = errorMessage(err);
  }
}

/** An "Export PDF" button for a Markdown document page (same client, polling and error texts as the design menu). */
export function pdfExportButton(button: HTMLButtonElement, note: HTMLElement, api: Api): void {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    button.disabled = true;
    void withNote(note, "Rendering…", () => renderedExport(api, { format: "pdf" })).finally(() => {
      button.disabled = false;
    });
  });
}

/**
 * The design page's Export menu on `button`. `ctx` is read when an item is chosen: the board in the
 * canvas and the version shown. `canRender` false (no renderer on this server) keeps the PNG and PDF
 * entries but answers them with the fixed "isn't set up" text, with no request.
 */
export function exportsMenu(
  button: HTMLElement,
  api: Api,
  ctx: () => { board: string; version: number },
  canRender: boolean,
): void {
  const note = h("div", { class: "exp-note", role: "status" });
  const menu = h("div", { class: "exp-menu", role: "menu", hidden: true });
  let busy = false;
  const run = (busyText: string, job: () => Promise<DownloadedFile>) => {
    if (busy) return;
    busy = true;
    menu.setAttribute("aria-busy", "true");
    void withNote(note, busyText, job).finally(() => {
      busy = false;
      menu.removeAttribute("aria-busy");
    });
  };
  const item = (label: string, onChoose: () => void) =>
    h("button", { type: "button", role: "menuitem", onClick: onChoose }, label);
  const rendered = (label: string, job: () => Promise<DownloadedFile>) =>
    item(label, () => {
      if (!canRender) {
        note.textContent = errorMessage(new ApiError("export_renderer_unavailable", 503));
        return;
      }
      run("Rendering…", job);
    });
  append(
    menu,
    item("This board (HTML)", () => {
      const c = ctx();
      run("Preparing…", () => api.exportFile({ format: "board-html", board: c.board, version: c.version }));
    }),
    item("Whole prototype (HTML)", () => {
      const c = ctx();
      run("Preparing…", () => api.exportFile({ format: "prototype", version: c.version }));
    }),
    rendered("This board (PNG)", () => {
      const c = ctx();
      return renderedExport(api, { format: "png", board: c.board, versionNumber: c.version });
    }),
    rendered("All boards (PDF)", () => renderedExport(api, { format: "pdf", versionNumber: ctx().version })),
    note,
  );
  document.body.append(menu);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");

  const hide = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", () => {
    if (!menu.hidden) return hide();
    clear(note);
    const r = button.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.right = `${Math.max(8, Math.round(document.documentElement.clientWidth - r.right))}px`;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
  });
  document.addEventListener("mousedown", (e) => {
    const t = e.target as Node;
    if (!menu.hidden && !menu.contains(t) && !button.contains(t)) hide();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      hide();
      button.focus();
    }
  });
}
