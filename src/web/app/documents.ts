/**
 * Entry point of the document page (/d/<id> and /s/<token>): reads the
 * bootstrap the server wrote, loads the document, mounts the Tiptap editor
 * (editable for members with write) and the comment dialog, and saves edits
 * with a debounced PUT carrying the version they were based on.
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
import { createEditor } from "./editor.js";

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
  const editable = viewer.kind === "member" && atLeast(viewer.access, "write");

  // ---- layout ----
  const title = h("b", { class: "title" }, payload.document.title);
  const version = h("span", { class: "badge" }, `v${baseNumber}`);
  const saveState = h("span", { class: "save", aria: { live: "polite" } });
  const who = h("span", { class: "who-am-i" });
  const account = h("span", { class: "account" });
  const banner = h("div", { class: "banner", hidden: true, role: "note" });
  const editorEl = h("div", { class: "editor" });
  const margin = h("div", { class: "margin" });
  const page = h("div", { class: "page" }, editorEl, margin);
  const stage = h("div", { class: "stage" }, page);
  const panel = h("div", { class: "panel" });
  const count = h("span", { class: "ccount" });
  const side = h("aside", { class: "side", aria: { label: "Comments" } }, h("h2", {}, "Comments ", count), panel);
  const bubble = h("button", { type: "button", class: "bubble", hidden: true }, "💬 Comment");
  const toolbar = h("div", { class: "toolbar", role: "toolbar", aria: { label: "Formatting" }, hidden: !editable });
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
        who,
        account,
      ),
      banner,
      toolbar,
      h("div", { class: "main" }, stage, side),
    ),
  );
  document.body.append(bubble);

  // ---- editor ----
  const editor = createEditor(editorEl, payload.version.markdown, editable);

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
      },
    },
    viewer,
  );
  renderViewer();
  comments.apply(payload);
  void comments.loadMentions();
  comments.startPolling();
  comments.openFromHash();
  addEventListener("hashchange", () => comments.openFromHash());

  // ---- saving ----
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let dirty = false;
  let conflict = false;

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
    if (dirty && !conflict) schedule();
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DELAY_MS);
  };

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
