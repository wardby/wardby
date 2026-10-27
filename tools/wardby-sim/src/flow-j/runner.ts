// TEST ONLY (wardby-sim). Flow J in scripted mode: a Jira issue → build → PR → review → merge →
// Jira write-back, with every outside service simulated (Jira Cloud, GitHub, the model), a real
// `wardby serve` on the host, and real coding pods and the real coding proxy on the Flow G kind
// cluster (deploy/kind-coding/flow-g-up.sh). Run through scripts/release/flow-j.mjs:
//
//   node scripts/release/flow-j.mjs --agent codex|claude [--variant default|duplicate|jira429] [--keep]
//
// In order: port-forwards the simulator; resets and seeds it (GitHub installation, repo,
// collaborator and webhook subscription; a Jira project, issue WID-1 and a webhook subscription;
// the Flow J turn scripts); creates the delivery, builder and reviewer agents through wardby's
// own MCP tools over stdio (admin-approved Jira and repository links); starts `wardby serve`
// under WARDBY_TEST_SIMULATORS with Jira configured against the simulator; assigns WID-1 to
// wardby's service account as a person would; waits for each stage; merges as a person would;
// checks J1–J9 (checks.ts) and writes a record under docs/private/releases/. No real credential
// is used anywhere: fake provider keys, the simulator's published test App key, a `sim-` Jira
// token, and a throwaway database.
//
// Variants: default; duplicate (the assignment's delivery is sent again with the same
// identifier: one run); jira429 (Jira answers the first comment write 429 with Retry-After:
// wardby retries once, and one request comment results).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RecordedCall } from "../state.js";
import {
  checkMarkedReady,
  checkNoSecrets,
  checkReviewPublished,
  unverifiedEventsUsed,
  unverifiedRoutesUsed,
  type Inspect,
} from "../flow-g/checks.js";
import { killTree, McpStdio, portOpen, psql, readEnvFile, simScript, sleep, waitFor } from "../flow-g/kit.js";
import { SIM_JIRA_BOT, SIM_JIRA_DEV, SIM_JIRA_SITE, SIM_JIRA_TOKEN } from "../jira/state.js";
import {
  checkBuilt,
  checkDuplicateAnswered,
  checkLedger,
  checkMergeWriteBack,
  checkOneRequestComment,
  checkPullRequestLinked,
  checkTriggered,
  unverifiedJiraEventsUsed,
  type JiraInspectIssue,
  type RunRow,
} from "./checks.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const CONTEXT = "kind-wardby-flowg";
const SIM_PORT = 18090;
const SIM_TLS_PORT = 18443;
const CP_PORT = 18091;
const RELAY_PORT = 18092;
const SIM = `http://127.0.0.1:${SIM_PORT}`;
const REPO = "acme/widgets";
const PROJECT = "WID";
const ISSUE = "WID-1";
const ISSUE_URL = `${SIM_JIRA_SITE}/browse/${ISSUE}`;
const GITHUB_WEBHOOK_SECRET = "flow-j-github-webhook-secret-0123";
const JIRA_WEBHOOK_SECRET = "flow-j-jira-webhook-secret-0123456789";
const FAKE_OPENAI = "sk-flowj-fake-openai-key";
const FAKE_ANTHROPIC = "sk-ant-flowj-fake-anthropic-key";
const CHECK_NAME = "wardby review";
const OPENED_STATUS = "In Review";
const MERGED_STATUS = "Done";
const AGENTS = { builder: "flow-j-builder", delivery: "flow-j-delivery", reviewer: "flow-j-reviewer" };

/**
 * Known findings, held like it.fails: a problem one of them matches is recorded under its id, not
 * failed; a finding that stops reproducing is reported. Every one is UNCONFIRMED until reproduced
 * against production code without the simulator.
 */
const KNOWN_FINDINGS: Record<string, { stage: string; matches: (problem: string) => boolean; note: string }> = {
  // FINDING: J2F, unconfirmed (see docs/private/p2/flow-j-report.md).
  J2F: {
    stage: "J2",
    matches: (problem) => problem.startsWith("the footer shows literal markdown"),
    note:
      "The Jira status comment's footer `_wardby run `<id>`_` (runLine + toJiraMarkdown) becomes one em text node " +
      "with the backticks kept: markdownToAdf does not parse inline code inside emphasis, so Jira shows literal backticks.",
  },
};

function splitFindings(problems: Record<string, string[]>): Record<string, string[]> {
  const findings: Record<string, string[]> = {};
  for (const [id, finding] of Object.entries(KNOWN_FINDINGS)) {
    const list = problems[finding.stage];
    if (!list) continue;
    const held = list.filter(finding.matches);
    problems[finding.stage] = list.filter((p) => !finding.matches(p));
    findings[id] = held.length > 0 ? [`reproduced: ${held.join("; ")} (${finding.note})`] : ["NO LONGER REPRODUCES"];
  }
  return findings;
}

interface Options {
  agent: "codex" | "claude";
  variant: "default" | "duplicate" | "jira429";
  keep: boolean;
  timeoutMin: number;
}

function parseArgs(argv: string[]): Options {
  const value = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const agent = value("agent", "codex");
  const variant = value("variant", "default");
  if (agent !== "codex" && agent !== "claude") throw new Error("--agent must be codex or claude");
  if (!["default", "duplicate", "jira429"].includes(variant))
    throw new Error("--variant must be default, duplicate or jira429");
  return {
    agent,
    variant: variant as Options["variant"],
    keep: argv.includes("--keep"),
    timeoutMin: Number(value("timeout-min", "20")),
  };
}

const log = (line: string) => process.stdout.write(`[flow-j] ${line}\n`);
const script = (steps: Record<string, unknown>[]) => simScript(SIM, steps);
const githubInspect = async () => (await script([{ action: "github.inspect", repo: REPO }]))[0] as Inspect;
const jiraInspect = async () =>
  ((await script([{ action: "jira.inspect", key: ISSUE }]))[0] as { issues: JiraInspectIssue[] }).issues[0];
const jiraDeliveries = async () =>
  ((await script([{ action: "jira.webhook_flush" }]))[0] as { deliveries: any[] }).deliveries;
const githubDeliveries = async () =>
  ((await script([{ action: "github.webhook_flush" }]))[0] as { deliveries: any[] }).deliveries;
const allCalls = async () => ((await (await fetch(`${SIM}/__sim/calls`)).json()) as { calls: RecordedCall[] }).calls;

/** Every run with its agent, cost, budget, usage and proxy ledger sums, and attribution. */
function runRows(databaseUrl: string): RunRow[] {
  const out = psql(
    `SELECT json_agg(x ORDER BY x."startedAt") FROM (
       SELECT r.id, a.name AS agent, r.status::text AS status, r."costUsd"::float8 AS "costUsd", r."parentRunId",
              a."budgetUsd"::float8 AS "budgetUsd", r."startedAt",
              COALESCE((SELECT SUM(u."costUsd") FROM "RunModelUsage" u WHERE u."runId" = r.id), 0)::float8 AS "usageUsd",
              (SELECT SUM(q."actualCostUsd")::float8 FROM "CodingProxySession" s JOIN "CodingProxyRequest" q ON q."sessionId" = s.id
                 WHERE s."runId" = r.id) AS "proxyUsd",
              (SELECT w.provider || ':' || w.key FROM "RunAttribution" t JOIN "WorkItem" w ON w.id = t."workItemId"
                 WHERE t."runId" = r.id) AS "workItem",
              (SELECT t.source FROM "RunAttribution" t WHERE t."runId" = r.id) AS "attributionSource"
       FROM "Run" r JOIN "Agent" a ON a.id = r."agentId") x`,
    databaseUrl,
  );
  return out ? (JSON.parse(out) as RunRow[]) : [];
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const native =
    options.agent === "codex"
      ? { model: "gpt-5.6-terra", proto: "codex" }
      : { model: "claude-sonnet-5", proto: "claude" };
  const builderModel = options.agent === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5";
  const children: ChildProcess[] = [];
  const problems: Record<string, string[]> = {};
  let findings: Record<string, string[]>;
  const notes: string[] = [];
  const startedAt = new Date();
  const cleanup = () => {
    for (const child of children) killTree(child);
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  const logDir = join(ROOT, "docs/private/flow-j");
  mkdirSync(logDir, { recursive: true });
  try {
    const envFile = join(ROOT, "docs/private/flow-g/control-plane.env");
    const clusterEnv = readEnvFile(envFile);
    log(`agent=${options.agent} variant=${options.variant}; cluster env from ${envFile}`);

    for (const port of [SIM_PORT, SIM_TLS_PORT, CP_PORT, RELAY_PORT]) {
      if (await portOpen(port)) throw new Error(`port ${port} is in use: a process from an earlier run is still up`);
    }

    // 1. The simulator, port-forwarded to loopback.
    for (const ports of [`${SIM_PORT}:8080`, `${SIM_TLS_PORT}:8443`]) {
      const forward = spawn(
        "kubectl",
        ["--context", CONTEXT, "-n", "wardby-sim", "port-forward", "svc/wardby-sim", ports],
        {
          stdio: "ignore",
        },
      );
      children.push(forward);
    }
    await waitFor("the simulator", 60_000, async () => ((await fetch(`${SIM}/__sim/health`)).ok ? true : undefined));

    // The relay a reverse proxy would be: same path, body and headers, the canonical Host. It
    // records each answer to a Jira delivery (the duplicate variant asserts on them).
    const jiraAnswers: { delivery: string; status: number | null; body: string }[] = [];
    const relay = createServer((req, res) => {
      const headers = { ...req.headers, host: `127.0.0.1:${CP_PORT}` };
      const upstream = httpRequest(
        { host: "127.0.0.1", port: CP_PORT, path: req.url, method: req.method, headers },
        (answer) => {
          const chunks: Buffer[] = [];
          answer.on("data", (c: Buffer) => chunks.push(c));
          answer.on("end", () => {
            const body = Buffer.concat(chunks);
            if (req.url?.startsWith("/hosts/jira/")) {
              jiraAnswers.push({
                delivery: String(req.headers["x-atlassian-webhook-identifier"] ?? ""),
                status: answer.statusCode ?? null,
                body: body.toString("utf8").slice(0, 300),
              });
            }
            res.writeHead(answer.statusCode ?? 502, answer.headers);
            res.end(body);
          });
        },
      );
      upstream.on("error", () => res.writeHead(502).end());
      req.pipe(upstream);
    });
    await new Promise<void>((done) => relay.listen(RELAY_PORT, "127.0.0.1", done));
    children.push({ kill: () => relay.close(), pid: undefined } as unknown as ChildProcess);

    // 2. A fresh database and simulator.
    const databaseUrl = clusterEnv.DATABASE_URL;
    const dbName = new URL(databaseUrl).pathname.slice(1);
    execFileSync(
      "docker",
      [
        "exec",
        "local-postgres-1",
        "psql",
        "-U",
        "wardby",
        "-d",
        "wardby",
        "-q",
        "-c",
        `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`,
        "-c",
        `CREATE DATABASE ${dbName};`,
      ],
      { stdio: "ignore" },
    );
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "ignore",
    });
    execFileSync("npx", ["dbos", "schema", databaseUrl], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "ignore",
    });
    log("fresh database");

    const reset = await fetch(`${SIM}/__sim/reset`, { method: "POST" });
    if (reset.status !== 204) throw new Error(`simulator reset failed: ${reset.status}`);
    const scripts = ["builder", "delivery", "reviewer"].map((agent) =>
      JSON.parse(
        readFileSync(
          join(
            ROOT,
            `tools/wardby-sim/scripts/flow-j/${agent}.${agent === "builder" ? options.agent : native.proto}.json`,
          ),
          "utf8",
        ),
      ),
    );
    await script([
      { action: "github.install", account: "acme", id: 42 },
      {
        action: "github.repo",
        repo: REPO,
        files: {
          "README.md": "# widgets\n",
          "package.json": `${JSON.stringify({ name: "widgets", version: "1.0.0", scripts: { test: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
        },
      },
      { action: "github.collaborator", repo: REPO, login: "dev", role: "write" },
      {
        action: "github.webhook_subscribe",
        url: `http://host.docker.internal:${RELAY_PORT}/hosts/github/events`,
        secret: GITHUB_WEBHOOK_SECRET,
      },
      { action: "jira.project", key: PROJECT, name: "Widgets" },
      {
        action: "jira.issue",
        project: PROJECT,
        summary: "Add a Flow J joke",
        description: "Please add a knock-knock joke to jokes/ in acme/widgets.",
        silent: true,
      },
      {
        action: "jira.webhook_subscribe",
        url: `http://host.docker.internal:${RELAY_PORT}/hosts/jira/events`,
        secret: JIRA_WEBHOOK_SECRET,
      },
      { action: "model.load", scripts },
    ]);

    // 3. The control plane's environment: nothing from any .env file (an empty project dir).
    const projectDir = mkdtempSync(join(tmpdir(), "wardby-flowj-project-"));
    const hex = (c: string) => c.repeat(64);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      WARDBY_PROJECT_DIR: projectDir,
      ...clusterEnv,
      WARDBY_TEST_SIMULATORS: "1",
      WARDBY_SIM_BASE_URL: `https://127.0.0.1:${SIM_TLS_PORT}`,
      GITHUB_APP_ID: "424242",
      GITHUB_APP_PRIVATE_KEY: readFileSync(join(ROOT, "tools/wardby-sim/fixtures/github-app-test-key.pem"), "utf8"),
      GITHUB_APP_WEBHOOK_SECRET: GITHUB_WEBHOOK_SECRET,
      WARDBY_GITHUB_ALLOWED_ACCOUNTS: "acme",
      // Jira against the simulator: the switch replaces the API base and refuses any token not `sim-`.
      WARDBY_JIRA_SITE_URL: SIM_JIRA_SITE,
      WARDBY_JIRA_API_BASE_URL: "https://api.atlassian.com/ex/jira/00000000-0000-4000-8000-000000000000",
      WARDBY_JIRA_API_TOKEN: SIM_JIRA_TOKEN,
      WARDBY_JIRA_WEBHOOK_SECRET: JIRA_WEBHOOK_SECRET,
      OPENAI_API_KEY: FAKE_OPENAI,
      ANTHROPIC_API_KEY: FAKE_ANTHROPIC,
      SECRET_APP_KEY: hex("a"),
      AUTH_PROVIDER: "self-hosted",
      AUTH_SIGNING_KEY: hex("b"),
      AUTH_CREDENTIAL_HASH_KEY: hex("c"),
      AUTH_AUDIENCE: `http://127.0.0.1:${CP_PORT}/mcp`,
      MCP_CANONICAL_URI: `http://127.0.0.1:${CP_PORT}/mcp`,
      VCS_WORK_ROOT: join(projectDir, "vcs"),
      CODING_JOB_STATE_ROOT: join(projectDir, "state"),
      CODING_ARTIFACT_ROOT: join(projectDir, "artifacts"),
      LOG_LEVEL: "info",
    };
    const wardby = (args: string[], extra: NodeJS.ProcessEnv, stdio: "pipe" | "log"): ChildProcess => {
      const child = spawn("npx", ["tsx", "--conditions=wardby-source", "src/wardby-bin.ts", ...args], {
        cwd: ROOT,
        env: { ...env, ...extra },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      if (stdio === "log") {
        const out = join(logDir, `${args[0]}.log`);
        writeFileSync(out, "");
        child.stdout.on("data", (d: Buffer) => writeFileSync(out, d, { flag: "a" }));
      }
      const err = join(logDir, `${args[0]}.err.log`);
      writeFileSync(err, "");
      child.stderr.on("data", (d: Buffer) => writeFileSync(err, d, { flag: "a" }));
      children.push(child);
      return child;
    };

    // 4. The agents, through wardby's own MCP tools (stdio: the local operator).
    const stdio = wardby(["mcp"], { MCP_TRANSPORT: "stdio" }, "pipe");
    const mcp = new McpStdio(stdio);
    await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "flow-j", version: "1" },
    });
    mcp.notify("notifications/initialized");
    const builder = await mcp.tool("create_agent", {
      name: AGENTS.builder,
      systemPrompt: "[flow-j:builder] Build what the task asks, run the tests, and report.",
      model: builderModel,
      budgetUsd: 5,
      kind: "coding",
      codingProfile: { provider: options.agent === "codex" ? "codex" : "claude-code", repository: REPO },
      repositoryAdminOverride: true,
    });
    const delivery = await mcp.tool("create_agent", {
      name: AGENTS.delivery,
      systemPrompt: "[flow-j:delivery] Deliver the Jira issue: read it, then delegate the build to the builder.",
      model: native.model,
      budgetUsd: 10,
      kind: "native",
      nativeExecutionMode: "control-plane",
    });
    const reviewer = await mcp.tool("create_agent", {
      name: AGENTS.reviewer,
      systemPrompt: "[flow-j:reviewer] Review the pull request: read every file, then publish your verdict.",
      model: native.model,
      budgetUsd: 5,
      kind: "native",
      nativeExecutionMode: "control-plane",
    });
    const idOf = (agent: any) => String(agent.id ?? agent.agent?.id);
    await mcp.tool("attach_subagent", {
      parentAgentId: idOf(delivery),
      childAgentId: idOf(builder),
      boundName: "builder",
    });
    await mcp.tool("link_issue_project", {
      agentId: idOf(delivery),
      projectKey: PROJECT,
      access: "write",
      triggers: ["assigned", "labeled"],
      triggerLabels: ["wardby"],
      trustedAccountIds: [SIM_JIRA_DEV],
      onPullRequestOpened: OPENED_STATUS,
      onPullRequestMerged: MERGED_STATUS,
    });
    // The run tree's root (the delivery agent) carries mark-ready; no repository trigger: Jira starts it.
    await mcp.tool("link_repository", {
      agentId: idOf(delivery),
      provider: "github",
      repository: REPO,
      access: "write",
      triggers: [],
      markReadyWhenPassing: true,
      adminOverride: true,
    });
    await mcp.tool("link_repository", {
      agentId: idOf(reviewer),
      provider: "github",
      repository: REPO,
      access: "write",
      triggers: ["pull_request"],
      checkName: CHECK_NAME,
      markReadyWhenPassing: true,
      adminOverride: true,
    });
    killTree(stdio);
    log("agents created and linked");

    // 5. wardby serve, under the switch.
    wardby(["serve"], { MCP_TRANSPORT: "http", MCP_HTTP_BIND: `127.0.0.1:${CP_PORT}` }, "log");
    await waitFor("wardby serve", 120_000, async () => ((await portOpen(CP_PORT)) ? true : undefined));
    log("wardby serve is listening");

    if (options.variant === "jira429") {
      // Jira rate-limits the first comment write (the "working on it" status comment).
      const fault = await fetch(`${SIM}/__sim/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service: "jira",
          method: "POST",
          path: "/rest/api/3/issue/{key}/comment",
          mode: "once",
          response: {
            status: 429,
            headers: { "retry-after": "2", "content-type": "application/json" },
            body: '{"errorMessages":["Rate limit exceeded."]}',
          },
        }),
      });
      if (fault.status !== 201) throw new Error(`could not add the 429 fault: ${fault.status}`);
    }

    // 6. J1: a person assigns WID-1 to wardby's service account.
    const deadline = options.timeoutMin * 60_000;
    const [assigned] = await script([{ action: "jira.assign", key: ISSUE, accountId: SIM_JIRA_BOT, by: SIM_JIRA_DEV }]);
    const runsOf = (agent: string) =>
      Number(
        psql(
          `SELECT count(*) FROM "Run" r JOIN "Agent" a ON a.id = r."agentId" WHERE a.name = '${agent}'`,
          env.DATABASE_URL!,
        ),
      );
    await waitFor("the delivery run", 120_000, async () => (runsOf(AGENTS.delivery) >= 1 ? true : undefined));
    log("delivery run started");
    let duplicateAnswers: { status: number | null }[] = [];
    if (options.variant === "duplicate") {
      const id = (assigned as { deliveries: string[] }).deliveries[0];
      await script([{ action: "jira.webhook_redeliver", id }]);
      await sleep(5000);
      duplicateAnswers = jiraAnswers.filter((a) => a.delivery === id).slice(1);
      notes.push(`duplicate delivery ${id} answered: ${JSON.stringify(duplicateAnswers)}`);
    }

    // J3/J4: the build and the PR.
    await waitFor("the pull request", deadline, async () =>
      (await githubInspect()).pulls.length > 0 ? true : undefined,
    );
    const pull = (await githubInspect()).pulls[0].number;
    log(`pull request #${pull} opened`);
    // J5: the review check.
    await waitFor("the review check", deadline, async () =>
      (await githubInspect()).checkRuns.some((r) => r.name === CHECK_NAME && r.status === "completed")
        ? true
        : undefined,
    );
    log("review published");
    // J7: ready for review.
    await waitFor("ready for review", 5 * 60_000, async () =>
      (await githubInspect()).pulls.find((p) => p.number === pull)?.draft === false ? true : undefined,
    ).catch((error: Error) => log(error.message));
    // The delivery run (the request comment's outcome) must be complete before the merge.
    await waitFor("the delivery run to finish", deadline, async () =>
      psql(
        `SELECT r.status FROM "Run" r JOIN "Agent" a ON a.id = r."agentId" WHERE a.name = '${AGENTS.delivery}' AND r."finishedAt" IS NOT NULL`,
        env.DATABASE_URL!,
      )
        ? true
        : undefined,
    ).catch((error: Error) => log(error.message));
    await waitFor("the request comment's outcome", 120_000, async () =>
      psql(`SELECT count(*) FROM "RunIssueStatus" WHERE "completedAt" IS NOT NULL`, env.DATABASE_URL!) !== "0"
        ? true
        : undefined,
    ).catch((error: Error) => log(error.message));
    const beforeMerge = await jiraInspect();

    // J8: a person merges; wardby's merge watcher writes back to Jira.
    await script([{ action: "github.merge", repo: REPO, number: pull, method: "squash", author: "dev" }]);
    log("merged by dev");
    await waitFor("the Jira write-back", 120_000, async () =>
      (await jiraInspect()).status === MERGED_STATUS ? true : undefined,
    ).catch((error: Error) => log(error.message));
    await sleep(10_000);

    // Collect and check.
    const calls = await allCalls();
    const github = await githubInspect();
    const issue = await jiraInspect();
    const jiraLog = await jiraDeliveries();
    const runs = runRows(env.DATABASE_URL!);
    const root = runs.find((r) => r.agent === AGENTS.delivery);
    const statusRows = JSON.parse(
      psql(
        `SELECT COALESCE(json_agg(json_build_object('runId', "runId", 'issueKey', "issueKey")), '[]') FROM "RunIssueStatus"`,
        env.DATABASE_URL!,
      ),
    ) as { runId: string; issueKey: string }[];
    const pairs = JSON.parse(
      psql(
        `SELECT COALESCE(json_agg(json_build_object('state', state, 'issueKey', "issueKey", 'number', number)), '[]') FROM "IssuePullRequest"`,
        env.DATABASE_URL!,
      ),
    ) as { state: string }[];
    const prUrl = `https://github.com/${REPO}/pull/${pull}`;
    const prFiles = await pullFiles(pull);
    const requestComment = issue.comments.find((c) => c.author === SIM_JIRA_BOT && !/was merged\./.test(c.text));

    problems.J1 = checkTriggered(runs, AGENTS.delivery, ISSUE, statusRows);
    if (options.variant === "duplicate")
      problems.duplicate = checkDuplicateAnswered(duplicateAnswers, runsOf(AGENTS.delivery));
    problems.J2 = checkOneRequestComment(issue, SIM_JIRA_BOT, root?.id, prUrl);
    // The status comment came before the PR (acknowledged first), and nothing the bot wrote is a second post.
    const firstComment = calls.find(
      (c) => c.service === "jira" && c.method === "POST" && c.path.endsWith("/comment") && c.status === 201,
    );
    const firstPr = calls.find(
      (c) => c.service === "github" && c.method === "POST" && c.path === `/repos/${REPO}/pulls`,
    );
    if (!firstComment || (firstPr && firstComment.seq > firstPr.seq))
      problems.J2.push("the working-on-it comment did not come before the PR");
    if (options.variant === "jira429") {
      const posts = calls
        .filter((c) => c.service === "jira" && c.method === "POST" && c.path.endsWith("/comment"))
        .map((c) => c.status);
      problems.rate429 =
        posts[0] === 429 && posts[1] === 201 ? [] : [`comment writes answered ${JSON.stringify(posts)}`];
    }
    problems.J3 = checkBuilt(runs, AGENTS.builder, prFiles, "jokes/flow-j.txt");
    problems.J4 = checkPullRequestLinked(calls, github, beforeMerge, {
      repo: REPO,
      issueUrl: ISSUE_URL,
      openedStatus: OPENED_STATUS,
    });
    problems.J5 = checkReviewPublished(github, pull, CHECK_NAME, "success");
    problems.J7 = checkMarkedReady(calls, github, pull);
    problems.J8 = checkMergeWriteBack(issue, SIM_JIRA_BOT, { prUrl, mergedStatus: MERGED_STATUS, pairs });
    if (!github.pulls.find((p) => p.number === pull)?.merged) problems.J8.push(`#${pull} is not merged`);
    problems.J9 = checkLedger(runs, root?.id, requestComment?.text, ISSUE);
    for (const run of runs)
      if (run.status !== "succeeded") problems.J9.push(`run not succeeded: ${run.agent} ${run.status}`);
    problems.secrets = checkNoSecrets(calls, {
      openaiKey: FAKE_OPENAI,
      anthropicKey: FAKE_ANTHROPIC,
      githubWebhookSecret: GITHUB_WEBHOOK_SECRET,
      jiraWebhookSecret: JIRA_WEBHOOK_SECRET,
      jiraToken: SIM_JIRA_TOKEN,
    });
    findings = splitFindings(problems);
    notes.push(
      `Jira deliveries: ${jiraLog.map((d) => `${d.event}${d.redelivery ? " (redelivered)" : ""} → ${d.attempts.map((a: { status: number | null }) => a.status).join(",")}`).join("; ")}`,
      `Jira ingress answers: ${jiraAnswers.map((a) => `${a.status} ${a.body}`).join(" | ")}`,
      `request comment: ${requestComment?.text.replace(/\n+/g, " ⏎ ").slice(0, 600) ?? "none"}`,
      `Jira status moves: ${issue.transitions.map((t) => `${t.from}→${t.to} by ${t.by}`).join(", ")}`,
      `PR body: ${(github.pulls.find((p) => p.number === pull)?.body ?? "").replace(/\n+/g, " ⏎ ").slice(0, 600)}`,
    );
    writeRecord(
      options,
      startedAt,
      problems,
      findings,
      unverifiedRoutesUsed(calls).map((r) => `${r.service} ${r.method} ${r.pattern}`),
      [
        ...unverifiedEventsUsed(await githubDeliveries()).map((e) => `github ${e}`),
        ...unverifiedJiraEventsUsed(jiraLog).map((e) => `jira ${e}`),
      ],
      runs
        .map(
          (r) =>
            `${r.agent} ${r.status} cost=${r.costUsd} usage=${r.usageUsd} proxy=${String(r.proxyUsd)} item=${String(r.workItem)}/${String(r.attributionSource)}`,
        )
        .join("\n"),
      notes,
    );
    for (const [stage, list] of Object.entries(problems))
      log(`${stage}: ${list.length === 0 ? "ok" : list.join("; ")}`);
    for (const [id, list] of Object.entries(findings)) log(`FINDING ${id} (unconfirmed): ${list.join("; ")}`);
    return Object.values(problems).some((list) => list.length > 0) ? 1 : 0;
  } finally {
    if (!options.keep) cleanup();
  }
}

/** The PR's changed file names (the simulator diffs its head against the base). */
async function pullFiles(pull: number): Promise<string[]> {
  const [result] = (await script([{ action: "github.inspect", repo: REPO, files: true }])) as [
    { pulls: { number: number; files?: string[] }[] },
  ];
  return result.pulls.find((p) => p.number === pull)?.files ?? [];
}

function writeRecord(
  options: Options,
  startedAt: Date,
  problems: Record<string, string[]>,
  findings: Record<string, string[]>,
  routes: string[],
  events: string[],
  runs: string,
  notes: string[],
): void {
  const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
  const dir = join(ROOT, "docs/private/releases");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${version}-flow-j-${options.agent}-${options.variant}.md`);
  const lines = [
    `# Flow J (scripted) — ${options.agent}, ${options.variant}`,
    "",
    `- Version: ${version}; started ${startedAt.toISOString()}; finished ${new Date().toISOString()}.`,
    "- Every outside service was simulated: anything found here is UNCONFIRMED until reproduced without the simulator.",
    "",
    "## Stages",
    ...Object.entries(problems).map(([stage, list]) => `- ${stage}: ${list.length === 0 ? "ok" : list.join("; ")}`),
    "",
    "## Findings (UNCONFIRMED: held like it.fails)",
    ...Object.entries(findings).map(([id, list]) => `- ${id}: ${list.join("; ")}`),
    "",
    "## Runs (agent status cost usage proxy attribution)",
    "```",
    runs,
    "```",
    "",
    "## Notes",
    ...notes.map((n) => `- ${n}`),
    "",
    "## Unverified simulator routes this run went through",
    ...routes.map((r) => `- ${r}`),
    "",
    "## Unverified outbound events",
    ...events.map((e) => `- ${e}`),
    "",
  ];
  writeFileSync(file, lines.join("\n"));
  log(`record: ${file}`);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`[flow-j] ${(error as Error).stack ?? String(error)}\n`);
    process.exit(2);
  },
);
