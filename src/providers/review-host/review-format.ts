import type { CheckConclusion, InlineComment, ReviewVerdict } from "./types.js";

/** Agent ids are cuids; anything else could break out of the HTML comment. */
export const SAFE_AGENT_MARKER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_SHA = /^[0-9a-f]{40}$/;
const MARKER_PREFIX = "<!-- wardby:review:";

function assertMarker(agentMarker: string): void {
  if (!SAFE_AGENT_MARKER.test(agentMarker)) throw new Error("review_marker_invalid");
}

export function reviewMarker(agentMarker: string, headSha: string): string {
  assertMarker(agentMarker);
  if (!SAFE_SHA.test(headSha)) throw new Error("review_marker_invalid");
  return `${MARKER_PREFIX}${agentMarker} sha=${headSha} -->`;
}

export function hasReviewMarker(body: string, agentMarker: string): boolean {
  assertMarker(agentMarker);
  return body.includes(`${MARKER_PREFIX}${agentMarker} sha=`);
}

export function parseReviewMarker(body: string, agentMarker: string): string | null {
  assertMarker(agentMarker);
  const match = new RegExp(`${MARKER_PREFIX}${agentMarker} sha=([0-9a-f]{40}) -->`).exec(body);
  return match ? match[1] : null;
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

export function renderInlineComment(comment: InlineComment): string {
  return `**[${comment.severity}]** ${comment.body}`;
}

export function renderSummaryComment(input: {
  agentMarker: string;
  headSha: string;
  verdict: ReviewVerdict;
  summary: string;
  body: string;
  outside: InlineComment[];
}): string {
  const sections = [
    reviewMarker(input.agentMarker, input.headSha),
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
