/** Turns an MCP CallToolResult into the string the model sees. */

export const MCP_RESULT_MAX_CHARS = 100_000;

function errorText(message: string): string {
  return JSON.stringify({ error: "mcp_server_error", message });
}

function truncate(text: string): string {
  if (text.length <= MCP_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, MCP_RESULT_MAX_CHARS)}\n[truncated: ${text.length - MCP_RESULT_MAX_CHARS} characters omitted]`;
}

export interface ToolResultText {
  /** The text the model sees: redacted, then capped at MCP_RESULT_MAX_CHARS. */
  text: string;
  /** True when the server reported an error or the result was unreadable. */
  isError: boolean;
}

/**
 * The model-facing text of a CallToolResult. `redact` runs on the assembled text before it is
 * truncated, so a secret that straddles the cut is still matched whole.
 */
export function toolResultText(result: unknown, redact: (text: string) => string = (t) => t): ToolResultText {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { text: errorText("The MCP server returned an unreadable result."), isError: true };
  }
  const r = result as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  const parts: string[] = [];
  let hasText = false;
  for (const part of Array.isArray(r.content) ? r.content : []) {
    if (part === null || typeof part !== "object") continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") {
      hasText = true;
      parts.push(p.text);
    } else if (typeof p.type === "string") {
      parts.push(`[${p.type} omitted]`);
    }
  }
  let text = parts.join("\n");
  if (!hasText && r.structuredContent !== undefined && r.structuredContent !== null) {
    text = JSON.stringify(r.structuredContent);
  }
  const safe = truncate(redact(text));
  if (r.isError === true) return { text: errorText(safe), isError: true };
  return { text: safe, isError: false };
}
