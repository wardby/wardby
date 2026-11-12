/** The send-to-agent codes answer with the same HTTP status on the web routes and in MCP. */
import { describe, expect, it } from "vitest";
import { documentErrorStatus } from "../mcp/tools/documents.js";
import { errorCode } from "./context.js";

const EXPECTED: Record<string, number> = {
  comment_thread_closed: 409,
  comment_thread_already_sent: 409,
  document_too_large_for_agent: 413,
  document_agent_unavailable: 403,
  document_send_failed: 503,
  document_not_agent_linked: 400,
  comment_send_rate_limited: 429,
  document_version_conflict: 409,
};

describe("send-to-agent error statuses", () => {
  for (const [code, status] of Object.entries(EXPECTED)) {
    it(`${code} is ${status} on the web routes and in MCP`, () => {
      expect(errorCode(new Error(code))).toEqual({ code, status });
      expect(documentErrorStatus(code)).toBe(status);
    });
  }
});
