// TEST ONLY (wardby-sim). Flow G's stage assertions, as pure checks over what the simulator
// recorded: its call log, its webhook deliveries and a `github.inspect` snapshot. The Flow G
// runner (scripts/release/flow-g.mjs, phase 2 task 10) calls these after each stage; each check
// answers a list of problems (empty = the stage holds) so a record can show every failure, not
// just the first.
import { matchPath } from "../http.js";
import { EVENTS, ROUTES, routeKey, type RouteEntry } from "../routes.js";
import type { RecordedCall } from "../state.js";

export interface Inspect {
  issues: { number: number; state: string; isPull: boolean; title: string }[];
  pulls: {
    number: number;
    state: string;
    draft: boolean;
    merged: boolean;
    head: string;
    base: string;
    body: string | null;
  }[];
  comments: { id: number; issue: number; user: string; body: string }[];
  reactions: { subject: { kind: string; id: number }; content: string; user: string }[];
  reviews: { id: number; pull: number; user: string; state: string; commitId: string }[];
  checkRuns: { id: number; name: string; headSha: string; status: string; conclusion: string | null; appId: number }[];
}

const repoPath = (repo: string) => `/repos/${repo}`;

/** G1: the trigger started exactly `expected` runs (runIds the ingress answered with). */
export function checkRunsStarted(runIds: string[], expected: number): string[] {
  return runIds.length === expected ? [] : [`expected ${expected} run(s) started, got ${runIds.length}`];
}

/** G1 outsider variant: wardby wrote nothing to GitHub at all. */
export function checkWroteNothing(calls: RecordedCall[]): string[] {
  const writes = calls.filter(
    (c) =>
      c.service === "github" &&
      c.method !== "GET" &&
      !c.path.startsWith("/app/") &&
      c.path !== "/installation/token" &&
      c.path !== "/graphql",
  );
  return writes.length === 0 ? [] : writes.map((c) => `unexpected write ${c.method} ${c.path}`);
}

/** G2: one 👀 reaction on the issue (or the mention comment), and exactly one status comment created on the issue. */
export function checkAcknowledged(calls: RecordedCall[], repo: string, issue: number): string[] {
  const problems: string[] = [];
  const eyes = calls.filter(
    (c) =>
      c.method === "POST" &&
      c.path.endsWith("/reactions") &&
      c.path.startsWith(`${repoPath(repo)}/issues/`) &&
      (c.body as { content?: string } | undefined)?.content === "eyes",
  );
  if (eyes.length !== 1) problems.push(`expected one eyes reaction, got ${eyes.length}`);
  const created = calls.filter(
    (c) => c.method === "POST" && c.path === `${repoPath(repo)}/issues/${issue}/comments` && c.status === 201,
  );
  if (created.length !== 1) problems.push(`expected one status comment on #${issue}, got ${created.length}`);
  return problems;
}

/** G4: one draft PR opened whose body links the issue with "From issue #N", and a check run on its head. */
export function checkPullRequestOpened(calls: RecordedCall[], inspect: Inspect, repo: string, issue: number): string[] {
  const problems: string[] = [];
  const opened = calls.filter((c) => c.method === "POST" && c.path === `${repoPath(repo)}/pulls` && c.status === 201);
  if (opened.length !== 1) problems.push(`expected one pull request opened, got ${opened.length}`);
  const pull = inspect.pulls.at(-1);
  if (!pull) return [...problems, "no pull request in the simulator"];
  if (!(pull.body ?? "").includes(`From issue #${issue}`))
    problems.push(`the PR body does not say "From issue #${issue}"`);
  const head = calls.find((c) => c.method === "POST" && c.path === `${repoPath(repo)}/check-runs`);
  if (!head) problems.push("no check run created");
  return problems;
}

/** G5: a review verdict reached the PR: the reviewer's summary comment and its check concluded as `conclusion`. */
export function checkReviewPublished(inspect: Inspect, pull: number, checkName: string, conclusion: string): string[] {
  const problems: string[] = [];
  if (!inspect.comments.some((c) => c.issue === pull)) problems.push(`no review summary comment on #${pull}`);
  const check = inspect.checkRuns.filter((r) => r.name === checkName).at(-1);
  if (!check) problems.push(`no "${checkName}" check run`);
  else if (check.conclusion !== conclusion)
    problems.push(`"${checkName}" concluded ${String(check.conclusion)}, expected ${conclusion}`);
  return problems;
}

/** G7: the PR was marked ready (once) and is no longer a draft. */
export function checkMarkedReady(calls: RecordedCall[], inspect: Inspect, pull: number): string[] {
  const problems: string[] = [];
  const marks = calls.filter(
    (c) => c.path === "/graphql" && JSON.stringify(c.body ?? "").includes("markPullRequestReadyForReview"),
  );
  if (marks.length !== 1) problems.push(`expected one ready-for-review call, got ${marks.length}`);
  if (inspect.pulls.find((p) => p.number === pull)?.draft !== false) problems.push(`#${pull} is still a draft`);
  return problems;
}

/** G8: merged; the issue stays open (From issue #N closes nothing) unless `closes`, and a comment links the merged PR. */
export function checkMergedOutcome(
  inspect: Inspect,
  repo: string,
  issue: number,
  pull: number,
  closes: boolean,
): string[] {
  const problems: string[] = [];
  if (!inspect.pulls.find((p) => p.number === pull)?.merged) problems.push(`#${pull} is not merged`);
  const state = inspect.issues.find((i) => i.number === issue)?.state;
  if (state !== (closes ? "closed" : "open"))
    problems.push(`issue #${issue} is ${String(state)}, expected ${closes ? "closed" : "open"}`);
  const link = `github.com/${repo}/pull/${pull}`;
  if (!closes && !inspect.comments.some((c) => c.issue === issue && c.body.includes(link))) {
    problems.push(`no comment on #${issue} links ${link}`);
  }
  return problems;
}

/** The forms a secret may take in an output: as is, URL-encoded, JSON-escaped, base64. */
function formsOf(value: string): string[] {
  return [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64")];
}

/** Every text wardby wrote (comments, PR bodies, review and check text, Slack messages) holds no secret value. */
export function checkNoSecrets(calls: RecordedCall[], secrets: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const call of calls) {
    const text = JSON.stringify(call.body ?? "");
    for (const [label, value] of Object.entries(secrets)) {
      if (value.length >= 8 && formsOf(value).some((form) => text.includes(form))) {
        problems.push(`${label} reached ${call.service} ${call.method} ${call.path}`);
      }
    }
  }
  return problems;
}

/** The unverified routes a run went through: every Flow G record lists them (task 11). */
export function unverifiedRoutesUsed(calls: RecordedCall[]): RouteEntry[] {
  const used = new Map<string, RouteEntry>();
  for (const call of calls) {
    const route = ROUTES.find(
      (r) => r.service === call.service && r.method === call.method && matchPath(r.pattern, call.path),
    );
    if (route && !route.verified) used.set(routeKey(route), route);
  }
  return [...used.values()];
}

/** The unverified outbound events a run's deliveries used. */
export function unverifiedEventsUsed(deliveries: { event: string }[]): string[] {
  const events = new Set(deliveries.map((d) => d.event));
  return EVENTS.filter((e) => e.service === "github" && !e.verified && events.has(e.event)).map((e) => e.event);
}
