/**
 * The page's client for /d/api/ and guest registration. Every request is
 * same-origin with cookies; writes carry the CSRF value from the bootstrap
 * (or the one guest registration returns); on /s/<token> pages every request
 * carries the share token, so a member gets the link's access per request.
 * Errors surface as fixed codes only (the server never sends other text).
 */
import type { TextAnchor } from "./anchors.js";
import type { MentionCandidate } from "./comments.js";

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
  anchor: TextAnchor;
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
  };
  version: { number: number; markdown: string; createdAt: string };
  me: Viewer;
  threads: ThreadView[];
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
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
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const code = (data as { error?: unknown } | null)?.error;
      throw new ApiError(typeof code === "string" && CODE.test(code) ? code : "internal_error", res.status);
    }
    return data as T;
  }

  private doc(sub = ""): string {
    return `/d/api/${encodeURIComponent(this.boot.documentId)}${sub}`;
  }

  load(): Promise<DocumentPayload> {
    return this.request("GET", this.doc());
  }

  mentions(): Promise<{ candidates: MentionCandidate[] }> {
    return this.request("GET", this.doc("/mentions"));
  }

  saveContent(markdown: string, baseNumber: number): Promise<{ version: { number: number } }> {
    return this.request("PUT", this.doc("/content"), { markdown, baseNumber });
  }

  createThread(anchor: TextAnchor, body: string, sendToAgent: boolean): Promise<{ threadId: string; number: number }> {
    return this.request("POST", this.doc("/threads"), { anchor, body, ...(sendToAgent ? { sendToAgent: true } : {}) });
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
  guest_name_invalid: "Use a name of 1–40 characters that isn't “agent”, “via” or a member's name.",
  guest_email_invalid: "That email address doesn't look right.",
  share_link_invalid: "This share link is no longer valid.",
  network_error: "Can't reach the server. Check your connection.",
};

export function errorMessage(err: unknown): string {
  const code = err instanceof ApiError ? err.code : "internal_error";
  return MESSAGES[code] ?? `Something went wrong (${code}).`;
}
