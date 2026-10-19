import type { CheckConclusion, InlineComment, ReviewVerdict } from "./types.js";

/** Agent ids are cuids; anything else could break out of the HTML comment. */
export const SAFE_AGENT_MARKER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_SHA = /^[0-9a-f]{40}$/;
const MARKER_PREFIX = "<!-- wardby:review:";

function assertMarker(agentMarker: string): void {
  if (!SAFE_AGENT_MARKER.test(agentMarker)) throw new Error("review_marker_invalid");
}

/**
 * `coveredSha`: the latest head this agent reviewed after reading every file. A marker without
 * it (an older one included) means none.
 */
export function reviewMarker(agentMarker: string, headSha: string, coveredSha?: string | null): string {
  assertMarker(agentMarker);
  if (!SAFE_SHA.test(headSha)) throw new Error("review_marker_invalid");
  if (coveredSha && !SAFE_SHA.test(coveredSha)) throw new Error("review_marker_invalid");
  return `${MARKER_PREFIX}${agentMarker} sha=${headSha}${coveredSha ? ` covered=${coveredSha}` : ""} -->`;
}

/**
 * The review marker counts only at the very start of a body, where renderSummaryComment writes it:
 * anywhere else it is text someone else wrote (model text the App posted, for one).
 */
export function hasReviewMarker(body: string, agentMarker: string): boolean {
  assertMarker(agentMarker);
  return body.startsWith(`${MARKER_PREFIX}${agentMarker} sha=`);
}

function matchReviewMarker(body: string, agentMarker: string): RegExpExecArray | null {
  assertMarker(agentMarker);
  return new RegExp(`^${MARKER_PREFIX}${agentMarker} sha=([0-9a-f]{40})(?: covered=([0-9a-f]{40}))? -->`).exec(body);
}

export function parseReviewMarker(body: string, agentMarker: string): string | null {
  return matchReviewMarker(body, agentMarker)?.[1] ?? null;
}

/** The marker's covered head; null for a marker without one. */
export function parseCoveredMarker(body: string, agentMarker: string): string | null {
  return matchReviewMarker(body, agentMarker)?.[2] ?? null;
}

/**
 * Model-written text the App posts, with every HTML comment opener escaped: GitHub shows `<!--` as
 * text, so no hidden comment (and no wardby marker) can come from it. One pass is enough, since the
 * replacement removes the opener's characters rather than joining text around it. wardby adds its
 * own markers after this.
 */
export function escapeHtmlComments(text: string): string {
  return text.replaceAll("<!--", "&lt;!--");
}

export function verdictConclusion(verdict: ReviewVerdict): CheckConclusion {
  if (verdict === "APPROVE") return "success";
  if (verdict === "CHANGES_REQUESTED") return "failure";
  return "neutral";
}

const BADGES: Record<ReviewVerdict, string> = {
  APPROVE: "✅ **Approved**",
  CHANGES_REQUESTED: "❌ **Changes requested**",
  COMMENT: "💬 **Comments**",
};

const FINDING_PREFIX = "<!-- wardby:finding:";

/** Tags an inline comment with the agent that wrote it, so only that agent resolves its thread. */
export function findingMarker(agentMarker: string): string {
  assertMarker(agentMarker);
  return `${FINDING_PREFIX}${agentMarker} -->`;
}

export function hasFindingMarker(body: string, agentMarker: string): boolean {
  return body.includes(findingMarker(agentMarker));
}

export function renderInlineComment(comment: InlineComment, agentMarker: string): string {
  return `**[${comment.severity}]** ${comment.body}\n\n${findingMarker(agentMarker)}`;
}

export function renderSummaryComment(input: {
  agentMarker: string;
  headSha: string;
  coveredSha?: string | null;
  verdict: ReviewVerdict;
  summary: string;
  body: string;
  outside: InlineComment[];
}): string {
  const sections = [
    reviewMarker(input.agentMarker, input.headSha, input.coveredSha),
    `${BADGES[input.verdict]} — reviewed \`${input.headSha.slice(0, 7)}\``,
    input.summary,
    input.body,
  ];
  if (input.outside.length > 0) {
    sections.push(
      ["## Outside the diff", ...input.outside.map((c) => `- **[${c.severity}] ${c.path}:${c.line}** ${c.body}`)].join(
        "\n",
      ),
    );
  }
  return sections.join("\n\n");
}
