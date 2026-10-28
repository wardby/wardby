import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DROPPED_ATTACHMENTS, KEPT_ATTACHMENTS, sanitizeClaudeTranscript } from "./claude-code.js";

const fixture = readFileSync(new URL("./fixtures/claude-session.jsonl", import.meta.url), "utf8");
const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, any>);

describe("sanitizeClaudeTranscript", () => {
  const result = sanitizeClaudeTranscript(fixture)!;
  const records = parse(result.lines);
  const text = result.lines.join("\n");

  it("keeps only conversation records and the title", () => {
    expect(records.map((r) => r.type)).toEqual(["user", "assistant", "user", "user", "assistant", "ai-title"]);
    expect(result.sessionId).toBe("00000000-0000-4000-8000-000000000001");
  });
  it("drops prompts, environment, account and budget data", () => {
    for (const leak of [
      "SYSTEM PROMPT TEXT",
      "person@example.com",
      "11111111-1111-4111-8111-111111111111",
      "cost-state",
      "queue-operation",
    ]) {
      expect(text).not.toContain(leak);
    }
  });
  it("strips thinking blocks and drops records left empty", () => {
    expect(text).not.toContain('"thinking"');
    expect(records.find((r) => r.uuid === "t1")).toBeUndefined();
  });
  it("relinks parents across dropped records", () => {
    expect(records.find((r) => r.uuid === "t2")!.parentUuid).toBe("u1");
  });
  it("trims to the last complete assistant turn", () => {
    expect(records.find((r) => r.uuid === "t3")).toBeUndefined();
    expect(records.at(-2)!.uuid).toBe("f1");
  });
  it("returns null without a complete turn", () => {
    const firstTwo = fixture.split("\n").slice(0, 2).join("\n");
    expect(sanitizeClaudeTranscript(firstTwo)).toBeNull();
  });
  it("keeps conversation records whole, including fields it does not know", () => {
    const f1 = records.find((r) => r.uuid === "f1")!;
    expect(f1.message.usage).toEqual({ input_tokens: 1 });
    expect(f1.message.container).toEqual({ id: "c1" });
    expect(f1.message.unknown_extra).toBe("LEAK-MESSAGE-FIELD");
    expect(records.find((r) => r.uuid === "u2")!.message.unknown_extra).toBe("LEAK-STRING-USER");
    expect(records.find((r) => r.uuid === "r1")!.toolUseResult).toEqual({ stdout: "README.md" });
    expect(records.find((r) => r.uuid === "u1")!.cwd).toBe("/work/repo");
  });
  it("nulls a parent that is not in the output", () => {
    const orphan = JSON.stringify({
      type: "user",
      uuid: "o1",
      parentUuid: "missing",
      sessionId: "s",
      message: { role: "user", content: "hi" },
    });
    const reply = JSON.stringify({
      type: "assistant",
      uuid: "o2",
      parentUuid: "o1",
      sessionId: "s",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    });
    const out = sanitizeClaudeTranscript(orphan + "\n" + reply)!;
    expect(JSON.parse(out.lines[0]).parentUuid).toBeNull();
  });
  it("takes the title's sessionId from the transcript when it has none", () => {
    const title = records.at(-1)!;
    expect(title.sessionId).toBe(result.sessionId);
  });
  it("is idempotent", () => {
    expect(sanitizeClaudeTranscript(result.lines.join("\n"))!.lines).toEqual(result.lines);
  });
});

const SID = "00000000-0000-4000-8000-000000000009";
const rec = (fields: Record<string, unknown>) => JSON.stringify({ sessionId: SID, isSidechain: false, ...fields });
const user = (uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}) =>
  rec({ type: "user", uuid, parentUuid, message: { role: "user", content }, ...extra });
const reply = (uuid: string, parentUuid: string | null, text: string, extra: Record<string, unknown> = {}) =>
  rec({
    type: "assistant",
    uuid,
    parentUuid,
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  });
const attachment = (uuid: string, parentUuid: string | null, kind: string) =>
  rec({ type: "attachment", uuid, parentUuid, attachment: { type: kind, content: `${kind}-BODY` } });

describe("sanitizeClaudeTranscript: record kinds", () => {
  it("keeps a compaction boundary and the summary after it, so resume loads the compacted history", () => {
    const lines = [
      user("p1", null, "old prompt"),
      reply("p2", "p1", "old answer"),
      rec({
        type: "system",
        subtype: "compact_boundary",
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "p2",
        compactMetadata: { trigger: "auto", preservedSegment: { headUuid: "p1", anchorUuid: "s1", tailUuid: "p2" } },
      }),
      user("s1", "cb", "This session is being continued. Summary: ...", {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
      user("n1", "s1", "next prompt"),
      reply("n2", "n1", "next answer"),
    ];
    const out = parse(sanitizeClaudeTranscript(lines.join("\n"))!.lines);
    const boundary = out.find((r) => r.uuid === "cb")!;
    expect(boundary.parentUuid).toBeNull();
    expect(boundary.logicalParentUuid).toBe("p2");
    expect(boundary.compactMetadata.preservedSegment.anchorUuid).toBe("s1");
    expect(out.find((r) => r.uuid === "s1")!.isCompactSummary).toBe(true);
    expect(out.map((r) => r.uuid)).toEqual(["p1", "p2", "cb", "s1", "n1", "n2"]);
  });

  it("moves a compaction's preserved segment off dropped records, so resume can still splice it in", () => {
    const thinkingOnly = rec({
      type: "assistant",
      uuid: "h",
      parentUuid: "q",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }] },
    });
    const lines = [
      user("q", null, "question"),
      thinkingOnly,
      reply("k1", "h", "kept reply"),
      user("k2", "k1", "kept follow-up"),
      attachment("t", "k2", "total_tokens_reminder"),
      rec({
        type: "system",
        subtype: "compact_boundary",
        uuid: "cb",
        parentUuid: null,
        logicalParentUuid: "t",
        compactMetadata: {
          trigger: "auto",
          preservedSegment: { headUuid: "h", anchorUuid: "s1", tailUuid: "t" },
          preservedMessages: { anchorUuid: "s1", uuids: ["h", "k1", "k2", "t"], allUuids: ["h", "k1", "k2", "t"] },
        },
      }),
      user("s1", "cb", "Summary ...", { isCompactSummary: true }),
      user("n1", "t", "next"),
      reply("n2", "n1", "done"),
    ];
    const out = parse(sanitizeClaudeTranscript(lines.join("\n"))!.lines);
    const boundary = out.find((r) => r.uuid === "cb")!;
    expect(boundary.compactMetadata.preservedSegment).toEqual({ headUuid: "k1", anchorUuid: "s1", tailUuid: "k2" });
    expect(boundary.compactMetadata.preservedMessages.uuids).toEqual(["k1", "k2"]);
    expect(boundary.compactMetadata.preservedMessages.allUuids).toEqual(["k1", "k2"]);
    expect(boundary.logicalParentUuid).toBe("k2");
    expect(out.find((r) => r.uuid === "n1")!.parentUuid).toBe("k2");
  });

  it("removes a preserved segment when nothing in it is kept", () => {
    const lines = [
      user("q", null, "question"),
      attachment("t", "q", "total_tokens_reminder"),
      rec({
        type: "system",
        subtype: "compact_boundary",
        uuid: "cb",
        parentUuid: null,
        compactMetadata: { trigger: "auto", preservedSegment: { headUuid: "t", anchorUuid: "s1", tailUuid: "t" } },
      }),
      user("s1", "cb", "Summary ...", { isCompactSummary: true }),
      reply("n2", "s1", "done"),
    ];
    const boundary = parse(sanitizeClaudeTranscript(lines.join("\n"))!.lines).find((r) => r.uuid === "cb")!;
    expect(boundary.compactMetadata.preservedSegment).toBeUndefined();
    expect(boundary.compactMetadata.trigger).toBe("auto");
  });

  it("keeps conversation attachments and drops pod, account and budget ones, relinking past them", () => {
    const lines = [
      user("u", null, "go"),
      attachment("k1", "u", "edited_text_file"),
      attachment("d1", "k1", "environment"),
      attachment("d2", "d1", "session_context"),
      attachment("d3", "d2", "budget_usd"),
      attachment("k2", "d3", "skill_listing"),
      reply("a", "k2", "ok"),
    ];
    const out = parse(sanitizeClaudeTranscript(lines.join("\n"))!.lines);
    expect(out.map((r) => r.uuid)).toEqual(["u", "k1", "k2", "a"]);
    expect(out.find((r) => r.uuid === "k2")!.parentUuid).toBe("k1");
  });

  it("drops record types and attachment kinds it does not know, and system records other than compaction", () => {
    const lines = [
      user("u", null, "go"),
      rec({ type: "api-request-blob", uuid: "x1", parentUuid: "u", body: "SYSTEM PROMPT COPY" }),
      attachment("x2", "x1", "brand_new_kind"),
      rec({ type: "system", subtype: "turn_duration", uuid: "x3", parentUuid: "x2", durationMs: 5 }),
      reply("a", "x3", "ok"),
    ];
    const out = parse(sanitizeClaudeTranscript(lines.join("\n"))!.lines);
    expect(out.map((r) => r.uuid)).toEqual(["u", "a"]);
    expect(out[1].parentUuid).toBe("u");
    expect(JSON.stringify(out)).not.toContain("SYSTEM PROMPT COPY");
  });

  it("removes the account's plan and rate-limit fields from kept records", () => {
    const lines = [
      user("u", null, "go", { usageLimitNote: "LIMIT-NOTE" }),
      reply("a", "u", "ok", { quotaLimits: { status: "allowed", rateLimitType: "five_hour" } }),
    ];
    const text = sanitizeClaudeTranscript(lines.join("\n"))!.lines.join("\n");
    expect(text).not.toContain("quotaLimits");
    expect(text).not.toContain("LIMIT-NOTE");
  });

  it("lists every attachment kind as kept or dropped, never both", () => {
    for (const kind of KEPT_ATTACHMENTS) expect(DROPPED_ATTACHMENTS.has(kind)).toBe(false);
  });

  it("does not end the history on a sidechain reply", () => {
    const lines = [
      user("u", null, "go"),
      reply("a", "u", "ok"),
      user("u2", "a", "more"),
      reply("sc", null, "sub", { isSidechain: true }),
    ];
    const out = parse(sanitizeClaudeTranscript(lines.join("\n"))!.lines);
    expect(out.map((r) => r.uuid)).toEqual(["u", "a"]);
  });

  it("adds the fallback title only when the session has none", () => {
    const lines = [user("u", null, "go"), reply("a", "u", "ok")];
    const titled = parse(sanitizeClaudeTranscript(lines.join("\n"), "wardby run r1: add discounts")!.lines);
    expect(titled.at(-1)).toEqual({ type: "ai-title", aiTitle: "wardby run r1: add discounts", sessionId: SID });
    const own = rec({ type: "ai-title", aiTitle: "Own title" });
    const kept = parse(sanitizeClaudeTranscript([...lines, own].join("\n"), "fallback")!.lines);
    expect(kept.filter((r) => r.type === "ai-title").map((r) => r.aiTitle)).toEqual(["Own title"]);
  });
});
