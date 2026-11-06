/** Turns an MCP CallToolResult into the string the model sees. */

export const MCP_RESULT_MAX_CHARS = 100_000;

function errorText(message: string): string {
  return JSON.stringify({ error: "mcp_server_error", message });
}

function truncate(text: string): string {
  if (text.length <= MCP_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, MCP_RESULT_MAX_CHARS)}\n[truncated: ${text.length - MCP_RESULT_MAX_CHARS} characters omitted]`;
}

export function toolResultText(result: unknown): string {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return errorText("The MCP server returned an unreadable result.");
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
  if (r.isError === true) return errorText(truncate(text));
  return truncate(text);
}
