/**
 * Entry point of the design page (/d/<id> and /s/<token> for a design): reads the bootstrap, loads the
 * design, mounts GrapesJS (boards-editor.ts) with its managers in Wardby's sidebars, and saves a
 * writer's edits with a debounced PUT of the changed files only, based on the version shown. Live
 * updates (live.ts) refetch threads and newer versions as documents.ts does. A writer's first view of a
 * version runs the import fidelity check (fidelity.ts) and reports it once.
 * The review banner and Review tab are the shared panel (review-ui.ts); an approved or archived
 * design opens read-only.
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
  type FrameBoard,
  type Viewer,
} from "./api.js";
import { createBoardsEditor, ManifestUnreadableError, type BoardsEditor, type DeviceId } from "./boards-editor.js";
import { atLeast, CommentsUI } from "./comments-ui.js";
import { append, clear, h } from "./dom.js";
import { measureFidelity } from "./fidelity.js";
import { DesignSurface } from "./design-surface.js";
import { DesignHistory } from "./design-history.js";
import { exportsMenu } from "./exports-menu.js";
import { openOverview } from "./overview.js";
import { openPlay } from "./play.js";
import {
  coalesce,
  HiddenStopper,
  liveAction,
  LiveConnection,
  otherDocument,
  statusConnected,
  versionAction,
} from "./live.js";
import { planBarHost, planDocumentsOf, renderPlanBar, requestedTab, setPlanBarTab } from "./plan-bar.js";
import { ReviewPanel } from "./review-ui.js";
import { isLockedState, isReopenCopy } from "./review-model.js";

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
  // An approved or archived design opens read-only. A page opened editable that is locked while open
  // turns read-only in place (the review panel's onLock below); a page opened locked and then
  // reopened asks for a reload.
  const startLocked = isLockedState(payload.review.state);
  const canEdit = canWrite && !startLocked;
  /** The server says approved or archived: nothing is saved from this page. */
  let lockedNow = startLocked;
  /** The lock the page shows (its tabs and the lock banner), which can trail lockedNow by one refetch. */
  let shownLock = startLocked;
  let lockState: string = payload.review.state;

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
  const lockBanner = h("div", { class: "banner lock-banner", hidden: true, role: "note" });
  const reviewBanner = h("div", { class: "review-banner", role: "status" });
  const planBar = planBarHost();
  renderPlanBar(planBar, payload.planSet);
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
  const overviewBtn = h("button", { type: "button", data: { action: "overview" } }, "▦ Overview");
  const playBtn = h("button", { type: "button", data: { action: "play" } }, "▶ Play");
  const exportBtn = h("button", { type: "button", data: { action: "export" } }, "Export ▾");
  const commentBtn = h("button", { type: "button", class: "primary", data: { action: "comment" } }, "💬 Comment");

  const boardsList = h("ul", { class: "boards", aria: { label: "Boards" } });
  const addBoardBtn = h("button", { type: "button", class: "add-board", hidden: !canEdit }, "+ Board");
  const layersPanel = h("div", { class: "gjs-host layers" });
  const stylesPanel = h("div", { class: "gjs-host styles" });
  const selectorsPanel = h("div", { class: "gjs-host selectors" });
  const traitsPanel = h("div", { class: "gjs-host traits" });
  const canvasEl = h("div", { class: "canvas" });
  // Comment pins over the canvas (design-surface.ts).
  const pinsLayer = h("div", { class: "pins" });
  const canvasWrap = h("div", { class: "canvas-wrap" }, canvasEl, pinsLayer);

  const checks = h("div", { class: "checks", hidden: true, role: "note" });
  const commentsPanel = h("div", { class: "panel" });
  const count = h("span", { class: "ccount" });
  const historyPanel = h("div", { class: "panel" });
  const reviewPanelEl = h("div", { class: "panel" });
  type Tab = "style" | "settings" | "comments" | "review" | "history";
  const tabs: Record<Tab, HTMLButtonElement> = {
    style: h("button", { type: "button", role: "tab", data: { tab: "style" }, hidden: !canEdit }, "Style"),
    settings: h("button", { type: "button", role: "tab", data: { tab: "settings" }, hidden: !canEdit }, "Settings"),
    comments: h("button", { type: "button", role: "tab", data: { tab: "comments" } }, "Comments ", count),
    review: h("button", { type: "button", role: "tab", data: { tab: "review" } }, "Review"),
    history: h("button", { type: "button", role: "tab", data: { tab: "history" } }, "History"),
  };
  const panes: Record<Tab, HTMLElement> = {
    style: h("div", { class: "tabpane", role: "tabpanel" }, selectorsPanel, stylesPanel),
    settings: h("div", { class: "tabpane", role: "tabpanel" }, traitsPanel),
    comments: h("div", { class: "tabpane", role: "tabpanel" }, checks, commentsPanel),
    review: h("div", { class: "tabpane", role: "tabpanel" }, reviewPanelEl),
    history: h("div", { class: "tabpane", role: "tabpanel" }, historyPanel),
  };
  const TABS: Tab[] = ["comments", "review", "history", "style", "settings"];
  /** Between the tabs every page has (Comments, Review, History) and the editor's Style and Settings. */
  const editToolsSep = h("span", { class: "tab-sep", hidden: !canEdit, aria: { hidden: "true" } });
  const showTab = (which: Tab) => {
    for (const k of TABS) {
      const on = k === which;
      tabs[k].className = on ? "on" : "";
      tabs[k].setAttribute("aria-selected", String(on));
      panes[k].hidden = !on;
    }
    setPlanBarTab(planBar, which);
  };
  for (const k of TABS) {
    tabs[k].addEventListener("click", () => {
      showTab(k);
      if (k === "history") void designHistory.open();
    });
  }
  // Arriving from another document of the plan: open the tab that was open there; Style and Settings
  // only for someone who can edit.
  const askedTab = requestedTab(canEdit ? TABS : (["comments", "review", "history"] as const));
  showTab(askedTab ?? (canEdit ? "style" : "comments"));

  const layersHeading = h("h2", { hidden: !canEdit }, "Layers");
  const layersHost = h("div", { hidden: !canEdit }, layersPanel);
  const leftSide = h(
    "aside",
    { class: "dside left", aria: { label: "Boards and layers" } },
    h("h2", {}, "Boards"),
    boardsList,
    addBoardBtn,
    layersHeading,
    layersHost,
  );
  const undoGroup = h("div", { class: "group", hidden: !canEdit }, undoBtn, redoBtn);
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
        undoGroup,
        h("div", { class: "group" }, overviewBtn, playBtn, exportBtn, commentBtn),
        saveState,
        liveNote,
        who,
        account,
      ),
      reviewBanner,
      planBar,
      banner,
      changedBanner,
      lockBanner,
      saveBanner,
      h(
        "div",
        { class: "design-main" },
        leftSide,
        canvasWrap,
        h(
          "aside",
          { class: "dside right", aria: { label: "Style, settings, comments and review" } },
          h(
            "div",
            { class: "tray-tabs", role: "tablist", aria: { label: "Side panel" } },
            tabs.comments,
            tabs.review,
            tabs.history,
            editToolsSep,
            tabs.style,
            tabs.settings,
          ),
          panes.comments,
          panes.review,
          panes.history,
          panes.style,
          panes.settings,
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
      editable: canEdit,
    });
  } catch (err) {
    if (err instanceof ManifestUnreadableError) return fatal(root, MANIFEST_UNREADABLE);
    throw err;
  }
  const boardNames = () => new Map(boards.manifest().boards.map((b) => [b.id, b.name]));

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
  /** Comment pins; it also puts the 💬 counts in the boards list (set below, before any board loads). */
  let surface: DesignSurface | null = null;
  /** The fidelity pass switches boards: saves, live reloads and the boards list wait until it is done. */
  let measuring = false;
  /** Runs a board change from a dialog once no fidelity pass is running (one can start while it is open). */
  const afterMeasuring = (run: () => void) => {
    if (measuring) setTimeout(() => afterMeasuring(run), 200);
    else run();
  };
  /**
   * The board whose ⋯ menu is open. The list is rebuilt on every change, save and fidelity pass, so
   * the open menu is kept here and shown again by renderBoards (hidden while a pass runs, as the
   * list is disabled then); otherwise a save landing just after the click would close it.
   */
  let openMenu: string | null = null;
  const closeMenus = () => {
    openMenu = null;
    for (const m of Array.from(boardsList.querySelectorAll<HTMLElement>(".bmenu"))) m.hidden = true;
  };
  const renderBoards = () => {
    clear(boardsList);
    boardsList.setAttribute("aria-busy", String(measuring));
    addBoardBtn.disabled = measuring;
    const list = boards.manifest().boards;
    if (openMenu !== null && !list.some((b) => b.id === openMenu)) openMenu = null;
    list.forEach((b, i) => {
      const on = b.id === boards.currentBoard();
      const pick = h(
        "button",
        { type: "button", class: "pick", disabled: measuring, aria: { current: String(on) } },
        h("span", { class: "name" }, b.name),
      );
      pick.addEventListener("click", () => {
        if (!measuring) boards.selectBoard(b.id);
      });
      const li = h("li", { class: on ? "on" : "", data: { board: b.id } }, pick);
      if (canEdit && !shownLock) {
        const menu = h("div", { class: "bmenu", role: "menu", hidden: measuring || openMenu !== b.id });
        const item = (label: string, run: () => void, disabled = false) =>
          h(
            "button",
            {
              type: "button",
              role: "menuitem",
              disabled,
              onClick: () => {
                menu.hidden = true;
                openMenu = null;
                run();
              },
            },
            label,
          );
        append(
          menu,
          item("Rename…", () => {
            void askDialog({ title: "Rename board", value: b.name, ok: "Rename" }).then((name) => {
              if (name) afterMeasuring(() => boards.renameBoard(b.id, name));
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
                if (ok) afterMeasuring(() => boards.deleteBoard(b.id));
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
          if (show) openMenu = b.id;
        });
        li.append(more, menu);
      }
      boardsList.append(li);
    });
    surface?.refreshCounts();
  };
  document.addEventListener("mousedown", (e) => {
    if (!(e.target as Element).closest?.(".boards li")) closeMenus();
  });
  boards.onBoard(() => renderBoards());
  addBoardBtn.addEventListener("click", () => {
    if (measuring) return;
    void askDialog({ title: "New board", value: "", ok: "Add board" }).then((name) => {
      if (name) afterMeasuring(() => boards.addBoard(name));
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
  // One surface for the page: board switches and new versions reuse it (no listeners pile up).
  const pins: DesignSurface = new DesignSurface(
    boards,
    { pins: pinsLayer, commentButton: commentBtn, boardsList },
    boardNames,
    (body: string): string => comments.preview(body),
    afterMeasuring,
  );
  surface = pins;
  const comments: CommentsUI = new CommentsUI(
    {
      api,
      surface: pins,
      shareToken: boot.shareToken,
      stage: canvasWrap,
      page: canvasWrap,
      panel: commentsPanel,
      count,
      returnToLatest: () => designHistory.back(),
      onViewer: (v) => {
        viewer = v;
        renderViewer();
        startLive();
      },
    },
    viewer,
  );
  // The button also toggles pin mode (design-surface.ts); the threads show while commenting.
  commentBtn.addEventListener("click", () => showTab("comments"));
  // ---- version history: the History tab, an older version read-only, Restore ----
  const designHistory = new DesignHistory({
    api,
    panel: historyPanel,
    stage: canvasWrap,
    canRestore: () => canWrite && !lockedNow,
    latest: () => ({ number: baseNumber, busy: dirty() || saving || measuring || conflict }),
    onViewing: (viewing) => {
      // The editor stays as it is under the older version; it cannot be reached, and comments wait.
      comments.suspend(viewing);
      // Nothing stays selected, and the Style and Settings panes cannot edit it (Comments and History stay live).
      if (viewing) boards.editor.select();
      canvasEl.inert = viewing;
      leftSide.inert = viewing;
      panes.style.inert = viewing;
      panes.settings.inert = viewing;
      undoBtn.disabled = viewing;
      redoBtn.disabled = viewing;
      if (viewing) (document.activeElement as HTMLElement | null)?.blur();
    },
    onRestored: () => void refresh(),
  });
  let historyNumber = baseNumber;
  /** Threads, the boards list and History; the mount shows the first payload's review through the panel itself. */
  const applyThreads = (p: DocumentPayload) => {
    comments.apply(p);
    commentBtn.hidden = !comments.canComment;
    renderBoards();
    if (p.version.number !== historyNumber) {
      historyNumber = p.version.number;
      void designHistory.refresh();
    }
  };
  /** A refetched payload (after the mount): its review too. `review` is created below, once refresh exists. */
  const applyPayload = (p: DocumentPayload) => {
    applyThreads(p);
    const refused = lockedNow && !shownLock;
    review.apply(p.review);
    lockedNow = review.locked;
    // A save refused as locked, and the design is open again (approved and reopened inside one save
    // cycle): the edits wait, unsaved, for the next edit or Overview, Play or Export.
    if (refused && !lockedNow && !conflict && !saving) showSave(restingSaveText());
  };

  renderViewer();
  applyThreads(payload);
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
  /**
   * The board holds edits not saved yet, also while locked: they wait for a reopen, and a newer version
   * then shows the changed banner instead of replacing them.
   */
  const dirty = () => canEdit && boards.dirty();
  /** Unsaved edits that may be saved now: none while the design is locked. */
  const canSaveNow = () => dirty() && !lockedNow;
  /** The save state when nothing is being saved: what this viewer can do with the design now. */
  const restingSaveText = () => {
    if (lockedNow) return `Read only: ${lockState}${dirty() ? " · unsaved changes" : ""}`;
    if (canEdit) return dirty() ? "Unsaved changes" : "Saved";
    return atLeast(viewer.access, "comment") ? "Comment only" : "Read only";
  };

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
    if (saving || conflict || measuring || lockedNow) return;
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
      review.markRead(baseNumber);
      saveBanner.hidden = true;
      showSave(dirty() ? "Unsaved changes" : "Saved");
      // The server re-anchored the threads against the new version; the warnings are the new version's.
      await refreshPayload();
      if (!dirty()) scheduleFidelity();
    } catch (err) {
      if (err instanceof ApiError && err.code === "document_version_conflict") {
        conflict = true;
        showSave(errorMessage(err), true);
      } else if (err instanceof ApiError && err.code === "document_locked") {
        // Approved or archived since the edit began: retrying cannot help. Saves stop, and the
        // refetch below shows the lock (a live event may not have arrived yet).
        lockedNow = true;
        showSave(errorMessage(err));
        pendingRefresh = true;
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
    if (!canEdit || lockedNow || conflict || measuring) return;
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
    if (!canEdit || measuring || warnings.some((w) => w.kind === "fidelity")) return;
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
    if (canSaveNow()) schedule();
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

  // ---- Overview, Play and Export ----
  /** Saves pending edits first, so the frames and exports show what the page shows. */
  const flushSave = async () => {
    if (!canSaveNow() || conflict || measuring) return;
    clearTimeout(timer);
    await save();
  };
  let opening = false;
  /** One overlay at a time; the board frames come from the server for the version shown. */
  const openFrames = async (mode: "play" | "overview", open: (frames: FrameBoard[]) => void) => {
    // Not over an older version either: one layer at a time, so Esc closes just one.
    if (opening || designHistory.isViewing || root.querySelector(":scope > .overlay")) return;
    opening = true;
    try {
      await flushSave();
      open(await api.frames(mode, baseNumber));
    } catch (err) {
      clear(saveBanner);
      saveBanner.append(errorMessage(err));
      saveBanner.hidden = false;
    } finally {
      opening = false;
    }
  };
  overviewBtn.addEventListener("click", () => {
    void openFrames("overview", (frames) => {
      openOverview(root, frames, (id) => afterMeasuring(() => boards.selectBoard(id)));
    });
  });
  playBtn.addEventListener("click", () => {
    void openFrames("play", (frames) => {
      openPlay(root, frames, boards.currentBoard());
    });
  });
  exportsMenu(
    exportBtn,
    api,
    () => designHistory.viewed() ?? { board: boards.currentBoard(), version: baseNumber },
    payload.document.canRender === true,
  );

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
    // The plan bar follows every refetch, also while a newer version waits for unsaved edits.
    renderPlanBar(planBar, next.planSet);
    const act = versionAction({
      shown: baseNumber,
      latest: next.version.number,
      dirty: dirty() || conflict,
      saving: saving || measuring,
      copyOfShown: !conflict && isReopenCopy(next.review, baseNumber, next.version.number),
    });
    if (act === "defer") {
      pendingRefresh = true;
      if (measuring) setTimeout(() => void refresh(), 500);
      return;
    }
    void comments.loadMentions();
    if (act === "load") return loadVersion(next);
    if (act === "banner") changedBanner.hidden = false;
    // A reopen's copy of the shown version: same boards, so only the number moves; unsaved edits save over it.
    if (act === "adopt") {
      baseNumber = next.version.number;
      version.textContent = `design · v${baseNumber}`;
      warnings = next.version.warnings ?? [];
      renderChecks();
      applyPayload(next);
      // As loadVersion does: the copy has no fidelity result yet.
      void runFidelity(baseNumber);
      return;
    }
    applyPayload(next);
  });

  /** Another document of the plan set changed: only the plan bar is refetched. */
  const refreshPlan = coalesce(async () => {
    try {
      renderPlanBar(planBar, (await api.load()).planSet);
    } catch {
      /* the next event or reconnect tries again */
    }
  });

  // ---- the review banner and Review tab ----
  /** The lock banner, for a lock that differs from how the page was mounted. */
  const renderLockBanner = () => {
    clear(lockBanner);
    // Back to how the page was mounted (approved, then reopened, then approved again): no banner.
    lockBanner.hidden = shownLock === startLocked;
    if (lockBanner.hidden) return;
    // Locked in place needs no reload; a page opened read-only must reload to edit after a reopen.
    if (shownLock)
      lockBanner.append(`This design was ${lockState}, so it's read-only now. Reopen it for review to edit it.`);
    else
      lockBanner.append(
        "This design was reopened for review. Reload to edit it. ",
        h("button", { type: "button", onClick: () => location.reload() }, "Reload"),
      );
  };
  const review = new ReviewPanel(
    {
      api,
      banner: reviewBanner,
      planDocuments: () => planDocumentsOf(planBar),
      panel: reviewPanelEl,
      showReviewTab: () => showTab("review"),
      showChanges: (from, to) => {
        showTab("history");
        void designHistory.open();
        void designHistory.view(to, from);
      },
      loadLatest: () => refresh(),
      onLock: (on, state) => {
        lockedNow = on;
        const reworded = state !== lockState;
        lockState = state;
        if (on === shownLock) {
          // Still locked, in another word (approved to archived): the save state and banner follow.
          if (on && reworded) {
            if (!conflict && !saving) showSave(restingSaveText());
            renderLockBanner();
          }
          return;
        }
        shownLock = on;
        // A page mounted editable turns read-only in place, the way a page mounted locked is: the
        // board takes no edits, and Style, Settings, + Board, Layers and undo are gone.
        if (canEdit) {
          // Text being typed when it locked joins the board's unsaved edits: the save state then says so.
          void boards.setEditable(!on).then(() => {
            if (lockedNow === on && !conflict && !saving) showSave(restingSaveText());
          });
          if (on) (document.activeElement as HTMLElement | null)?.blur();
          tabs.style.hidden = on;
          tabs.settings.hidden = on;
          editToolsSep.hidden = on;
          addBoardBtn.hidden = on;
          layersHeading.hidden = on;
          layersHost.hidden = on;
          undoGroup.hidden = on;
          if (on && (!panes.style.hidden || !panes.settings.hidden)) showTab("comments");
          renderBoards();
          // Reopened: edits from before the lock are not saved on a timer; they show as unsaved and
          // go with the next edit (or Overview, Play or Export).
        }
        if (!conflict) showSave(restingSaveText());
        renderLockBanner();
      },
      onState: (s) => root.querySelector(".app")?.classList.toggle("archived", s === "archived"),
    },
    payload.review,
    payload.version.number,
  );

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
          } else if (act && otherDocument(message.data, boot.documentId)) {
            void refreshPlan();
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

  showSave(restingSaveText());
  if (canEdit) {
    addEventListener("beforeunload", (e) => {
      if (dirty() || saving) e.preventDefault();
    });
  }

  /** A plan link to a board (`#board-<id>`) opens that board. */
  const openBoardFromHash = () => {
    // Board ids are [a-z0-9-] only, so the hash needs no decoding.
    const id = /^#board-(.+)$/.exec(location.hash)?.[1] ?? "";
    if (BOARD_ID.test(id)) afterMeasuring(() => boards.selectBoard(id));
  };
  addEventListener("hashchange", openBoardFromHash);

  void boards.ready.then(async () => {
    renderBoards();
    await runFidelity(baseNumber);
    openBoardFromHash();
    // Marks the first fidelity pass done (it switches boards), for page tests and later steps.
    root.dataset.fidelityDone = "";
  });
}

void main();
