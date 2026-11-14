/**
 * The page's client for /d/api/ and guest registration. Every request is
 * same-origin with cookies; writes carry the CSRF value from the bootstrap
 * (or the one guest registration returns); on /s/<token> pages every request
 * carries the share token, so a member gets the link's access per request.
 * Errors surface as fixed codes only (the server never sends other text).
 */
import type { ElementAnchor } from "../../core/documents/element-anchors.js";
import type { VersionWarning } from "../../core/documents/warnings.js";
import type { TextAnchor } from "./anchors.js";
import type { VersionItem } from "./version-rows.js";

export type { ElementAnchor, TextAnchor };
/** A thread's anchor: words in a document's text, or an element on a design board. */
export type Anchor = TextAnchor | ElementAnchor;

export interface Viewer {
  kind: "member" | "guest" | "anonymous";
  name: string | null;
  access: string;
}

export interface Bootstrap {
  documentId: string;
  csrf: string;
  viewer: Viewer;
  shareToken?: string;
  loginUrl: string;
  logoutUrl: string;
}

export interface CommentView {
  id: string;
  author: { kind: "member" | "guest" | "agent"; name: string; viaName?: string };
  body: string;
  createdAt: string;
  editedAt: string | null;
  mine: boolean;
}

export interface ThreadView {
  id: string;
  number: number;
  status: string;
  anchor: Anchor;
  sentAt: string | null;
  comments: CommentView[];
}

export interface DocumentPayload {
  document: {
    id: string;
    title: string;
    updatedAt: string;
    repository?: string | null;
    path?: string | null;
    canSend: boolean;
    /** Whether PNG and PDF export is available on this server (a renderer is set up). */
    canRender?: boolean;
  };
  version: PayloadVersion;
  me: Viewer;
  threads: ThreadView[];
  /** Names for @[guest:id] mentions in these threads (this document's own guests only). */
  mentionedGuests?: { guestId: string; name: string }[];
  review: ReviewPayload;
}

/** A document's review state (the page shows it in the banner and the Review tab). */
export type ReviewState = "draft" | "in_review" | "changes_requested" | "approved" | "archived";

export interface ReviewerPayload {
  id: string;
  kind: "member" | "guest";
  /** The reviewer's ref (principal id or guest:<id>): for the owner only. */
  ref?: string;
  name: string;
  verdict: "none" | "approved" | "changes_requested";
  versionNumber: number | null;
  note: string | null;
  /** Whether the verdict counts (given since the last reopen). */
  current: boolean;
  me: boolean;
}

export interface ReviewEventPayload {
  id: string;
  kind: string;
  actorName: string;
  fromState: ReviewState;
  toState: ReviewState;
  versionNumber: number;
  note: string | null;
  createdAt: string;
}

export interface ReviewPayload {
  state: ReviewState;
  currentVersion: number;
  progress: { approved: number; total: number };
  reviewers: ReviewerPayload[];
  finalApprover: { name: string; me: boolean; ref?: string } | null;
  forced: { byName: string; versionNumber: number; notes: string[] } | null;
  events: ReviewEventPayload[];
  can: { submit: boolean; review: boolean; force: boolean; reopen: boolean; archive: boolean; unarchive: boolean };
}

/** One POST /review body. */
export type ReviewAction =
  | { action: "submit"; reviewers: string[]; finalApproverId?: string | null }
  | { action: "verdict"; verdict: "approve" | "request_changes"; versionNumber: number; note?: string }
  | { action: "force"; note: string }
  | { action: "reopen" }
  | { action: "archive"; archived: boolean };

/** The current version: a document's Markdown, or a design's board files, by `format`. */
export type PayloadVersion = { number: number; createdAt: string; warnings?: VersionWarning[] } & (
  { format: "markdown"; markdown: string } | { format: "boards-v1"; files: Record<string, string> }
);

/** One /mentions entry: a member (principalId) or a guest who commented on this document (guestId). */
export interface MentionEntry {
  principalId?: string;
  guestId?: string;
  name: string;
}

/** One board as the frames route serves it: sandboxed-frame HTML (frames.ts), never page markup. */
export interface FrameBoard {
  id: string;
  name: string;
  width: number;
  html: string;
}

/** A file the server sends as an attachment (an export), with the name it suggests. */
export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

export type ExportFileFormat = "board-html" | "prototype";
export type RenderedFormat = "png" | "pdf";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    /** board_format_invalid only: the server's own problem text (fixed wording, board ids and counts). */
    readonly problems: string[] = [],
  ) {
    super(code);
  }
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Reads the bootstrap the page wrote; throws when it is missing or malformed. */
export function readBootstrap(value: unknown): Bootstrap {
  const b = value as Partial<Bootstrap> | undefined;
  if (
    !b ||
    typeof b.documentId !== "string" ||
    typeof b.csrf !== "string" ||
    !b.viewer ||
    typeof b.viewer.access !== "string" ||
    typeof b.loginUrl !== "string" ||
    typeof b.logoutUrl !== "string"
  ) {
    throw new Error("bootstrap_missing");
  }
  return b as Bootstrap;
}

export class Api {
  private csrf: string;

  constructor(private readonly boot: Bootstrap) {
    this.csrf = boot.csrf;
  }

  /** One request; a non-2xx answer throws ApiError with the server's fixed code. */
  private async raw(method: string, path: string, body?: unknown, accept = "application/json"): Promise<Response> {
    const headers: Record<string, string> = { accept };
    if (this.boot.shareToken) headers["x-wardby-share"] = this.boot.shareToken;
    if (method !== "GET") headers["x-wardby-csrf"] = this.csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError("network_error", 0);
    }
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null);
      const { error: code, problems } = (data ?? {}) as { error?: unknown; problems?: unknown };
      const safeCode = typeof code === "string" && CODE.test(code) ? code : "internal_error";
      const list =
        safeCode === "board_format_invalid" && Array.isArray(problems)
          ? problems.filter((p): p is string => typeof p === "string").slice(0, 10)
          : [];
      throw new ApiError(safeCode, res.status, list);
    }
    return res;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    return (await res.json().catch(() => null)) as T;
  }

  /** A file answer: the bytes and the name the server suggests (its own slug, [a-z0-9-] and an extension). */
  private async download(path: string): Promise<DownloadedFile> {
    const res = await this.raw("GET", path, undefined, "*/*");
    const named = /filename="([A-Za-z0-9._-]{1,120})"/.exec(res.headers.get("content-disposition") ?? "");
    return { blob: await res.blob(), filename: named?.[1] ?? "export" };
  }

  private doc(sub = ""): string {
    return `/d/api/${encodeURIComponent(this.boot.documentId)}${sub}`;
  }

  load(): Promise<DocumentPayload> {
    return this.request("GET", this.doc());
  }

  mentions(): Promise<{ candidates: MentionEntry[] }> {
    return this.request("GET", this.doc("/mentions"));
  }

  saveContent(markdown: string, baseNumber: number): Promise<{ version: { number: number } }> {
    return this.request("PUT", this.doc("/content"), { markdown, baseNumber });
  }

  /** A design save: only the changed files (null deletes one), over version `baseNumber`. */
  saveFiles(files: Record<string, string | null>, baseNumber: number): Promise<{ version: { number: number } }> {
    return this.request("PUT", this.doc("/content"), { files, baseNumber });
  }

  /** The design page's import fidelity results for one version (stored once per version). */
  fidelity(
    versionNumber: number,
    boards: { board: string; mismatches: number; samples: string[] }[],
  ): Promise<unknown> {
    return this.request("POST", this.doc("/fidelity"), { versionNumber, boards });
  }

  createThread(anchor: Anchor, body: string, sendToAgent: boolean): Promise<{ threadId: string; number: number }> {
    return this.request("POST", this.doc("/threads"), { anchor, body, ...(sendToAgent ? { sendToAgent: true } : {}) });
  }

  versions(before?: number): Promise<{ versions: VersionItem[]; nextBefore?: number }> {
    return this.request("GET", this.doc(`/versions${before !== undefined ? `?before=${before}` : ""}`));
  }

  version(number: number): Promise<{ version: { number: number; markdown: string; createdAt: string } }> {
    return this.request("GET", this.doc(`/versions/${number}`));
  }

  restore(number: number, baseNumber: number): Promise<{ version: { number: number } }> {
    return this.request("POST", this.doc(`/versions/${number}/restore`), { baseNumber });
  }

  /** A design version's boards as sandboxed-frame HTML: Play (board links) or Overview (no links). */
  async frames(mode: "play" | "overview", version?: number): Promise<FrameBoard[]> {
    const q = `mode=${mode}${version !== undefined ? `&version=${version}` : ""}`;
    const r = await this.request<{ boards: FrameBoard[] }>("GET", this.doc(`/frames?${q}`));
    return Array.isArray(r?.boards) ? r.boards : [];
  }

  /** A board (HTML) or the whole prototype (HTML) of a design version, computed on request. */
  exportFile(opts: { format: ExportFileFormat; board?: string; version?: number }): Promise<DownloadedFile> {
    const q = new URLSearchParams({ format: opts.format });
    if (opts.board) q.set("board", opts.board);
    if (opts.version !== undefined) q.set("version", String(opts.version));
    return this.download(this.doc(`/export?${q.toString()}`));
  }

  /** Asks for a rendered PNG (one board) or PDF (all boards, or a document); returns the job to poll. */
  async startExport(opts: { format: RenderedFormat; board?: string; versionNumber?: number }): Promise<string> {
    const r = await this.request<{ exportId: string }>("POST", this.doc("/exports"), {
      format: opts.format,
      ...(opts.board ? { board: opts.board } : {}),
      ...(opts.versionNumber !== undefined ? { versionNumber: opts.versionNumber } : {}),
    });
    return r.exportId;
  }

  exportStatus(exportId: string): Promise<{ status: string; errorCode: string | null }> {
    return this.request("GET", `/d/api/exports/${encodeURIComponent(exportId)}`);
  }

  exportBytes(exportId: string): Promise<DownloadedFile> {
    return this.download(`/d/api/exports/${encodeURIComponent(exportId)}/file`);
  }

  /** One review action (submit, verdict, force, reopen, archive); answers with the updated review. */
  review(body: ReviewAction): Promise<{ review: ReviewPayload }> {
    return this.request("POST", this.doc("/review"), body);
  }

  /** Whom the owner may name as reviewers: members with access and this document's comment-link guests. */
  reviewCandidates(): Promise<{
    members: { principalId: string; name: string }[];
    guests: { guestId: string; name: string }[];
  }> {
    return this.request("GET", this.doc("/review-candidates"));
  }

  send(threadIds: string[]): Promise<unknown> {
    return this.request("POST", this.doc("/send"), { threadIds });
  }

  reply(threadId: string, body: string): Promise<unknown> {
    return this.request("POST", `/d/api/threads/${encodeURIComponent(threadId)}/replies`, { body });
  }

  setStatus(threadId: string, status: "open" | "resolved"): Promise<unknown> {
    return this.request("POST", `/d/api/threads/${encodeURIComponent(threadId)}/status`, { status });
  }

  editComment(commentId: string, body: string): Promise<unknown> {
    return this.request("PATCH", `/d/api/comments/${encodeURIComponent(commentId)}`, { body });
  }

  deleteComment(commentId: string): Promise<unknown> {
    return this.request("DELETE", `/d/api/comments/${encodeURIComponent(commentId)}`);
  }

  /** Registers this visitor as a guest of the share link; later writes use the new session's CSRF value. */
  async registerGuest(name: string, email: string | undefined): Promise<Viewer> {
    if (!this.boot.shareToken) throw new ApiError("share_link_invalid", 404);
    const r = await this.request<{ csrf: string; me: Viewer }>(
      "POST",
      `/s/${encodeURIComponent(this.boot.shareToken)}/guest`,
      { name, ...(email ? { email } : {}) },
    );
    this.csrf = r.csrf;
    return r.me;
  }

  async logout(): Promise<void> {
    await this.request("POST", this.boot.logoutUrl, {});
  }
}

/** Fixed, user-facing text for each error code (never server text). */
const MESSAGES: Record<string, string> = {
  document_version_conflict: "Someone else saved a newer version — reload",
  comment_thread_already_sent: "This thread is already with the agent.",
  document_too_large_for_agent: "This document is too large to send to the agent.",
  document_agent_unavailable: "The document's agent can't take work right now.",
  document_not_agent_linked: "This document isn't linked to an agent.",
  document_send_not_available: "Sending to an agent isn't available on this server.",
  document_send_failed: "The agent run couldn't be started. Try again.",
  comment_send_rate_limited: "Too many sends to the agent this hour. Try again later.",
  web_rate_limited: "Too many requests. Try again in a while.",
  web_session_required: "Your session has ended. Sign in again.",
  web_csrf_failed: "This page is out of date. Reload and try again.",
  web_origin_rejected: "This page is out of date. Reload and try again.",
  document_access_denied: "You don't have permission to do that.",
  comment_edit_forbidden: "You can only change your own comments.",
  comment_thread_closed: "This thread is resolved. Reopen it to reply.",
  comment_too_long: "That comment is too long.",
  comment_anchor_invalid: "That selection can't be commented on.",
  comment_not_found: "That comment no longer exists. Reload to see the latest.",
  document_too_large: "The document is too large to save.",
  board_format_invalid: "This edit can't be saved.",
  board_too_large: "A board is too large to save (512 KB at most).",
  document_format_mismatch: "This page is out of date. Reload and try again.",
  document_version_not_found: "That version no longer exists. Reload to see the latest.",
  guest_name_invalid: "Use a name of 1–40 characters that isn't “agent”, “via” or a member's name.",
  guest_email_invalid: "That email address doesn't look right.",
  share_link_invalid: "This share link is no longer valid.",
  export_renderer_unavailable: "PNG and PDF export isn't set up on this server.",
  export_rate_limited: "Too many exports of this design in the last hour. Try again later.",
  export_sign_in_required: "Sign in or add your name to export PNG or PDF.",
  export_timeout: "The export is taking too long. Try again.",
  export_failed: "The export couldn't be made. Try again.",
  export_too_large: "This is too large to export.",
  export_not_found: "That export is no longer available. Try again.",
  document_locked: "This document is approved or archived, so it can't be changed. Reopen it for review first.",
  document_review_forbidden: "You can't do that in this review.",
  document_review_state_invalid: "That can't be done in the document's current review state. Reload to see it.",
  network_error: "Can't reach the server. Check your connection.",
};

export function errorMessage(err: unknown): string {
  const code = err instanceof ApiError ? err.code : "internal_error";
  return MESSAGES[code] ?? `Something went wrong (${code}).`;
}
