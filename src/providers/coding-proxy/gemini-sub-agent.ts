import { conversationKey } from "./hold.js";

/**
 * The Gemini CLI marks a sub-agent's requests with no header. They are recognised by shape (risk
 * spike, risk 13): the sub-agent declares `complete_task`, never `invoke_agent`, and its first message
 * is its own task, without the main session's `<session_context>` block. (The spike also saw an empty
 * generationConfig; the worker's output-cap override fills it, so it is not used.)
 */
const SESSION_CONTEXT = "<session_context>";

function declaredNames(tools: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(tools)) return names;
  for (const tool of tools as unknown[]) {
    const declarations = (tool as { functionDeclarations?: unknown } | null)?.functionDeclarations;
    if (!Array.isArray(declarations)) continue;
    for (const declaration of declarations as unknown[]) {
      const name = (declaration as { name?: unknown } | null)?.name;
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

export function isGeminiSubAgentRequest(body: Record<string, unknown>): boolean {
  const names = declaredNames(body.tools);
  if (!names.has("complete_task") || names.has("invoke_agent")) return false;
  const first = Array.isArray(body.contents) ? (body.contents[0] as unknown) : undefined;
  if (first === undefined) return false;
  return !JSON.stringify(first).includes(SESSION_CONTEXT);
}

/**
 * The run-step `agent` id of a sub-agent's request: its conversation key (system prompt + first
 * message, the same key its holds use), shortened. Known limit: two sub-agent calls with the same
 * system prompt and first message share a label (labels only; holds are per request anyway).
 */
export function geminiSubAgentRef(body: Record<string, unknown>): string | undefined {
  if (!isGeminiSubAgentRequest(body)) return undefined;
  const key = conversationKey("gemini-generate-content", body);
  return key ? `gemini-${key.slice(0, 16)}` : undefined;
}
