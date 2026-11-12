/**
 * Entry point of the design page (/d/<id> and /s/<token> for a design): reads the bootstrap, loads the
 * design, mounts GrapesJS (boards-editor.ts) with its managers in Wardby's sidebars, and saves a
 * writer's edits with a debounced PUT of the changed files only, based on the version shown. Live
 * updates (live.ts) refetch threads and newer versions as documents.ts does. A writer's first view of a
 * version runs the import fidelity check (fidelity.ts) and reports it once.
 *
 * Every server string (title, board names, warnings, problems) goes into the page as text (dom.ts h()),
 * never as markup. Boards render only inside GrapesJS's canvas, under the page CSP.
 */
import "grapesjs/dist/css/grapes.min.css";
import "./styles.css";
import "./designs.css";
import { warningText, type VersionWarning } from "../../core/documents/warnings.js";
import { BOARD_ID } from "../../core/documents/boards/ids.js";
import {
  Api,
  ApiError,
  errorMessage,
  readBootstrap,
  type Bootstrap,
  type DocumentPayload,
  type ThreadView,
  type Viewer,
} from "./api.js";
import { createBoardsEditor, ManifestUnreadableError, type BoardsEditor, type DeviceId } from "./boards-editor.js";
import { atLeast, CommentsUI } from "./comments-ui.js";
import { append, clear, h } from "./dom.js";
import { measureFidelity } from "./fidelity.js";
import { coalesce, HiddenStopper, liveAction, LiveConnection, statusConnected, versionAction } from "./live.js";
import type { AnchorSurface, DraftStart } from "./surface.js";

const SAVE_DELAY_MS = 1500;
/** After a writer's own save, the new version's fidelity check waits for this long with no edits. */
const FIDELITY_IDLE_MS = 3000;
const DEVICE_IDS: DeviceId[] = ["Desktop", "Tablet", "Phone"];

declare global {
  interface Window {
    __WARDBY__?: unknown;
  }
}

/** Fixed text: the manifest's own content never reaches the page. */
const MANIFEST_UNREADABLE = "This design's list of boards can't be read. Reload to try again.";

function fatal(root: HTMLElement, message: string): void {
  clear(root);
  root.append(h("main", { class: "fatal" }, h("h1", {}, "This design can't be shown"), h("p", {}, message)));
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  let boot: Bootstrap;
  try {
    boot = readBootstrap(window.__WARDBY__);
  } catch {
    return fatal(root, "The page is missing its settings. Reload to try again.");
  }
  const api = new Api(boot);
  let payload: DocumentPayload;
  try {
    payload = await api.load();
  } catch (err) {
    if (err instanceof ApiError && err.code === "web_session_required") {
      location.assign(boot.loginUrl);
      return;
    }
    return fatal(root, errorMessage(err));
  }
  if (payload.version.format !== "boards-v1") return fatal(root, "This page shows designs only. Reload to try again.");
  mount(root, boot, api, payload, payload.version.files);
}

/** A small modal in the page's own style (never confirm() or prompt()). Resolves null on cancel. */
function askDialog(opts: {
  title: string;
  text?: string;
  value?: string;
  ok: string;
  danger?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const input =
      opts.value !== undefined ? h("input", { attrs: { maxlength: "80", "aria-label": opts.title } }) : null;
    if (input) input.value = opts.value ?? "";
    const okBtn = h("button", { type: "submit", class: opts.danger ? "danger" : "primary" }, opts.ok);
    const cancel = h("button", { type: "button" }, "Cancel");
    const form = h(
      "form",
      { attrs: { method: "dialog" } },
      h("h2", {}, opts.title),
      opts.text ? h("p", {}, opts.text) : null,
      input,
      h("div", { class: "actions" }, cancel, okBtn),
    );
    const dlg = h("dialog", { class: "wdialog" }, form);
    let result: string | null = null;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = input ? input.value.trim() : "ok";
      if (!value) return;
      result = value;
      dlg.close();
    });
    cancel.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(result);
    });
    document.body.append(dlg);
    dlg.showModal();
    (input ?? okBtn).focus();
  });
}

/**
 * Comments on boards (pins) arrive with the design surface (Task 14). Until then the dialog runs on a
 * surface with no marks that says why no comment can start; the threads panel works as for documents.
 */
function placeholderSurface(boardName: (id: string) => string): AnchorSurface {
  return {
    draft: () => "Comments on boards arrive in the next step.",
    mark: () => undefined,
    point: () => null,
    reveal: () => undefined,
    label(thread: ThreadView | DraftStart): string {
      const a = thread.anchor;
      return a.type === "element" ? `“${a.words}” · ${boardName(a.board)}` : "";
    },
    connect: () => undefined,
  };
}

function mount(
  root: HTMLElement,
  boot: Bootstrap,
  api: Api,
  payload: DocumentPayload,
  files: Record<string, string>,
): void {
  let viewer: Viewer = payload.me;
  let baseNumber = payload.version.number;
  let warnings: VersionWarning[] = payload.version.warnings ?? [];
  const canWrite = viewer.kind === "member" && atLeast(viewer.access, "write");

  // ---- layout ----
  const title = h("b", { class: "title" }, payload.document.title);
  const version = h("span", { class: "badge version" }, `design · v${baseNumber}`);
  const saveState = h("span", { class: "save", aria: { live: "polite" } });
  const liveNote = h("span", { class: "live-note", hidden: true, role: "status" });
  const who = h("span", { class: "who-am-i" });
  const account = h("span", { class: "account" });
  const banner = h("div", { class: "banner", hidden: true, role: "note" });
  const changedBanner = h(
    "div",
    { class: "banner", hidden: true, role: "note" },
    "This design changed. Reload to see the latest version. ",
    h("button", { type: "button", onClick: () => location.reload() }, "Reload"),
  );
  const saveBanner = h("div", { class: "banner bad", hidden: true, role: "alert" });

  const deviceButtons = DEVICE_IDS.map((id) =>
    h(
      "button",
      { type: "button", class: id === "Desktop" ? "on" : "", aria: { pressed: String(id === "Desktop") } },
      id,
    ),
  );
  const undoBtn = h("button", { type: "button", title: "Undo" }, "Undo");
  const redoBtn = h("button", { type: "button", title: "Redo" }, "Redo");
  // Overview, Play and Export are wired by their own step (Task 15).
  const overviewBtn = h("button", { type: "button", disabled: true, data: { action: "overview" } }, "▦ Overview");
  const playBtn = h("button", { type: "button", disabled: true, data: { action: "play" } }, "▶ Play");
  const exportBtn = h("button", { type: "button", disabled: true, data: { action: "export" } }, "Export ▾");
  const commentBtn = h("button", { type: "button", class: "primary", data: { action: "comment" } }, "💬 Comment");

  const boardsList = h("ul", { class: "boards", aria: { label: "Boards" } });
  const addBoardBtn = h("button", { type: "button", class: "add-board", hidden: !canWrite }, "+ Board");
  const layersPanel = h("div", { class: "gjs-host layers" });
  const stylesPanel = h("div", { class: "gjs-host styles" });
  const selectorsPanel = h("div", { class: "gjs-host selectors" });
  const traitsPanel = h("div", { class: "gjs-host traits" });
  const canvasEl = h("div", { class: "canvas" });
  const canvasWrap = h("div", { class: "canvas-wrap" }, canvasEl);

  const checks = h("div", { class: "checks", hidden: true, role: "note" });
  const commentsPanel = h("div", { class: "panel" });
  const count = h("span", { class: "ccount" });
  type Tab = "style" | "settings" | "comments";
  const tabs: Record<Tab, HTMLButtonElement> = {
    style: h("button", { type: "button", role: "tab", data: { tab: "style" }, hidden: !canWrite }, "Style"),
    settings: h("button", { type: "button", role: "tab", data: { tab: "settings" }, hidden: !canWrite }, "Settings"),
    comments: h("button", { type: "button", role: "tab", data: { tab: "comments" } }, "Comments ", count),
  };
  const panes: Record<Tab, HTMLElement> = {
    style: h("div", { class: "tabpane", role: "tabpanel" }, selectorsPanel, stylesPanel),
    settings: h("div", { class: "tabpane", role: "tabpanel" }, traitsPanel),
    comments: h("div", { class: "tabpane", role: "tabpanel" }, checks, commentsPanel),
  };
  const TABS: Tab[] = ["style", "settings", "comments"];
  const showTab = (which: Tab) => {
    for (const k of TABS) {
      const on = k === which;
      tabs[k].className = on ? "on" : "";
      tabs[k].setAttribute("aria-selected", String(on));
      panes[k].hidden = !on;
    }
  };
  for (const k of TABS) tabs[k].addEventListener("click", () => showTab(k));
  showTab(canWrite ? "style" : "comments");

  clear(root);
  append(
    root,
    h(
      "div",
      { class: "app design-app" },
      h(
        "header",
        { class: "topbar" },
        h(
          "div",
          { class: "crumbs" },
          h("span", { class: "muted" }, "Wardby"),
          h("span", { class: "muted" }, "/"),
          h("span", { class: "muted" }, "Designs"),
          h("span", { class: "muted" }, "/"),
          title,
          version,
        ),
        h("div", { class: "group", role: "group", aria: { label: "Device" } }, ...deviceButtons),
        h("div", { class: "group", hidden: !canWrite }, undoBtn, redoBtn),
        h("div", { class: "group" }, overviewBtn, playBtn, exportBtn, commentBtn),
        saveState,
        liveNote,
        who,
        account,
      ),
      banner,
      changedBanner,
      saveBanner,
      h(
        "div",
        { class: "design-main" },
        h(
          "aside",
          { class: "dside left", aria: { label: "Boards and layers" } },
          h("h2", {}, "Boards"),
          boardsList,
          addBoardBtn,
          h("h2", { hidden: !canWrite }, "Layers"),
          h("div", { hidden: !canWrite }, layersPanel),
        ),
        canvasWrap,
        h(
          "aside",
          { class: "dside right", aria: { label: "Style, settings and comments" } },
          h("div", { class: "tabs", role: "tablist" }, tabs.style, tabs.settings, tabs.comments),
          panes.style,
          panes.settings,
          panes.comments,
        ),
      ),
    ),
  );

  // ---- editor ----
  let boards: BoardsEditor;
  try {
    boards = createBoardsEditor({
      container: canvasEl,
      panels: { layers: layersPanel, styles: stylesPanel, selectors: selectorsPanel, traits: traitsPanel },
      files,
      editable: canWrite,
    });
  } catch (err) {
    if (err instanceof ManifestUnreadableError) return fatal(root, MANIFEST_UNREADABLE);
    throw err;
  }
  const boardName = (id: string) => boards.manifest().boards.find((b) => b.id === id)?.name ?? id;

  deviceButtons.forEach((btn, i) =>
    btn.addEventListener("click", () => {
      boards.setDevice(DEVICE_IDS[i]);
      deviceButtons.forEach((b, j) => {
        b.className = i === j ? "on" : "";
        b.setAttribute("aria-pressed", String(i === j));
      });
    }),
  );
  undoBtn.addEventListener("click", () => boards.editor.UndoManager.undo());
  redoBtn.addEventListener("click", () => boards.editor.UndoManager.redo());

  // ---- checks: the version's warnings, in the server's own wording (warningText) ----
  const renderChecks = () => {
    clear(checks);
    // A board whose fidelity check found nothing is not shown (PF-M8).
    const shown = warnings.filter((w) => w.kind !== "fidelity" || w.mismatches > 0);
    checks.hidden = shown.length === 0;
    if (checks.hidden) return;
    append(checks, h("h2", {}, "Checks"), h("ul", {}, ...shown.map((w) => h("li", {}, warningText(w)))));
  };
  renderChecks();

  // ---- the boards list ----
  let threads: ThreadView[] = [];
  /** The fidelity pass switches boards: saves, live reloads and the boards list wait until it is done. */
  let measuring = false;
  const closeMenus = () => {
    for (const m of Array.from(boardsList.querySelectorAll<HTMLElement>(".bmenu"))) m.hidden = true;
  };
  const renderBoards = () => {
    clear(boardsList);
    boardsList.setAttribute("aria-busy", String(measuring));
    addBoardBtn.disabled = measuring;
    const list = boards.manifest().boards;
    list.forEach((b, i) => {
      const n = threads.filter(
        (t) => t.status === "open" && t.anchor.type === "element" && t.anchor.board === b.id,
      ).length;
      const on = b.id === boards.currentBoard();
      const pick = h(
        "button",
        { type: "button", class: "pick", disabled: measuring, aria: { current: String(on) } },
        h("span", { class: "name" }, b.name),
        n ? h("span", { class: "bcount", title: `${n} open comment${n === 1 ? "" : "s"}` }, `💬 ${n}`) : null,
      );
      pick.addEventListener("click", () => {
        if (!measuring) boards.selectBoard(b.id);
      });
      const li = h("li", { class: on ? "on" : "", data: { board: b.id } }, pick);
      if (canWrite) {
        const menu = h("div", { class: "bmenu", role: "menu", hidden: true });
        const item = (label: string, run: () => void, disabled = false) =>
          h(
            "button",
            {
              type: "button",
              role: "menuitem",
              disabled,
              onClick: () => {
                menu.hidden = true;
                run();
              },
            },
            label,
          );
        append(
          menu,
          item("Rename…", () => {
            void askDialog({ title: "Rename board", value: b.name, ok: "Rename" }).then((name) => {
              if (name) boards.renameBoard(b.id, name);
            });
          }),
          item("Move up", () => boards.moveBoard(b.id, -1), i === 0),
          item("Move down", () => boards.moveBoard(b.id, 1), i === list.length - 1),
          item(
            "Delete…",
            () => {
              void askDialog({
                title: "Delete board",
                text: `Delete the board “${b.name}”? Its comments stay in the threads panel.`,
                ok: "Delete",
                danger: true,
              }).then((ok) => {
                if (ok) boards.deleteBoard(b.id);
              });
            },
            list.length <= 1,
          ),
        );
        const more = h(
          "button",
          {
            type: "button",
            class: "more",
            disabled: measuring,
            aria: { label: `Board ${b.name}: actions`, haspopup: "menu" },
          },
          "⋯",
        );
        more.addEventListener("click", () => {
          if (measuring) return;
          const show = menu.hidden;
          closeMenus();
          menu.hidden = !show;
        });
        li.append(more, menu);
      }
      boardsList.append(li);
    });
  };
  document.addEventListener("mousedown", (e) => {
    if (!(e.target as Element).closest?.(".boards li")) closeMenus();
  });
  boards.onBoard(() => renderBoards());
  addBoardBtn.addEventListener("click", () => {
    if (measuring) return;
    void askDialog({ title: "New board", value: "", ok: "Add board" }).then((name) => {
      if (name) boards.addBoard(name);
    });
  });

  // ---- who is viewing ----
  const renderViewer = () => {
    clear(who);
    clear(account);
    if (viewer.kind === "member") who.append(`Signed in as ${viewer.name ?? "member"}`);
    else if (viewer.kind === "guest") who.append(`${viewer.name ?? "Guest"} (guest)`);
    if (viewer.kind === "anonymous") {
      account.append(h("a", { class: "button", attrs: { href: boot.loginUrl } }, "Sign in"));
    } else {
      account.append(
        h(
          "button",
          {
            type: "button",
            onClick: () => {
              api
                .logout()
                .catch(() => undefined)
                .finally(() => location.reload());
            },
          },
          "Sign out",
        ),
      );
    }
    // Share-link visitors who are not signed in as members.
    clear(banner);
    banner.hidden = !boot.shareToken || viewer.kind === "member";
    if (!banner.hidden) {
      const canGuest = viewer.kind === "anonymous" && atLeast(viewer.access, "comment");
      append(
        banner,
        h("a", { attrs: { href: boot.loginUrl } }, "Sign in to comment as yourself"),
        canGuest ? " · or continue as guest" : viewer.kind === "anonymous" ? " · this link is view-only" : "",
      );
    }
  };

  // ---- comments ----
  let startLive: () => void = () => undefined;
  const comments = new CommentsUI(
    {
      api,
      surface: placeholderSurface(boardName),
      shareToken: boot.shareToken,
      stage: canvasWrap,
      page: canvasWrap,
      panel: commentsPanel,
      count,
      onViewer: (v) => {
        viewer = v;
        renderViewer();
        startLive();
      },
    },
    viewer,
  );
  commentBtn.addEventListener("click", () => {
    showTab("comments");
    comments.startComment();
  });
  const applyPayload = (p: DocumentPayload) => {
    comments.apply(p);
    threads = p.threads;
    commentBtn.hidden = !comments.canComment;
    renderBoards();
  };

  renderViewer();
  applyPayload(payload);
  void comments.loadMentions();
  // The agent-run poll is a fallback for when live updates are not connected.
  let liveUp = false;
  comments.startPolling(() => liveUp);
  comments.openFromHash();
  addEventListener("hashchange", () => comments.openFromHash());

  // ---- saving ----
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let conflict = false;
  let pendingRefresh = false;

  const showSave = (text: string, reload = false) => {
    clear(saveState);
    saveState.className = `save${reload ? " bad" : ""}`;
    append(
      saveState,
      text,
      reload ? h("button", { type: "button", onClick: () => location.reload() }, "Reload") : null,
    );
  };
  const dirty = () => canWrite && boards.dirty();

  /** Refetches threads and this version's warnings without touching the boards. */
  const refreshPayload = async () => {
    try {
      const next = await api.load();
      if (next.version.number === baseNumber) {
        warnings = next.version.warnings ?? [];
        renderChecks();
      }
      applyPayload(next);
    } catch {
      /* the next event or save tries again */
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DELAY_MS);
  };

  const save = async (): Promise<void> => {
    if (saving || conflict || measuring) return;
    // Text still being typed in the canvas is synced when its editing ends: save after that.
    if (boards.editor.getEditing()) return schedule();
    const changed = boards.changedFiles();
    if (Object.keys(changed).length === 0) {
      showSave("Saved");
      // An editor event with nothing to save (a board switch) still ends a quiet spell: start another.
      if (afterSave) scheduleFidelity();
      return;
    }
    saving = true;
    showSave("Saving…");
    try {
      const r = await api.saveFiles(changed, baseNumber);
      boards.markSaved(changed);
      noteSaved(changed);
      baseNumber = r.version.number;
      version.textContent = `design · v${baseNumber}`;
      saveBanner.hidden = true;
      showSave(dirty() ? "Unsaved changes" : "Saved");
      // The server re-anchored the threads against the new version; the warnings are the new version's.
      await refreshPayload();
      if (!dirty()) scheduleFidelity();
    } catch (err) {
      if (err instanceof ApiError && err.code === "document_version_conflict") {
        conflict = true;
        showSave(errorMessage(err), true);
      } else if (err instanceof ApiError && err.code === "board_format_invalid") {
        // The changes stay in the editor; the problem is the server's own fixed text.
        clear(saveBanner);
        saveBanner.append(`This edit can't be saved: ${err.problems[0] ?? "it breaks the board format"}`);
        saveBanner.hidden = false;
        showSave("Not saved");
      } else {
        showSave(`Not saved: ${errorMessage(err)}`);
      }
    } finally {
      saving = false;
    }
    if (pendingRefresh) {
      pendingRefresh = false;
      void refresh();
    }
  };

  boards.onChange(() => {
    renderBoards();
    if (!canWrite || conflict || measuring) return;
    clearTimeout(fidelityTimer);
    showSave("Unsaved changes");
    schedule();
  });

  // ---- fidelity: writers, once per version (the server keeps the first report) ----
  type FidelityEntry = { board: string; mismatches: number; samples: string[] };
  const fidelityOf = (ws: VersionWarning[]): FidelityEntry[] =>
    ws.flatMap((w) =>
      w.kind === "fidelity" ? [{ board: w.board, mismatches: w.mismatches, samples: [...w.samples] }] : [],
    );
  const nextFrame = (win: Window) => new Promise<void>((r) => win.requestAnimationFrame(() => r()));
  /**
   * Measures every board of version `forVersion` and reports them once. Boards in `carried` keep the
   * result they had (their text is unchanged since it was measured); the board in the canvas is
   * measured first and in place, so a check after a save on that board switches nothing.
   */
  const runFidelity = async (forVersion: number, carried = new Map<string, FidelityEntry>()): Promise<void> => {
    if (!canWrite || measuring || warnings.some((w) => w.kind === "fidelity")) return;
    measuring = true;
    renderBoards();
    const start = boards.currentBoard();
    const results: FidelityEntry[] = [];
    try {
      const list = boards.manifest().boards;
      const order = [...list.filter((b) => b.id === start), ...list.filter((b) => b.id !== start)];
      for (const b of order) {
        const kept = carried.get(b.id);
        if (kept) {
          results.push(kept);
          continue;
        }
        boards.selectBoard(b.id);
        const win = boards.canvasWindow();
        const base = boards.baseStyle();
        const board = boards.root();
        if (!board || !win || !base) continue;
        await nextFrame(win);
        results.push({ board: b.id, ...measureFidelity(board, win, base) });
      }
    } finally {
      boards.selectBoard(start);
      measuring = false;
      renderBoards();
    }
    if (results.length && forVersion === baseNumber) {
      await api.fidelity(forVersion, results).catch(() => undefined);
      await refreshPayload();
    }
    if (dirty()) schedule();
  };

  /**
   * A writer's own save makes a version with no fidelity entries. Once the editor is idle the new
   * version is checked: boards the saves since the last measured version did not touch keep their
   * entries, the others are measured. Saves in a row add up until one is followed by a quiet spell.
   */
  let afterSave: { prior: FidelityEntry[]; changed: Set<string> } | null = null;
  let fidelityTimer: ReturnType<typeof setTimeout> | undefined;
  const noteSaved = (files: Record<string, string | null>) => {
    const prior = afterSave?.prior ?? fidelityOf(warnings);
    const changed = new Set(afterSave?.changed ?? []);
    for (const path of Object.keys(files)) {
      const id = /^boards\/(.+)\.html$/.exec(path)?.[1];
      if (id && BOARD_ID.test(id)) changed.add(id);
    }
    afterSave = { prior, changed };
  };
  const scheduleFidelity = () => {
    clearTimeout(fidelityTimer);
    fidelityTimer = setTimeout(() => void fidelityAfterSave(), FIDELITY_IDLE_MS);
  };
  const fidelityAfterSave = async (): Promise<void> => {
    if (!afterSave || conflict) return;
    // Busy or still editing: try again after the next quiet spell (a pending save re-arms it too).
    if (saving || measuring || boards.editor.getEditing()) return scheduleFidelity();
    if (dirty()) return;
    const { prior, changed } = afterSave;
    afterSave = null;
    const carried = new Map(prior.filter((e) => !changed.has(e.board)).map((e) => [e.board, e]));
    // With no earlier entries every board is measured (carried is empty).
    await runFidelity(baseNumber, carried);
  };

  // ---- live updates ----
  /** Shows a newer version in place, keeping the selected board and device. */
  const loadVersion = (next: DocumentPayload) => {
    if (next.version.format !== "boards-v1") return;
    // Someone else's version: the earlier saves' entries say nothing about it.
    afterSave = null;
    clearTimeout(fidelityTimer);
    try {
      boards.load(next.version.files);
    } catch (err) {
      if (err instanceof ManifestUnreadableError) {
        conflict = true; // nothing more is saved from this page
        return fatal(root, MANIFEST_UNREADABLE);
      }
      throw err;
    }
    baseNumber = next.version.number;
    version.textContent = `design · v${baseNumber}`;
    warnings = next.version.warnings ?? [];
    renderChecks();
    applyPayload(next);
    void runFidelity(baseNumber);
  };

  /** Refetches the design and threads; a newer version loads in place unless there are unsaved edits. */
  const refresh = coalesce(async () => {
    let next: DocumentPayload;
    try {
      next = await api.load();
    } catch {
      return; // the next event, reconnect or save tries again
    }
    const act = versionAction({
      shown: baseNumber,
      latest: next.version.number,
      dirty: dirty() || conflict,
      saving: saving || measuring,
    });
    if (act === "defer") {
      pendingRefresh = true;
      if (measuring) setTimeout(() => void refresh(), 500);
      return;
    }
    void comments.loadMentions();
    if (act === "load") return loadVersion(next);
    if (act === "banner") changedBanner.hidden = false;
    applyPayload(next);
  });

  let serverHears = true;
  type LiveState = "connecting" | "live" | "offline" | "stopped";
  let liveState: LiveState = "connecting";
  const showLive = (state: LiveState) => {
    liveUp = state === "live" && serverHears;
    liveNote.hidden = state === "connecting" || (state === "live" && serverHears);
    liveNote.textContent =
      state === "stopped" ? "Live updates stopped. Reload to see the latest." : "Offline — reconnecting";
  };
  // Only a signed-in member or guest has a session to stream with.
  let liveStarted = false;
  startLive = () => {
    if (liveStarted || viewer.kind === "anonymous") return;
    liveStarted = true;
    const live = new LiveConnection(
      `/d/api/${encodeURIComponent(boot.documentId)}/events`,
      boot.shareToken ? { "x-wardby-share": boot.shareToken } : {},
      {
        onMessage: (message) => {
          const act = liveAction(message);
          if (act === "status") {
            const up = statusConnected(message.data);
            if (up !== null) serverHears = up;
            showLive(liveState);
          } else if (act) {
            void refresh();
          }
        },
        onReconnect: () => void refresh(),
        onState: (state) => {
          liveState = state;
          showLive(state);
        },
      },
    );
    live.start();
    const stopper = new HiddenStopper({
      stop: () => live.stop(),
      resume: () => {
        live.start();
        void refresh();
      },
    });
    document.addEventListener("visibilitychange", () => stopper.visible(!document.hidden));
    if (document.hidden) stopper.visible(false);
  };
  startLive();

  if (canWrite) {
    showSave("Saved");
    addEventListener("beforeunload", (e) => {
      if (dirty() || saving) e.preventDefault();
    });
  } else {
    showSave(atLeast(viewer.access, "comment") ? "Comment only" : "Read only");
  }

  void boards.ready.then(async () => {
    renderBoards();
    await runFidelity(baseNumber);
    // Marks the first fidelity pass done (it switches boards), for page tests and later steps.
    root.dataset.fidelityDone = "";
  });
}

void main();
