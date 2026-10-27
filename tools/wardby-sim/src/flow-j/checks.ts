// TEST ONLY (wardby-sim). Flow J's stage assertions (the design's Flow J table, J1–J9), as pure
// checks over what the simulator recorded (call log, a `jira.inspect` and `github.inspect`
// snapshot, Jira webhook deliveries) and rows read from wardby's database. Each check answers a
// list of problems (empty = the stage holds), so a record shows every failure, not just the first.
import { EVENTS } from "../routes.js";
import type { RecordedCall } from "../state.js";
import type { Inspect } from "../flow-g/checks.js";
import type { SlackMessage } from "../slack/web.js";

export interface JiraInspectIssue {
  key: string;
  status: string;
  labels: string[];
  assignee: string | null;
  transitions: { by: string; from: string; to: string }[];
  comments: {
    id: string;
    author: string;
    text: string;
    mentions: string[];
    edits: number;
    history: string[];
    visibility: unknown;
  }[];
  remoteLinks: {
    id: number;
    globalId: string;
    object: { url: string; title: string; status?: { resolved?: boolean } };
    writes: number;
  }[];
}

export interface RunRow {
  id: string;
  agent: string;
  status: string;
  costUsd: number;
  parentRunId: string | null;
  budgetUsd: number;
  /** Σ RunModelUsage.costUsd. */
  usageUsd: number;
  /** Σ CodingProxyRequest.actualCostUsd over the run's proxy session (coding runs), or null. */
  proxyUsd: number | null;
  /** The work item the run is attributed to ("jira:WID-1"), and how. */
  workItem: string | null;
  attributionSource: string | null;
}

/** A recorded GitHub comment write's `body` text. */
const bodyText = (call: RecordedCall): string => {
  const body = (call.body as { body?: unknown } | undefined)?.body;
  return typeof body === "string" ? body : "";
};

const MERGED_COMMENT = /Pull request .* was merged\./;

/** wardby's run-status footer as Jira shows it: the last line is `wardby run <id>`. */
const statusFooter = (text: string): string | null => {
  const last = text.trimEnd().split("\n").pop()?.trim() ?? "";
  const match = /^wardby run (\S+)$/.exec(last);
  return match ? match[1] : null;
};

/** The bot's comments that answer the request (everything but the merge write-back). */
function requestComments(issue: JiraInspectIssue, bot: string) {
  return issue.comments.filter((c) => c.author === bot && !MERGED_COMMENT.test(c.text));
}

/** J1: the Jira event started exactly one run of the delivery agent, tied to the issue (status row + attribution). */
export function checkTriggered(
  runs: RunRow[],
  deliveryAgent: string,
  issueKey: string,
  statusRows: { runId: string; issueKey: string }[],
  expectedRuns = 1,
): string[] {
  const problems: string[] = [];
  // The first run is the one the Jira event started (a fix round's later run is the agent's too).
  const roots = runs.filter((r) => r.agent === deliveryAgent);
  if (roots.length !== expectedRuns)
    problems.push(`expected ${expectedRuns === 1 ? "one" : expectedRuns} ${deliveryAgent} run, got ${roots.length}`);
  if (statusRows.length !== 1) problems.push(`expected one RunIssueStatus row, got ${statusRows.length}`);
  const root = roots[0];
  if (!root) return problems;
  if (!statusRows.some((s) => s.runId === root.id && s.issueKey === issueKey))
    problems.push(`no RunIssueStatus row ties run ${root.id} to ${issueKey}`);
  if (root.workItem !== `jira:${issueKey}`)
    problems.push(`run ${root.id} is attributed to ${String(root.workItem)}, expected jira:${issueKey}`);
  else if (root.attributionSource !== "issue_event")
    problems.push(`run ${root.id}'s attribution source is ${String(root.attributionSource)}, expected issue_event`);
  return problems;
}

/** The delivery ingress answered a redelivered (same identifier) event as a duplicate. */
export function checkDuplicateAnswered(answers: { status: number | null }[], runsOfDelivery: number): string[] {
  const problems: string[] = [];
  if (answers.length === 0) problems.push("the duplicate delivery was not sent");
  else if (answers.some((a) => a.status !== 202)) problems.push(`duplicate answered ${JSON.stringify(answers)}`);
  if (runsOfDelivery !== 1) problems.push(`expected one delivery run after the duplicate, got ${runsOfDelivery}`);
  return problems;
}

/**
 * J2: one comment per request: exactly one bot comment answers it (the status comment, edited
 * from "working on it" to the outcome, never a second post), carrying the run footer and a
 * link back to the pull request.
 */
export function checkOneRequestComment(
  issue: JiraInspectIssue,
  bot: string,
  rootRunId: string | undefined,
  pullUrl: string | undefined,
): string[] {
  const problems: string[] = [];
  const mine = requestComments(issue, bot);
  if (mine.length !== 1) {
    problems.push(`expected one request comment by the bot, got ${mine.length}`);
    for (const c of mine) problems.push(`  comment ${c.id}: ${c.text.slice(0, 120).replace(/\n/g, " ")}`);
  }
  const comment = mine[0];
  if (!comment) return problems;
  if (comment.edits < 1) problems.push("the status comment was never edited with the outcome");
  const footer = statusFooter(comment.text);
  if (!footer) problems.push("the request comment does not end with the run footer");
  else {
    // The id as Jira shows it; literal markdown around it (backticks that did not become a code mark) is
    // reported on its own.
    const id = footer.replace(/^`(.*)`$/, "$1");
    if (rootRunId && id !== rootRunId) problems.push(`the footer names run ${footer}, expected ${rootRunId}`);
    if (id !== footer) problems.push(`the footer shows literal markdown: "wardby run ${footer}"`);
  }
  if (pullUrl && !comment.text.includes(pullUrl)) problems.push(`the request comment does not link ${pullUrl}`);
  return problems;
}

/** J3: the builder's run succeeded and pushed a branch (the PR head) holding the file it was scripted to write. */
export function checkBuilt(
  runs: RunRow[],
  builderAgent: string,
  prFiles: string[],
  expectedFile: string,
  expectedRuns = 1,
): string[] {
  const problems: string[] = [];
  const built = runs.filter((r) => r.agent === builderAgent);
  if (built.length !== expectedRuns)
    problems.push(`expected ${expectedRuns === 1 ? "one" : expectedRuns} ${builderAgent} run, got ${built.length}`);
  for (const run of built) if (run.status !== "succeeded") problems.push(`builder run ${run.id} ended ${run.status}`);
  if (!prFiles.includes(expectedFile))
    problems.push(`the PR does not change ${expectedFile} (files: ${prFiles.join(", ")})`);
  return problems;
}

/**
 * J4: one PR, linked both ways: its body names the Jira issue with the issue's URL, a check run
 * was created on it, the Jira issue carries a web link to it, and the link's onPullRequestOpened
 * move happened.
 */
export function checkPullRequestLinked(
  calls: RecordedCall[],
  github: Inspect,
  issue: JiraInspectIssue,
  opts: { repo: string; issueUrl: string; openedStatus: string },
): string[] {
  const problems: string[] = [];
  const opened = calls.filter((c) => c.method === "POST" && c.path === `/repos/${opts.repo}/pulls` && c.status === 201);
  if (opened.length !== 1) problems.push(`expected one pull request opened, got ${opened.length}`);
  const pull = github.pulls.at(-1);
  if (!pull) return [...problems, "no pull request in the simulator"];
  const body = pull.body ?? "";
  if (!body.includes(issue.key)) problems.push(`the PR body does not name ${issue.key}`);
  if (!body.includes(opts.issueUrl)) problems.push(`the PR body does not link ${opts.issueUrl}`);
  if (!calls.some((c) => c.method === "POST" && c.path === `/repos/${opts.repo}/check-runs`))
    problems.push("no check run created");
  const prUrl = `https://github.com/${opts.repo}/pull/${pull.number}`;
  const links = issue.remoteLinks.filter((l) => l.object.url === prUrl);
  if (links.length !== 1) problems.push(`expected one web link to ${prUrl} on ${issue.key}, got ${links.length}`);
  if (!issue.transitions.some((t) => t.to === opts.openedStatus))
    problems.push(`${issue.key} was never moved to "${opts.openedStatus}" when the PR opened`);
  return problems;
}

/**
 * J8 (Jira side): after the merge, the issue's web link is resolved, the issue moved to the
 * merged status, and exactly one comment says the PR merged (and where the issue moved).
 */
export function checkMergeWriteBack(
  issue: JiraInspectIssue,
  bot: string,
  opts: { prUrl: string; mergedStatus: string; pairs: { state: string }[] },
): string[] {
  const problems: string[] = [];
  const link = issue.remoteLinks.find((l) => l.object.url === opts.prUrl);
  if (!link?.object.status?.resolved) problems.push(`the web link to ${opts.prUrl} is not resolved`);
  if (issue.status !== opts.mergedStatus)
    problems.push(`${issue.key} is "${issue.status}", expected "${opts.mergedStatus}"`);
  const merged = issue.comments.filter((c) => c.author === bot && MERGED_COMMENT.test(c.text));
  if (merged.length !== 1) problems.push(`expected one merged comment, got ${merged.length}`);
  else if (!merged[0].text.includes(`Moved to ${opts.mergedStatus}`))
    problems.push(`the merged comment does not say it moved the issue: ${merged[0].text.slice(0, 160)}`);
  if (opts.pairs.length !== 1 || opts.pairs[0].state !== "merged")
    problems.push(`IssuePullRequest rows: ${JSON.stringify(opts.pairs)} (expected one, merged)`);
  return problems;
}

/**
 * J6: the fix round. The first review requested changes, the review_fix round (a second run of
 * the delivery agent, attributed to the issue through the PR) had the builder continue the same
 * PR (a second push, no second PR), and the re-review approved: the last check is a success.
 */
export function checkFixRound(
  github: Inspect,
  calls: RecordedCall[],
  pull: number,
  checkName: string,
  runs: RunRow[],
  opts: { repo: string; delivery: string; builder: string; issueKey: string; pushes: number },
): string[] {
  const problems: string[] = [];
  // wardby's review is a summary comment edited in place (and the check), not a GitHub review:
  // its first text requests changes, its last approves.
  const reviewTexts = calls
    .filter(
      (c) =>
        (c.method === "POST" && c.path === `/repos/${opts.repo}/issues/${pull}/comments`) ||
        (c.method === "PATCH" && c.path.startsWith(`/repos/${opts.repo}/issues/comments/`)),
    )
    .map((c) => bodyText(c))
    .filter((body) => body.includes("<!-- wardby:review:"));
  if (!reviewTexts[0]?.includes("Changes requested")) problems.push("the first review text does not request changes");
  if (!reviewTexts.at(-1)?.includes("Approved")) problems.push("the last review text does not approve");
  const checks = github.checkRuns.filter((r) => r.name === checkName).map((r) => r.conclusion);
  if (checks[0] !== "failure" || checks.at(-1) !== "success")
    problems.push(`"${checkName}" checks concluded ${JSON.stringify(checks)}, expected failure then success`);
  if (opts.pushes !== 2) problems.push(`expected two pushes (build, fix), got ${opts.pushes}`);
  if (github.pulls.length !== 1) problems.push(`expected the fix on the same PR, got ${github.pulls.length} PRs`);
  const rounds = runs.filter((r) => r.agent === opts.delivery).slice(1);
  if (rounds.length !== 1) problems.push(`expected one fix-round run of ${opts.delivery}, got ${rounds.length}`);
  for (const round of rounds) {
    if (round.status !== "succeeded") problems.push(`fix-round run ${round.id} ended ${round.status}`);
    if (round.workItem !== `jira:${opts.issueKey}`)
      problems.push(
        `fix-round run ${round.id} is attributed to ${String(round.workItem)}, expected jira:${opts.issueKey}`,
      );
  }
  const started = calls.filter(
    (c) =>
      c.method === "POST" &&
      c.path === `/repos/${opts.repo}/issues/${pull}/comments` &&
      bodyText(c).includes("Fix round 1 of"),
  );
  if (started.length !== 1)
    problems.push(`expected one "Fix round 1" status comment on #${pull}, got ${started.length}`);
  return problems;
}

/**
 * Slack: one thread for the card (one top-level message, kept updated with the status, ending
 * merged), and exactly one reply per lifecycle event — picked up, PR opened (with the Jira move),
 * the review verdict(s), the fix round when there is one, and the merge (also broadcast to the
 * channel) — each linking the PR or naming the agent, never a second post of the same event.
 */
export function checkSlackThread(
  messages: SlackMessage[],
  opts: {
    issueUrl: string;
    prUrl: string;
    delivery: string;
    reviewer: string;
    openedStatus: string;
    mergedStatus: string;
    fixRound: boolean;
  },
): string[] {
  const problems: string[] = [];
  const live = messages.filter((m) => !m.deleted);
  const parents = live.filter((m) => !m.threadTs);
  if (parents.length !== 1) return [`expected one thread parent in the channel, got ${parents.length}`];
  const parent = parents[0];
  // The simulator keeps a message's current text in `text` and every earlier one in `edits`.
  const parentText = parent.text;
  if (!parentText.includes(opts.issueUrl)) problems.push("the thread parent does not link the Jira issue");
  if (!parentText.includes("merged ✅"))
    problems.push(`the thread parent ends "${parentText.slice(-40)}", expected merged ✅`);
  if (parent.edits.length === 0) problems.push("the thread parent was never updated");
  const replies = live.filter((m) => m.threadTs === parent.ts);
  const expected: [string, (text: string) => boolean][] = [
    ["picked up", (t) => t.startsWith(`🟢 Picked up by *${opts.delivery}*`)],
    [
      "PR opened",
      (t) => t.startsWith("🔀 PR ") && t.includes(opts.prUrl) && t.includes(`moved to ${opts.openedStatus}`),
    ],
    ["approved", (t) => t.startsWith(`✅ *${opts.reviewer}* approved`) && t.includes(opts.prUrl)],
    ["merged", (t) => t.startsWith("🎉 ") && t.includes(opts.prUrl) && t.includes(`moved to ${opts.mergedStatus}`)],
  ];
  if (opts.fixRound) {
    expected.push(
      ["changes requested", (t) => t.startsWith(`📝 *${opts.reviewer}* requested changes`)],
      ["fix round", (t) => t.startsWith("🔁 Fix round 1 of")],
    );
  }
  const matched = new Set<SlackMessage>();
  for (const [name, test] of expected) {
    const hits = replies.filter((m) => test(m.text));
    hits.forEach((m) => matched.add(m));
    if (hits.length !== 1) problems.push(`expected one "${name}" reply, got ${hits.length}`);
  }
  for (const extra of replies.filter((m) => !matched.has(m)))
    problems.push(`unexpected reply: ${extra.text.slice(0, 120)}`);
  const merged = replies.find((m) => m.text.startsWith("🎉 "));
  if (merged && !merged.replyBroadcast) problems.push("the merge reply was not broadcast to the channel");
  return problems;
}

/** Parses "$1.23" / "$0.0035" amounts out of the spend line ("Agent spend: $X this run · $Y on this issue so far"). */
export function spendAmounts(text: string): { run: number | null; issue: number | null } {
  const run = /Agent spend: \$([0-9.]+) this run/.exec(text);
  const issue = /\$([0-9.]+) on this issue so far/.exec(text);
  return { run: run ? Number(run[1]) : null, issue: issue ? Number(issue[1]) : null };
}

/** The tolerance a displayed amount may differ from the exact one (cents from $1; two significant digits below). */
function displayTolerance(amount: number): number {
  if (amount >= 1) return 0.005;
  if (amount === 0) return 0;
  return 10 ** (Math.floor(Math.log10(amount)) - 1) * 0.5 + 1e-12;
}

/**
 * J9: the ledger. Each run's cost equals its per-model usage rows and (coding runs) its proxy
 * ledger, and stays within its agent's budget; the Jira comment's "this run" spend is the
 * delivery run tree's cost, and "on this issue so far" is at least that and at most every run
 * attributed to the issue.
 */
export function checkLedger(
  runs: RunRow[],
  rootRunId: string | undefined,
  requestComment: string | undefined,
  issueKey: string,
): string[] {
  const problems: string[] = [];
  for (const run of runs) {
    if (Math.abs(run.costUsd - run.usageUsd) > 1e-6)
      problems.push(`${run.agent} run ${run.id}: costUsd ${run.costUsd} ≠ Σ model usage ${run.usageUsd}`);
    if (run.proxyUsd !== null && Math.abs(run.costUsd - run.proxyUsd) > 1e-6)
      problems.push(`${run.agent} run ${run.id}: costUsd ${run.costUsd} ≠ Σ proxy ledger ${run.proxyUsd}`);
    if (run.costUsd > run.budgetUsd + 1e-9)
      problems.push(`${run.agent} run ${run.id}: cost ${run.costUsd} over its budget ${run.budgetUsd}`);
  }
  if (!rootRunId) return [...problems, "no root run"];
  const tree = new Set([rootRunId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const run of runs) {
      if (run.parentRunId && tree.has(run.parentRunId) && !tree.has(run.id)) {
        tree.add(run.id);
        grew = true;
      }
    }
  }
  const treeUsd = runs.filter((r) => tree.has(r.id)).reduce((sum, r) => sum + r.costUsd, 0);
  const issueUsd = runs.filter((r) => r.workItem === `jira:${issueKey}`).reduce((sum, r) => sum + r.costUsd, 0);
  for (const run of runs.filter((r) => tree.has(r.id) && r.id !== rootRunId)) {
    if (run.workItem !== `jira:${issueKey}`)
      problems.push(`tree run ${run.id} is attributed to ${String(run.workItem)}`);
  }
  if (requestComment === undefined) return [...problems, "no request comment to read the spend from"];
  const shown = spendAmounts(requestComment);
  if (shown.run === null) problems.push("the request comment has no spend line");
  else if (Math.abs(shown.run - treeUsd) > displayTolerance(treeUsd))
    problems.push(`Jira shows $${shown.run} this run; the run tree cost ${treeUsd.toFixed(6)}`);
  if (
    shown.issue !== null &&
    (shown.issue + displayTolerance(issueUsd) < treeUsd - 1e-9 || shown.issue > issueUsd + displayTolerance(issueUsd))
  )
    problems.push(
      `Jira shows $${shown.issue} on the issue; tree ${treeUsd.toFixed(6)}, attributed runs ${issueUsd.toFixed(6)}`,
    );
  return problems;
}

/** The unverified Jira events a run's deliveries used. */
export function unverifiedJiraEventsUsed(deliveries: { event: string }[]): string[] {
  const events = new Set(deliveries.map((d) => d.event));
  return EVENTS.filter((e) => e.service === "jira" && !e.verified && events.has(e.event)).map((e) => e.event);
}
