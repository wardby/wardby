/**
 * Claude Code session transcripts (the Agent SDK's persistSession JSONL), reduced to what `claude
 * --resume` needs. Records are kept whole and unedited (the format is internal to Claude Code and
 * changes between versions), except that thinking blocks are removed: on another account they are
 * dropped or rejected, and redaction changes the history they are bound to.
 *
 * Only known record types are kept, so a new type is dropped until it is reviewed: the user and
 * assistant messages, compaction boundaries, titles, and the attachments that belong to the
 * conversation. Dropped: the run's system prompt, its pod environment and budget reminders, the
 * account and organisation, billing, queue and request records. A dropped record's children are
 * relinked to its parent. History before the last compaction is not kept (resume never loads it).
 * Two fields that hold the account's plan and rate-limit state are removed
 * from every kept record.
 *
 * Keep this file import-free, erasable TypeScript (types only, no enums or namespaces):
 * src/claude-coding-worker/Dockerfile.compatibility copies this .ts as is and runs it directly with
 * Node's type stripping, where an import would not resolve.
 */
type JsonRecord = Record<string, unknown>;

const KEPT_TYPES = new Set(["user", "assistant", "attachment", "system", "ai-title", "custom-title", "summary"]);
/** System records kept: a compaction boundary decides which history a resume loads. */
const KEPT_SYSTEM = new Set(["compact_boundary"]);
/** Attachments that are part of the conversation the model saw and still applies on a laptop. */
export const KEPT_ATTACHMENTS = new Set([
  "agent_listing_delta",
  "compact_file_reference",
  "deferred_tools_delta",
  "deferred_tools_record",
  "dynamic_skill",
  "edited_text_file",
  "file",
  "hook_additional_context",
  "hook_success",
  "instructions",
  "invoked_skills",
  "mcp_instructions_delta",
  "nested_memory",
  "queued_command",
  "read_truncation_notice",
  "skill_listing",
  // A copy of the run's final StructuredOutput answer, tied to that call (not shown to the model).
  "structured_output",
  "task_reminder",
  "task_status",
]);
/**
 * Attachments dropped on purpose: the run's system prompt, account, organisation, pod and budget
 * state. Listed so the compatibility test can tell a reviewed kind from a new one.
 */
export const DROPPED_ATTACHMENTS = new Set([
  "auto_mode",
  "budget_usd",
  "command_permissions",
  "credential_org",
  "date",
  "environment",
  "model",
  "prompt_snapshot",
  "remote_session_change",
  "session_context",
  "session_cron_carry",
  "silent_turn_reminder",
  "thinking_drop",
  "total_tokens_reminder",
]);
const THINKING = new Set(["thinking", "redacted_thinking"]);
/** Fields removed from any kept record: the account's plan and rate-limit state. */
const DROPPED_FIELDS = ["quotaLimits", "usageLimitNote"] as const;

export interface SanitizedTranscript {
  sessionId: string;
  lines: string[];
}

/** `fallbackTitle` is used when the session has no title of its own. */
export function sanitizeClaudeTranscript(jsonl: string, fallbackTitle?: string): SanitizedTranscript | null {
  const kept: JsonRecord[] = [];
  const titles: JsonRecord[] = [];
  // A dropped record's uuid -> its parent, so kept children can be relinked past it.
  const droppedParent = new Map<string, string | null>();
  // Every record's parent as written, for walking a compaction's preserved segment.
  const rawParent = new Map<string, string | null>();
  let sessionId: string | undefined;
  for (const line of jsonl.split("\n")) {
    const record = parseRecord(line);
    if (!record) continue;
    if (typeof record.uuid === "string") rawParent.set(record.uuid, parentOf(record));
    if (record.type === "ai-title" || record.type === "custom-title" || record.type === "summary") {
      titles.push(record);
      continue;
    }
    const copy = keptRecord(record);
    if (!copy) {
      if (typeof record.uuid === "string") droppedParent.set(record.uuid, parentOf(record));
      continue;
    }
    if (typeof record.sessionId === "string" && record.isSidechain !== true) sessionId ??= record.sessionId;
    kept.push(copy);
  }
  for (const record of kept) record.parentUuid = resolveParent(parentOf(record), droppedParent);
  const end = lastSettled(kept);
  if (end < 0 || !sessionId) return null;
  let records = kept.slice(0, end + 1);
  let present = new Set(records.map((record) => record.uuid));
  for (const record of records) {
    if (record.type === "system") repointCompaction(record, present, rawParent, droppedParent);
  }
  records = fromLastCompaction(records);
  present = new Set(records.map((record) => record.uuid));
  for (const record of records) {
    // A compaction boundary starts a new chain on purpose (its link back is logicalParentUuid).
    if (record.parentUuid !== null && !present.has(record.parentUuid)) record.parentUuid = null;
  }
  for (const title of titles) {
    if (title.type === "summary" && !present.has(title.leafUuid)) continue;
    records.push(title.type === "summary" ? title : { ...title, sessionId });
  }
  if (!titles.some((title) => title.type !== "summary") && fallbackTitle) {
    records.push({ type: "ai-title", aiTitle: fallbackTitle, sessionId });
  }
  return { sessionId, lines: records.map((record) => JSON.stringify(record)) };
}

/** The record as stored, or null when it is dropped. Only thinking and account fields are edited out. */
function keptRecord(record: JsonRecord): JsonRecord | null {
  const copy = keptRecordWithFields(record);
  if (copy) for (const field of DROPPED_FIELDS) delete copy[field];
  return copy;
}

function keptRecordWithFields(record: JsonRecord): JsonRecord | null {
  const type = record.type;
  if (typeof type !== "string" || !KEPT_TYPES.has(type)) return null;
  if (type === "system") return KEPT_SYSTEM.has(record.subtype as string) ? { ...record } : null;
  if (type === "attachment") {
    const kind = (record.attachment as JsonRecord | null)?.type;
    return typeof kind === "string" && KEPT_ATTACHMENTS.has(kind) ? { ...record } : null;
  }
  const message = withoutThinking(record.message);
  return message ? { ...record, message } : null;
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

/**
 * Only what a resume loads: the last compaction boundary, everything after it, and the messages it
 * kept word for word. Resume never loads what that compaction summarised (Claude Code continues
 * "with the last compaction's summary, the messages that compaction left unsummarized, and every
 * message since"), so the earlier history is not stored. Without a compaction, everything is kept.
 */
function fromLastCompaction(records: JsonRecord[]): JsonRecord[] {
  let last = -1;
  records.forEach((record, index) => {
    if (record.type === "system" && record.subtype === "compact_boundary") last = index;
  });
  if (last <= 0) return records;
  const metadata = (records[last].compactMetadata ?? {}) as JsonRecord;
  const keep = new Set<unknown>();
  const segment = metadata.preservedSegment as JsonRecord | undefined;
  if (segment && typeof segment === "object") {
    const byId = new Map(records.map((record) => [record.uuid, record]));
    let id: unknown = segment.tailUuid;
    while (typeof id === "string" && byId.has(id) && !keep.has(id)) {
      keep.add(id);
      if (id === segment.headUuid) break;
      id = byId.get(id)?.parentUuid;
    }
  }
  const messages = metadata.preservedMessages as JsonRecord | undefined;
  for (const list of [messages?.uuids, messages?.allUuids]) {
    if (Array.isArray(list)) for (const id of list) keep.add(id);
  }
  return records.filter((record, index) => index >= last || keep.has(record.uuid));
}

/**
 * A compaction boundary names the messages it kept word for word (`preservedSegment`, from head to
 * tail, and `preservedMessages`). Resume splices that segment back in after the summary, so ids of
 * dropped records are moved to the nearest kept record inside the segment, or the segment is removed
 * when nothing in it is kept.
 */
function repointCompaction(
  boundary: JsonRecord,
  present: ReadonlySet<unknown>,
  rawParent: ReadonlyMap<string, string | null>,
  droppedParent: ReadonlyMap<string, string | null>,
): void {
  if (typeof boundary.logicalParentUuid === "string") {
    boundary.logicalParentUuid = resolveParent(boundary.logicalParentUuid, droppedParent);
  }
  const metadata = boundary.compactMetadata;
  if (!metadata || typeof metadata !== "object") return;
  const copy: JsonRecord = { ...(metadata as JsonRecord) };
  boundary.compactMetadata = copy;
  const segment = copy.preservedSegment as JsonRecord | undefined;
  if (segment && typeof segment === "object") {
    // Walk tail -> head along the links as written; the kept records on that path are the segment.
    const path: string[] = [];
    let id = typeof segment.tailUuid === "string" ? segment.tailUuid : null;
    while (id !== null && !path.includes(id)) {
      path.push(id);
      if (id === segment.headUuid) break;
      id = rawParent.get(id) ?? null;
    }
    const kept = path.filter((uuid) => present.has(uuid));
    if (path.at(-1) !== segment.headUuid || kept.length === 0) {
      delete copy.preservedSegment;
    } else {
      copy.preservedSegment = { ...segment, tailUuid: kept[0], headUuid: kept.at(-1) };
    }
  }
  const messages = copy.preservedMessages as JsonRecord | undefined;
  if (messages && typeof messages === "object") {
    const keep = (list: unknown) => (Array.isArray(list) ? list.filter((uuid) => present.has(uuid)) : list);
    copy.preservedMessages = { ...messages, uuids: keep(messages.uuids), allUuids: keep(messages.allUuids) };
  }
}

/** The message without thinking blocks, or null when nothing is left. */
function withoutThinking(message: unknown): JsonRecord | null {
  if (!message || typeof message !== "object") return null;
  const m = message as JsonRecord;
  if (typeof m.content === "string") return m.content ? m : null;
  if (!Array.isArray(m.content)) return null;
  const content = m.content.filter((block) => !THINKING.has((block as JsonRecord | null)?.type as string));
  if (content.length === 0) return null;
  return content.length === m.content.length ? m : { ...m, content };
}

/**
 * The index the history can end at and be continued: the last main-chain record after which no tool
 * call is waiting for its result. That is a reply that asks for no tool, or a tool result that answers
 * the last open call (a run's final StructuredOutput call and its result end this way). A call left
 * without a result (the run was cut off mid-command) is cut, with everything after the last such point.
 * -1 when the history never settles.
 */
function lastSettled(records: readonly JsonRecord[]): number {
  let end = -1;
  const waiting = new Set<unknown>();
  records.forEach((record, index) => {
    if (record.isSidechain === true || (record.type !== "user" && record.type !== "assistant")) return;
    const content = (record.message as JsonRecord).content;
    const blocks = Array.isArray(content) ? (content as Array<JsonRecord | null>) : [];
    if (record.type === "assistant") {
      const calls = blocks.filter((block) => block?.type === "tool_use");
      // A reply that asks for no tool settles everything before it.
      if (calls.length === 0) {
        waiting.clear();
        end = index;
      }
      for (const call of calls) waiting.add(call?.id);
      return;
    }
    const results = blocks.filter((block) => block?.type === "tool_result");
    for (const result of results) waiting.delete(result?.tool_use_id);
    if (results.length > 0 && waiting.size === 0) end = index;
  });
  return end;
}
