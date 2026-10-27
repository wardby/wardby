/**
 * Claude Code session transcripts (the Agent SDK's persistSession JSONL), reduced to what `claude
 * --resume` needs: user and assistant messages on the main chain plus the title. Everything else the
 * SDK records (system prompt snapshots, environment, account and organisation, budget and queue
 * records) is dropped, as are thinking blocks: they may not replay on another account and earlier
 * turns' thinking is not needed to continue.
 *
 * Keep this file import-free, erasable TypeScript (types only, no enums or namespaces):
 * src/claude-coding-worker/Dockerfile.compatibility copies this .ts as is and runs it directly with
 * Node's type stripping, where an import would not resolve.
 */
type JsonRecord = Record<string, unknown>;

const KEPT_FIELDS = [
  "type",
  "uuid",
  "parentUuid",
  "isSidechain",
  "sessionId",
  "timestamp",
  "cwd",
  "gitBranch",
  "version",
  "entrypoint",
  "userType",
] as const;
const MESSAGE_FIELDS = ["role", "content", "id", "type", "model", "stop_reason", "stop_sequence"] as const;
const THINKING = new Set(["thinking", "redacted_thinking"]);

export interface SanitizedTranscript {
  sessionId: string;
  lines: string[];
}

export function sanitizeClaudeTranscript(jsonl: string): SanitizedTranscript | null {
  const kept: JsonRecord[] = [];
  // A dropped record's uuid -> its parent, so kept children can be relinked past it.
  const droppedParent = new Map<string, string | null>();
  let title: JsonRecord | undefined;
  let sessionId: string | undefined;
  for (const line of jsonl.split("\n")) {
    const record = parseRecord(line);
    if (!record) continue;
    if (record.type === "ai-title" && typeof record.aiTitle === "string") {
      title = { type: "ai-title", aiTitle: record.aiTitle };
      if (typeof record.sessionId === "string") title.sessionId = record.sessionId;
      continue;
    }
    const conversation = (record.type === "user" || record.type === "assistant") && record.isSidechain !== true;
    const message = conversation ? withoutThinking(record.message) : null;
    if (!message) {
      if (typeof record.uuid === "string") droppedParent.set(record.uuid, parentOf(record));
      continue;
    }
    if (typeof record.sessionId === "string") sessionId ??= record.sessionId;
    const copy: JsonRecord = {};
    for (const field of KEPT_FIELDS) if (field in record) copy[field] = record[field];
    copy.message = message;
    kept.push(copy);
  }
  for (const record of kept) record.parentUuid = resolveParent(parentOf(record), droppedParent);
  let end = -1;
  kept.forEach((record, index) => {
    if (isCompleteAssistant(record)) end = index;
  });
  if (end < 0 || !sessionId) return null;
  const records = kept.slice(0, end + 1);
  if (title) records.push({ ...title, sessionId: title.sessionId ?? sessionId });
  const present = new Set(records.map((record) => record.uuid));
  for (const record of records) {
    if (record.type !== "ai-title" && record.parentUuid !== null && !present.has(record.parentUuid)) {
      record.parentUuid = null;
    }
  }
  return { sessionId, lines: records.map((record) => JSON.stringify(record)) };
}

function parseRecord(line: string): JsonRecord | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
  } catch {
    // A torn last line (the writer was cut off mid-record).
    return null;
  }
}

function parentOf(record: JsonRecord): string | null {
  return typeof record.parentUuid === "string" ? record.parentUuid : null;
}

function resolveParent(parent: string | null, dropped: ReadonlyMap<string, string | null>): string | null {
  const seen = new Set<string>();
  while (parent !== null && dropped.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    parent = dropped.get(parent) ?? null;
  }
  return parent;
}

/** The message rebuilt from an allowlist, without thinking blocks, or null when nothing is left. */
function withoutThinking(message: unknown): JsonRecord | null {
  if (!message || typeof message !== "object") return null;
  const m = message as JsonRecord;
  let content = m.content;
  if (typeof content === "string") {
    if (!content) return null;
  } else if (Array.isArray(content)) {
    content = content.filter((block) => !THINKING.has((block as JsonRecord | null)?.type as string));
    if ((content as unknown[]).length === 0) return null;
  } else {
    return null;
  }
  const copy: JsonRecord = {};
  for (const field of MESSAGE_FIELDS) if (field in m) copy[field] = m[field];
  copy.content = content;
  return copy;
}

/** An assistant record that asks for no tool: the history can end here and be continued. */
function isCompleteAssistant(record: JsonRecord): boolean {
  if (record.type !== "assistant") return false;
  const content = (record.message as JsonRecord).content;
  return !Array.isArray(content) || !content.some((block) => (block as JsonRecord | null)?.type === "tool_use");
}
