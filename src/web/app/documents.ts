/**
 * Entry point of the document page (/d/<id> and /s/<token>): reads the
 * bootstrap the server wrote, loads the document, mounts the Tiptap editor
 * (editable for members with write) and the comment dialog, and saves edits
 * with a debounced PUT carrying the version they were based on. Live
 * updates (live.ts) refetch threads and newer versions as they happen. The
 * side panel switches between the Comments tray and the Edits tray (version
 * history, edits-ui.ts).
 */
import "./styles.css";
import {
  Api,
  ApiError,
  errorMessage,
  readBootstrap,
  type Bootstrap,
  type DocumentPayload,
  type Viewer,
} from "./api.js";
import { atLeast, CommentsUI } from "./comments-ui.js";
import { append, clear, h } from "./dom.js";
import { EditsTray } from "./edits-ui.js";
import { createEditor, setHighlights } from "./editor.js";
import { coalesce, HiddenStopper, liveAction, LiveConnection, statusConnected, versionAction } from "./live.js";
import { isLosslessRoundTrip, LOSSY_NOTICE } from "./roundtrip.js";

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
    payload = await api.load();
  } catch (err) {
    if (err instanceof ApiError && err.code === "web_session_required") {
      location.assign(boot.loginUrl);
      return;
    }
    return fatal(root, errorMessage(err));
  }
  mount(root, boot, api, payload);
}

function mount(root: HTMLElement, boot: Bootstrap, api: Api, payload: DocumentPayload): void {
  let viewer: Viewer = payload.me;
  let baseNumber = payload.version.number;
  const canWrite = viewer.kind === "member" && atLeast(viewer.access, "write");

  // ---- layout ----
  const title = h("b", { class: "title" }, payload.document.title);
  const version = h("span", { class: "badge" }, `v${baseNumber}`);
  const saveState = h("span", { class: "save", aria: { live: "polite" } });
  const liveNote = h("span", { class: "live-note", hidden: true, role: "status" });
  const who = h("span", { class: "who-am-i" });
  const account = h("span", { class: "account" });
  const banner = h("div", { class: "banner", hidden: true, role: "note" });
  const lossyNotice = h("div", { class: "banner", hidden: true, role: "note" }, LOSSY_NOTICE);
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
  const editsTab = tab("Edits", "tray-edits", false);
  const side = h(
    "aside",
    { class: "side", aria: { label: "Comments and edits" } },
    h("div", { class: "tray-tabs", role: "tablist", aria: { label: "Side panel" } }, commentsTab, editsTab),
    panel,
    editsPanel,
  );
  const bubble = h("button", { type: "button", class: "bubble", hidden: true }, "💬 Comment");
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
        saveState,
        liveNote,
        who,
        account,
      ),
      banner,
      changedBanner,
      lossyNotice,
      toolbar,
      h("div", { class: "main" }, stage, side),
    ),
  );
  document.body.append(bubble);

  // ---- editor ----
  const editor = createEditor(editorEl, payload.version.markdown, canWrite);
  // A document the editor can't keep as written opens comment-only for everyone (ruling R17).
  const lossless = isLosslessRoundTrip(payload.version.markdown, editor.getMarkdown());
  const editable = canWrite && lossless;
  let lossyLocked = false;
  const lockLossy = () => {
    lossyLocked = true;
    lossyNotice.hidden = false;
    toolbar.hidden = true;
    editor.setEditable(false, false);
  };
  if (!lossless) lockLossy();

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
    tb("Undo", "Undo", () => editor.chain().focus().undo().run()),
    tb("Redo", "Redo", () => editor.chain().focus().redo().run()),
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
  const comments = new CommentsUI(
    {
      api,
      editor,
      shareToken: boot.shareToken,
      stage,
      page,
      margin,
      panel,
      count,
      bubble,
      onViewer: (v) => {
        viewer = v;
        renderViewer();
        startLive();
      },
      returnToLatest: () => edits.back(),
    },
    viewer,
  );
  // ---- the Edits tray ----
  const edits = new EditsTray({
    api,
    panel: editsPanel,
    stage,
    page,
    live: [editorEl, margin],
    canRestore: () => viewer.kind === "member" && atLeast(viewer.access, "write"),
    latest: () => ({ number: baseNumber, busy: saving || dirty || conflict }),
    onViewing: (viewing) => {
      comments.suspend(viewing);
      toolbar.hidden = viewing || !editable || lossyLocked;
    },
    onRestored: () => void refresh(),
    openThread: (n) => {
      showTray("comments");
      comments.revealNumber(n);
    },
  });
  const showTray = (which: "comments" | "edits") => {
    const isEdits = which === "edits";
    panel.hidden = isEdits;
    editsPanel.hidden = !isEdits;
    commentsTab.className = isEdits ? "" : "on";
    editsTab.className = isEdits ? "on" : "";
    commentsTab.setAttribute("aria-selected", String(!isEdits));
    editsTab.setAttribute("aria-selected", String(isEdits));
    if (isEdits) void edits.open();
  };
  commentsTab.addEventListener("click", () => showTray("comments"));
  editsTab.addEventListener("click", () => showTray("edits"));

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
    append(
      saveState,
      text,
      reload ? h("button", { type: "button", onClick: () => location.reload() }, "Reload") : null,
    );
  };

  const save = async (): Promise<void> => {
    if (saving || conflict || !dirty) return;
    saving = true;
    dirty = false;
    showSave("Saving…");
    try {
      const r = await api.saveContent(editor.getMarkdown(), baseNumber);
      baseNumber = r.version.number;
      version.textContent = `v${baseNumber}`;
      showSave(dirty ? "Unsaved changes" : "Saved");
      // The server re-anchored the threads against the new version.
      await comments.reload().catch(() => undefined);
      void edits.refresh();
    } catch (err) {
      dirty = true;
      if (err instanceof ApiError && err.code === "document_version_conflict") {
        conflict = true;
        editor.setEditable(false);
        showSave(errorMessage(err), true);
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
    if (dirty && !conflict) schedule();
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DELAY_MS);
  };

  // ---- live updates ----
  /** Shows a newer version in place, keeping the scroll position and (where it still fits) the selection. */
  const loadVersion = (next: DocumentPayload) => {
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
    setHighlights(editor, { ranges: [] });
    comments.apply(next);
  };

  /** Refetches the document and threads; a newer version loads in place unless there are unsaved edits. */
  const refresh = coalesce(async () => {
    let next: DocumentPayload;
    try {
      next = await api.load();
    } catch {
      return; // the next event, reconnect or save tries again
    }
    const act = versionAction({ shown: baseNumber, latest: next.version.number, dirty: dirty || conflict, saving });
    if (act === "defer") {
      pendingRefresh = true;
      return;
    }
    // A guest who commented since the page loaded becomes mentionable, so the @-list is refreshed with the threads.
    void comments.loadMentions();
    if (act === "load") return loadVersion(next);
    if (act === "banner") changedBanner.hidden = false;
    comments.apply(next);
  });

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

  if (editable) {
    showSave("Saved");
    editor.on("update", ({ transaction }) => {
      if (!transaction.docChanged || conflict) return;
      dirty = true;
      showSave("Unsaved changes");
      schedule();
    });
    addEventListener("beforeunload", (e) => {
      if (dirty || saving) e.preventDefault();
    });
  } else {
    showSave(atLeast(viewer.access, "comment") ? "Comment only" : "Read only");
  }
}

void main();
