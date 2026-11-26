/**
 * Entry point of the document page (/d/<id> and /s/<token>): reads the
 * bootstrap the server wrote, loads the document, mounts the Tiptap editor
 * (editable for members with write) and the comment dialog, and saves edits
 * with a debounced PUT carrying the version they were based on. Live
 * updates (live.ts) refetch threads and newer versions as they happen. The
 * side panel switches between the Comments tray, the Review tab (review-ui.ts)
 * and the History tab (version history, edits-ui.ts); the review
 * banner sits under the header, and an approved or archived document is
 * read only.
 */
import "./styles.css";
import { icon, type IconName } from "./icons.js";
import {
  Api,
  ApiError,
  errorMessage,
  readBootstrap,
  type Bootstrap,
  type DocumentPayload,
  type ReviewState,
  type Viewer,
} from "./api.js";
import { atLeast, CommentsUI } from "./comments-ui.js";
import { append, clear, h } from "./dom.js";
import { pdfExportButton } from "./exports-menu.js";
import { EditsTray } from "./edits-ui.js";
import { caretColor, joinLive, type Coedit } from "./coedit.js";
import { createEditor } from "./editor.js";
import {
  coalesce,
  HiddenStopper,
  liveAction,
  LiveConnection,
  otherDocument,
  statusConnected,
  versionAction,
} from "./live.js";
import { isReopenCopy } from "./review-model.js";
import { planLinkTargets } from "./extensions.js";
import {
  planBarHost,
  planDocumentsOf,
  renderPlanBar,
  requestedTab,
  setPlanBarChooser,
  setPlanBarTab,
} from "./plan-bar.js";
import { ReviewPanel } from "./review-ui.js";
import { unresolvedLinksText } from "../../core/plans/page-payload.js";
import { hasUnkeepableSyntax, isLosslessRoundTrip, LOSSY_NOTICE } from "./roundtrip.js";
import { TextSurface } from "./text-surface.js";

const SAVE_DELAY_MS = 1500;

declare global {
  interface Window {
    __WARDBY__?: unknown;
  }
}

function fatal(root: HTMLElement, message: string): void {
  clear(root);
  root.append(h("main", { class: "fatal" }, h("h1", {}, "This document can't be shown"), h("p", {}, message)));
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
    // The page's own copy first (synchronous, so the first paint is the drawn page); a fetch otherwise.
    payload = boot.initial ?? (await api.load());
    delete boot.initial;
  } catch (err) {
    if (err instanceof ApiError && err.code === "web_session_required") {
      location.assign(boot.loginUrl);
      return;
    }
    return fatal(root, errorMessage(err));
  }
  if (payload.version.format !== "markdown") return fatal(root, "This page shows documents only. Reload to try again.");
  // Live co-editing, joined before the editor is drawn. Null (no session, no WebSocket, formatting the editor
  // cannot keep): the page saves versions the usual way.
  const coedit =
    payload.me.kind !== "anonymous" && !hasUnkeepableSyntax(payload.version.markdown)
      ? await joinLive(boot, api, payload.me.name ?? "Someone")
      : null;
  mount(root, boot, api, payload, payload.version.markdown, coedit);
}

function mount(
  root: HTMLElement,
  boot: Bootstrap,
  api: Api,
  payload: DocumentPayload,
  markdown: string,
  coedit: Coedit | null,
): void {
  let viewer: Viewer = payload.me;
  let baseNumber = payload.version.number;
  const canWrite = viewer.kind === "member" && atLeast(viewer.access, "write");

  // ---- layout ----
  const title = h("b", { class: "title" }, payload.document.title);
  const version = h("span", { class: "badge" }, `v${baseNumber}`);
  const saveState = h("span", { class: "save", aria: { live: "polite" } });
  const liveNote = h("span", { class: "live-note", hidden: true, role: "status" });
  // Export PDF: only when this server can render (a renderer is set up); same client as the design Export menu.
  const exportPdfBtn = h(
    "button",
    { type: "button", hidden: payload.document.canRender !== true, data: { action: "export-pdf" } },
    "Export PDF",
  );
  const exportNote = h("span", { class: "export-note", role: "status" });
  pdfExportButton(exportPdfBtn, exportNote, api);
  const who = h("span", { class: "who-am-i" });
  const account = h("span", { class: "account" });
  const reviewBanner = h("div", { class: "review-banner", role: "status" });
  const banner = h("div", { class: "banner", hidden: true, role: "note" });
  const lossyNotice = h("div", { class: "banner", hidden: true, role: "note" }, LOSSY_NOTICE);
  const planBar = planBarHost();
  // "Pick an option…" posts the choice to the chosen option (a guest's partial bar never offers it).
  setPlanBarChooser(planBar, (documentId, body) => api.reviewOf(documentId, body));
  const planWarnings = h("div", { class: "plan-warnings", hidden: true, role: "note" });
  const changedBanner = h(
    "div",
    { class: "banner", hidden: true, role: "note" },
    "This document changed. Reload to see the latest version. ",
    h("button", { type: "button", onClick: () => location.reload() }, "Reload"),
  );
  const editorEl = h("div", { class: "editor" });
  const margin = h("div", { class: "margin" });
  const page = h("div", { class: "page" }, editorEl, margin);
  const stage = h("div", { class: "stage" }, page);
  const panel = h("div", { class: "panel", role: "tabpanel", attrs: { id: "tray-comments" } });
  const editsPanel = h("div", { class: "panel", role: "tabpanel", hidden: true, attrs: { id: "tray-edits" } });
  const reviewPanel = h("div", { class: "panel", role: "tabpanel", hidden: true, attrs: { id: "tray-review" } });
  const count = h("span", { class: "ccount" });
  const tab = (label: string, controls: string, on: boolean, ...extra: Node[]) =>
    h(
      "button",
      {
        type: "button",
        role: "tab",
        class: on ? "on" : "",
        aria: { selected: String(on), controls },
      },
      label,
      ...extra,
    );
  const commentsTab = tab("Comments ", "tray-comments", true, count);
  const reviewTab = tab("Review", "tray-review", false);
  const historyTab = tab("History", "tray-edits", false);
  const side = h(
    "aside",
    { class: "side", aria: { label: "Comments, edits and review" } },
    h(
      "div",
      { class: "tray-tabs", role: "tablist", aria: { label: "Side panel" } },
      commentsTab,
      reviewTab,
      historyTab,
    ),
    panel,
    reviewPanel,
    editsPanel,
  );
  const bubble = h("button", { type: "button", class: "bubble", hidden: true }, icon("comment"), "Comment");
  // 💬 Comment in the top bar, as on a design page: it comments on the selected text, like the bubble and ⌘⌥M
  // (with nothing selected, the panel says to select some first). Pressing it keeps the selection.
  const commentBtn = h(
    "button",
    {
      type: "button",
      class: "primary",
      hidden: !atLeast(viewer.access, "comment"),
      title: "Comment on the selected text (⌘⌥M)",
    },
    icon("comment"),
    "Comment",
  );
  commentBtn.addEventListener("mousedown", (e) => e.preventDefault());
  const toolbar = h("div", { class: "toolbar", role: "toolbar", aria: { label: "Formatting" }, hidden: !canWrite });
  clear(root);
  append(
    root,
    h(
      "div",
      { class: "app" },
      h(
        "header",
        { class: "topbar" },
        h(
          "div",
          { class: "crumbs" },
          h("span", { class: "muted" }, "Wardby"),
          h("span", { class: "muted" }, "/"),
          h("span", { class: "muted" }, "Documents"),
          h("span", { class: "muted" }, "/"),
          title,
          version,
        ),
        // The review status, beside what the page is; then the page's actions.
        reviewBanner,
        h("div", { class: "group page-actions" }, exportPdfBtn, commentBtn),
        exportNote,
        saveState,
        liveNote,
        who,
        account,
      ),
      banner,
      changedBanner,
      lossyNotice,
      planWarnings,
      toolbar,
      // The plan rail (shown only on a plan's documents) is the first column, beside the page.
      h("div", { class: "main" }, planBar, stage, side),
    ),
  );
  document.body.append(bubble);

  // ---- the plan bar, and the plan's links (a plan document only) ----
  let planTargets = planLinkTargets(payload.planLinks);
  const renderPlan = (p: DocumentPayload) => {
    renderPlanBar(planBar, p.planSet);
    planTargets = planLinkTargets(p.planLinks);
    clear(planWarnings);
    const unresolved = p.planSet ? (p.planLinks?.unresolved ?? []) : [];
    planWarnings.hidden = unresolved.length === 0;
    if (p.planSet && unresolved.length > 0)
      append(
        planWarnings,
        h("h2", {}, "Checks"),
        h("ul", {}, h("li", {}, unresolvedLinksText(p.planSet.number, unresolved))),
      );
  };
  renderPlan(payload);

  // ---- editor ----
  const editor = createEditor(
    editorEl,
    markdown,
    canWrite,
    payload.planSet ? () => planTargets : undefined,
    coedit
      ? {
          ydoc: coedit.ydoc,
          provider: coedit.provider,
          user: { name: viewer.name ?? "Someone", color: caretColor(viewer.name ?? "Someone") },
        }
      : undefined,
  );
  // A document the editor can't keep as written opens comment-only for everyone (ruling R17).
  // Live: the server only lets documents the editor can keep go live, and the content comes from it.
  const lossless = coedit !== null || isLosslessRoundTrip(markdown, editor.getMarkdown());
  const editable = canWrite && lossless;
  let lossyLocked = false;
  const lockLossy = () => {
    lossyLocked = true;
    lossyNotice.hidden = false;
    toolbar.hidden = true;
    editor.setEditable(false, false);
  };
  if (!lossless) lockLossy();

  /** An icon-only toolbar button: the icon, the action as its accessible name, the shortcut in the tooltip. */
  const iconTb = (glyph: IconName, tip: string, aria: string, run: () => boolean) => {
    const b = tb("", aria, run);
    b.title = tip;
    b.classList.add("icon-only");
    b.append(icon(glyph));
    return b;
  };
  const tb = (label: string, aria: string, run: () => boolean) =>
    h(
      "button",
      {
        type: "button",
        aria: { label: aria },
        title: aria,
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => void run(),
      },
      label,
    );
  append(
    toolbar,
    tb("B", "Bold", () => editor.chain().focus().toggleBold().run()),
    tb("I", "Italic", () => editor.chain().focus().toggleItalic().run()),
    h("span", { class: "sep" }),
    tb("H2", "Heading 2", () => editor.chain().focus().toggleHeading({ level: 2 }).run()),
    tb("H3", "Heading 3", () => editor.chain().focus().toggleHeading({ level: 3 }).run()),
    tb("• List", "Bulleted list", () => editor.chain().focus().toggleBulletList().run()),
    tb("1. List", "Numbered list", () => editor.chain().focus().toggleOrderedList().run()),
    tb("❝", "Quote", () => editor.chain().focus().toggleBlockquote().run()),
    h("span", { class: "sep" }),
    iconTb("undo", "Undo (⌘Z)", "Undo", () => editor.chain().focus().undo().run()),
    iconTb("redo", "Redo (⇧⌘Z)", "Redo", () => editor.chain().focus().redo().run()),
  );

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

  let startLive: () => void = () => undefined;
  // Badge tooltips name mentioned people as the dialog does.
  const surface: TextSurface = new TextSurface(
    editor,
    { page, margin, bubble, stage },
    (body): string => comments.preview(body),
    coedit?.anchors(editor),
  );
  const comments = new CommentsUI(
    {
      api,
      surface,
      shareToken: boot.shareToken,
      stage,
      page,
      panel,
      count,
      onViewer: (v) => {
        viewer = v;
        renderViewer();
        startLive();
      },
      returnToLatest: () => edits.back(),
    },
    viewer,
  );
  // With nothing selected in the document, say so under the button rather than starting nothing.
  const commentHint = h(
    "div",
    { class: "btn-hint", role: "status", hidden: true },
    "Select the text you want to comment on, then click Comment.",
  );
  commentBtn.after(commentHint);
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  commentBtn.addEventListener("click", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !editorEl.contains(sel.anchorNode)) {
      commentHint.hidden = false;
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => (commentHint.hidden = true), 3500);
      return;
    }
    commentHint.hidden = true;
    comments.startComment();
  });
  // ---- the History tab (versions) ----
  const edits = new EditsTray({
    api,
    panel: editsPanel,
    stage,
    page,
    live: [editorEl, margin],
    canRestore: () => viewer.kind === "member" && atLeast(viewer.access, "write") && !locked,
    latest: () => ({ number: baseNumber, busy: saving || dirty || conflict }),
    onViewing: (viewing) => {
      comments.suspend(viewing);
      toolbar.hidden = viewing || !canEditNow();
    },
    onRestored: () => void refresh(),
    openThread: (n) => {
      showTray("comments");
      comments.revealNumber(n);
    },
  });
  const trays = [
    { which: "comments", tab: commentsTab, panel },
    { which: "review", tab: reviewTab, panel: reviewPanel },
    { which: "history", tab: historyTab, panel: editsPanel },
  ] as const;
  const showTray = (which: (typeof trays)[number]["which"]) => {
    for (const t of trays) {
      const on = t.which === which;
      t.panel.hidden = !on;
      t.tab.className = on ? "on" : "";
      t.tab.setAttribute("aria-selected", String(on));
    }
    setPlanBarTab(planBar, which);
    if (which === "history") void edits.open();
  };
  commentsTab.addEventListener("click", () => showTray("comments"));
  reviewTab.addEventListener("click", () => showTray("review"));
  historyTab.addEventListener("click", () => showTray("history"));
  // Arriving from another document of the plan: open the tab that was open there (a design's Style
  // and Settings have no counterpart here).
  const askedTray = requestedTab(["comments", "review", "history"] as const, {
    style: "comments",
    settings: "comments",
  });
  if (askedTray && askedTray !== "comments") showTray(askedTray);

  renderViewer();
  comments.apply(payload);
  void comments.loadMentions();
  // The agent-run poll is a fallback for when live updates are not connected.
  let liveUp = false;
  comments.startPolling(() => liveUp);
  comments.openFromHash();
  addEventListener("hashchange", () => comments.openFromHash());

  // ---- saving ----
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let dirty = false;
  let conflict = false;
  let pendingRefresh = false;

  const showSave = (text: string, reload = false) => {
    clear(saveState);
    saveState.className = `save${reload ? " bad" : ""}`;
    // A fixed-width slot (styles.css): the full text as a tooltip when a long one is cut short.
    saveState.title = text;
    append(
      saveState,
      h("span", { class: "save-text" }, text),
      reload ? h("button", { type: "button", onClick: () => location.reload() }, "Reload") : null,
    );
  };

  /** A save was refused as locked: the edits stay unsaved, with no retry, until the refetch shows the lock. */
  let refusedLocked = false;
  const save = async (): Promise<void> => {
    // Locked: the edits wait (still unsaved) for a reopen and the next edit, never a timer.
    if (saving || conflict || !dirty || locked) return;
    saving = true;
    dirty = false;
    showSave("Saving…");
    try {
      const r = await api.saveContent(editor.getMarkdown(), baseNumber);
      refusedLocked = false;
      baseNumber = r.version.number;
      version.textContent = `v${baseNumber}`;
      showSave(dirty ? "Unsaved changes" : "Saved");
      review.markRead(baseNumber);
      // The server re-anchored the threads against the new version.
      await comments.reload().catch(() => undefined);
      void edits.refresh();
    } catch (err) {
      dirty = true;
      if (
        err instanceof ApiError &&
        (err.code === "document_version_conflict" || err.code === "document_base_unavailable")
      ) {
        conflict = true;
        editor.setEditable(false);
        showSave(errorMessage(err), true);
      } else if (err instanceof ApiError && err.code === "document_locked") {
        // Approved or archived since the edit began: not the user's fault, and retrying cannot help.
        // The edits stay unsaved; refetch so the review lock shows (a live event may not have arrived yet).
        refusedLocked = true;
        showSave(errorMessage(err));
        pendingRefresh = true;
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
    if (dirty && !conflict && !refusedLocked) schedule();
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DELAY_MS);
  };

  // ---- the review lock: an approved or archived document is read only ----
  let locked = false;
  let lockState: ReviewState = "draft";
  /** The live editor takes edits; the toolbar also hides while a version is being viewed. */
  const canEditText = () => editable && !lossyLocked && !locked && !conflict;
  const canEditNow = () => canEditText() && !edits.isViewing;
  /** The save state when nothing is being saved: what this viewer can do with the document now. */
  const restingSaveText = () => {
    if (locked) {
      // Edits from before the lock wait, unsaved, for a reopen.
      const word = lockState === "archived" ? "Read only: archived" : "Read only: approved";
      return dirty ? `${word} · unsaved changes` : word;
    }
    if (editable && !lossyLocked && coedit) return "Live";
    if (editable && !lossyLocked) return dirty ? "Unsaved changes" : "Saved";
    return atLeast(viewer.access, "comment") ? "Comment only" : "Read only";
  };
  const applyLock = (on: boolean, state: ReviewState) => {
    locked = on;
    lockState = state;
    editor.setEditable(canEditText(), false);
    toolbar.hidden = !canEditNow();
    // A conflict keeps its own message (with Reload).
    if (!conflict) showSave(restingSaveText());
  };

  // ---- live updates ----
  /** Shows a newer version in place, keeping the scroll position and (where it still fits) the selection. */
  const loadVersion = (next: DocumentPayload) => {
    if (next.version.format !== "markdown") return;
    const scroll = stage.scrollTop;
    const { from, to } = editor.state.selection;
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(next.version.markdown, { emitUpdate: false, contentType: "markdown" })
      .run();
    const size = editor.state.doc.content.size;
    try {
      editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) });
    } catch {
      /* the old selection does not map onto the new document */
    }
    stage.scrollTop = scroll;
    baseNumber = next.version.number;
    version.textContent = `v${baseNumber}`;
    if (!isLosslessRoundTrip(next.version.markdown, editor.getMarkdown())) lockLossy();
    // Re-anchor every thread against the new text.
    surface.reset();
    comments.apply(next);
    review.apply(next.review);
  };

  /** Refetches the document and threads; a newer version loads in place unless there are unsaved edits. */
  const refresh = coalesce(async () => {
    let next: DocumentPayload;
    try {
      next = await api.load();
    } catch {
      return; // the next event, reconnect or save tries again
    }
    // The plan bar follows every refetch, also while a newer version waits for unsaved edits.
    renderPlan(next);
    const act = versionAction({
      shown: baseNumber,
      latest: next.version.number,
      dirty: dirty || conflict,
      saving,
      copyOfShown: !conflict && isReopenCopy(next.review, baseNumber, next.version.number),
    });
    if (act === "defer") {
      pendingRefresh = true;
      return;
    }
    // A guest who commented since the page loaded becomes mentionable, so the @-list is refreshed with the threads.
    void comments.loadMentions();
    // Live: the editor already holds the newest text (a version is a checkpoint of it); only the number moves.
    if (act === "load" && coedit) {
      baseNumber = next.version.number;
      version.textContent = `v${baseNumber}`;
    } else if (act === "load") return loadVersion(next);
    if (act === "banner") changedBanner.hidden = false;
    // A reopen's copy of the shown version: same text, so only the number moves; unsaved edits save over it.
    if (act === "adopt") {
      baseNumber = next.version.number;
      version.textContent = `v${baseNumber}`;
    }
    comments.apply(next);
    review.apply(next.review);
    // A refused save whose refetch finds it open again (reopened since): the edits wait for the next edit.
    if (refusedLocked) {
      refusedLocked = false;
      if (!conflict && !saving) showSave(restingSaveText());
    }
  });

  /** Another document of the plan set changed: only the plan bar is refetched. */
  const refreshPlan = coalesce(async () => {
    try {
      renderPlan(await api.load());
    } catch {
      /* the next event or reconnect tries again */
    }
  });

  // ---- the review banner and Review tab ----
  const review = new ReviewPanel(
    {
      api,
      banner: reviewBanner,
      planDocuments: () => planDocumentsOf(planBar),
      panel: reviewPanel,
      showReviewTab: () => showTray("review"),
      showChanges: (from, to) => {
        showTray("history");
        void edits.viewChanges(from, to);
      },
      loadLatest: () => refresh(),
      onLock: applyLock,
      onState: (s) => root.querySelector(".app")?.classList.toggle("archived", s === "archived"),
    },
    payload.review,
    payload.version.number,
  );

  let serverHears = true;
  const showLive = (state: "connecting" | "live" | "offline" | "stopped") => {
    liveUp = state === "live" && serverHears;
    liveNote.hidden = state === "connecting" || (state === "live" && serverHears);
    liveNote.textContent =
      state === "stopped" ? "Live updates stopped. Reload to see the latest." : "Offline — reconnecting";
  };
  let liveState: "connecting" | "live" | "offline" | "stopped" = "connecting";
  // Only a signed-in member or guest has a session to stream with: a visitor on a share link starts
  // listening once they continue as a guest.
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
            // `hello` carries the same `connected` field as `status`.
            const up = statusConnected(message.data);
            if (up !== null) serverHears = up;
            showLive(liveState);
          } else if (act && otherDocument(message.data, boot.documentId)) {
            void refreshPlan();
          } else if (act) {
            void refresh();
            // A new version only updates the Edits list; a version being viewed stays on screen.
            if (act === "version" || act === "resync") void edits.refresh();
          }
        },
        onReconnect: () => {
          void refresh();
          void edits.refresh();
        },
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
        void edits.refresh();
      },
    });
    document.addEventListener("visibilitychange", () => stopper.visible(!document.hidden));
    if (document.hidden) stopper.visible(false);
  };
  startLive();

  showSave(coedit?.refusedNotice ?? restingSaveText());
  // After a reconnect the shared document may have moved on: place the comments again from it.
  coedit?.onResync(() => {
    surface.reset();
    void refresh();
  });
  if (editable && !coedit) {
    editor.on("update", ({ transaction }) => {
      if (!transaction.docChanged || conflict || locked) return;
      dirty = true;
      showSave("Unsaved changes");
      schedule();
    });
    addEventListener("beforeunload", (e) => {
      if (dirty || saving) e.preventDefault();
    });
  }
}

void main();
