// TEST ONLY (wardby-sim). Flow G in scripted mode (phase 2 task 10): a GitHub issue → build → PR →
// review → merge, with every outside service simulated, the model scripted ($0), a real `wardby
// serve` on the host, and real coding pods and the real coding proxy on the Flow G kind cluster
// (deploy/kind-coding/flow-g-up.sh). Run through scripts/release/flow-g.mjs:
//
//   node scripts/release/flow-g.mjs --agent codex|claude [--variant default|resolves|outsider] [--keep]
//
// What it does, in order: port-forwards the simulator; resets and seeds it (installation, repo,
// collaborator, webhook subscription, the Flow G turn scripts); creates the three agents through
// wardby's own MCP tools over stdio (as the local operator, with admin-approved repository
// links); starts `wardby serve` under WARDBY_TEST_SIMULATORS; opens the issue; waits for each
// stage; merges as a person would; checks every stage (checks.ts) and writes a record under
// docs/private/releases/. No real credential is used anywhere: fake provider keys, the
// simulator's published test App key, and a throwaway database.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RecordedCall } from "../state.js";
import {
  checkAcknowledged,
  checkMarkedReady,
  checkMergedOutcome,
  checkNoSecrets,
  checkPullRequestOpened,
  checkReviewPublished,
  checkRunsStarted,
  checkWroteNothing,
  unverifiedEventsUsed,
  unverifiedRoutesUsed,
  type Inspect,
} from "./checks.js";
import { killTree, McpStdio, portOpen, psql, readEnvFile, simScript, sleep, waitFor } from "./kit.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const CONTEXT = "kind-wardby-flowg";
const SIM_PORT = 18090;
/** The simulator over https, as the control plane reaches it (its git speaks https only). */
const SIM_TLS_PORT = 18443;
const CP_PORT = 18091;
/** The webhook relay: kind pods reach the host as host.docker.internal, but wardby serve accepts only its canonical Host. */
const RELAY_PORT = 18092;
const SIM = `http://127.0.0.1:${SIM_PORT}`;
const REPO = "acme/widgets";
const WEBHOOK_SECRET = "flow-g-webhook-secret-0123456789";
const FAKE_OPENAI = "sk-flowg-fake-openai-key";
const FAKE_ANTHROPIC = "sk-ant-flowg-fake-anthropic-key";
const SIM_SLUG = "wardby-sim";
const CHECK_NAME = "wardby review";

/**
 * Known findings, held like it.fails: a problem one of them matches is recorded under its id, not
 * failed; a finding that stops reproducing is reported. Every one is UNCONFIRMED until reproduced
 * against production code without the simulator.
 */
const KNOWN_FINDINGS: Record<string, { stage: string; matches: (problem: string) => boolean; note: string }> = {
  // FINDING: G8L, unconfirmed (see docs/private/p2/regression-phase2-report.md).
  G8L: {
    stage: "G8",
    matches: (problem) => problem.startsWith("no comment on #") && problem.includes("/pull/"),
    note:
      "After the PR merges, nothing on the GitHub issue links the merged PR (the design's G8 expectation). " +
      "issue-bridge.ts marks a GitHub issue's pair only (no tracker configured): possibly by design.",
  },
  // FINDING: S1, unconfirmed (see docs/private/p2/regression-phase2-report.md).
  S1: {
    stage: "stop",
    matches: (problem) => problem.startsWith("the cancelled run's PR #"),
    note:
      "stop_run while the builder's PR creation is in flight: the run is stored cancelled, the PR opens anyway " +
      "(the request completes), and nothing closes or marks it; the reviewer then reviews it.",
  },
};

function splitFindings(problems: Record<string, string[]>, ids: string[]): Record<string, string[]> {
  const findings: Record<string, string[]> = {};
  for (const [id, finding] of Object.entries(KNOWN_FINDINGS)) {
    if (!ids.includes(id)) continue;
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
  variant: "default" | "resolves" | "outsider";
  /** Task 12's fault variants, one per run. */
  fault: "none" | "retry500" | "stop-at-finish" | "wide-pr";
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
  if (!["default", "resolves", "outsider"].includes(variant))
    throw new Error("--variant must be default, resolves or outsider");
  const fault = value("fault", "none");
  if (!["none", "retry500", "stop-at-finish", "wide-pr"].includes(fault)) {
    throw new Error("--fault must be none, retry500, stop-at-finish or wide-pr");
  }
  return {
    agent,
    variant: variant as Options["variant"],
    fault: fault as Options["fault"],
    keep: argv.includes("--keep"),
    timeoutMin: Number(value("timeout-min", "20")),
  };
}

/**
 * Adds "Resolves #1" to the builder's PR description wherever its final answer carries the summary:
 * a summary field (Claude Code's StructuredOutput input) or a JSON text holding one (Codex's message).
 */
function withClosingKeyword(value: unknown): any {
  if (typeof value === "string") {
    if (value.startsWith("{") && value.includes('"summary"')) {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (typeof parsed.summary === "string")
          return JSON.stringify({ ...parsed, summary: `${parsed.summary}\n\nResolves #1` });
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(withClosingKeyword);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === "summary" && typeof v === "string" ? `${v}\n\nResolves #1` : withClosingKeyword(v),
      ]),
    );
  }
  return value;
}

const log = (line: string) => process.stdout.write(`[flow-g] ${line}\n`);
const script = (steps: Record<string, unknown>[]) => simScript(SIM, steps);

async function deliveriesOf(): Promise<any[]> {
  return ((await script([{ action: "github.webhook_flush" }]))[0] as { deliveries: any[] }).deliveries;
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
  let findings: Record<string, string[]> = {};
  const startedAt = new Date();
  const cleanup = () => {
    for (const child of children) killTree(child);
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  try {
    const envFile = join(ROOT, "docs/private/flow-g/control-plane.env");
    const clusterEnv = readEnvFile(envFile);
    log(`agent=${options.agent} variant=${options.variant}; cluster env from ${envFile}`);

    // 0. Nothing left over from an earlier run may hold the ports (a stray serve or port-forward).
    for (const port of [SIM_PORT, SIM_TLS_PORT, CP_PORT, RELAY_PORT]) {
      if (await portOpen(port)) throw new Error(`port ${port} is in use: a process from an earlier run is still up`);
    }

    // 1. The simulator, port-forwarded to loopback (the switch takes loopback or cluster-local only).
    const forward = spawn(
      "kubectl",
      ["--context", CONTEXT, "-n", "wardby-sim", "port-forward", "svc/wardby-sim", `${SIM_PORT}:8080`],
      { stdio: "ignore" },
    );
    children.push(forward);
    const forwardTls = spawn(
      "kubectl",
      ["--context", CONTEXT, "-n", "wardby-sim", "port-forward", "svc/wardby-sim", `${SIM_TLS_PORT}:8443`],
      { stdio: "ignore" },
    );
    children.push(forwardTls);
    await waitFor("the simulator", 60_000, async () => ((await fetch(`${SIM}/__sim/health`)).ok ? true : undefined));

    // The relay a reverse proxy would be in front of wardby: same path, body and headers, the canonical Host.
    let failNextWebhook = options.fault === "retry500";
    const relay = createServer((req, res) => {
      if (failNextWebhook) {
        failNextWebhook = false;
        req.resume();
        res.writeHead(500).end();
        return;
      }
      const headers = { ...req.headers, host: `127.0.0.1:${CP_PORT}` };
      const upstream = httpRequest(
        { host: "127.0.0.1", port: CP_PORT, path: req.url, method: req.method, headers },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on("error", () => res.writeHead(502).end());
      req.pipe(upstream);
    });
    await new Promise<void>((done) => relay.listen(RELAY_PORT, "127.0.0.1", done));
    children.push({ kill: () => relay.close() } as unknown as ChildProcess);

    // 2. A fresh database (the proxy and gateway reconnect) and a fresh simulator.
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
            `tools/wardby-sim/scripts/flow-g/${agent}.${agent === "builder" ? options.agent : native.proto}.json`,
          ),
          "utf8",
        ),
      ),
    );
    if (options.variant === "resolves") {
      // The builder writes GitHub's closing keyword into the PR description.
      const builder = scripts[0];
      builder.turns = withClosingKeyword(builder.turns);
    }
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
      { action: "github.user", login: "outsider" },
      {
        action: "github.webhook_subscribe",
        url: `http://host.docker.internal:${RELAY_PORT}/hosts/github/events`,
        secret: WEBHOOK_SECRET,
      },
      { action: "model.load", scripts },
    ]);

    // 3. The control plane's environment: nothing from any .env file (an empty project dir).
    const projectDir = mkdtempSync(join(tmpdir(), "wardby-flowg-project-"));
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
      GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      WARDBY_GITHUB_ALLOWED_ACCOUNTS: "acme",
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
        // Its own process group: npx → tsx → node is a tree, and a stray `wardby serve` from an
        // earlier run would keep scheduling against the next run's database.
        detached: true,
      });
      if (stdio === "log") {
        const out = join(ROOT, `docs/private/flow-g/${args[0]}.log`);
        writeFileSync(out, "");
        child.stdout.on("data", (d: Buffer) => writeFileSync(out, d, { flag: "a" }));
      }
      child.stderr.on("data", (d: Buffer) =>
        writeFileSync(join(ROOT, `docs/private/flow-g/${args[0]}.err.log`), d, { flag: "a" }),
      );
      children.push(child);
      return child;
    };

    // 4. The agents, through wardby's own MCP tools (stdio: the local operator).
    const stdio = wardby(["mcp"], { MCP_TRANSPORT: "stdio" }, "pipe");
    const mcp = new McpStdio(stdio);
    await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "flow-g", version: "1" },
    });
    mcp.notify("notifications/initialized");
    const builder = await mcp.tool("create_agent", {
      name: "flow-g-builder",
      systemPrompt: "[flow-g:builder] Build what the task asks, run the tests, and report.",
      model: builderModel,
      budgetUsd: 5,
      kind: "coding",
      codingProfile: { provider: options.agent === "codex" ? "codex" : "claude-code", repository: REPO },
      repositoryAdminOverride: true,
    });
    const delivery = await mcp.tool("create_agent", {
      name: "flow-g-delivery",
      systemPrompt: "[flow-g:delivery] Deliver the issue: delegate the build to the builder.",
      model: native.model,
      budgetUsd: 10,
      kind: "native",
      nativeExecutionMode: "control-plane",
    });
    const reviewer = await mcp.tool("create_agent", {
      name: "flow-g-reviewer",
      systemPrompt: "[flow-g:reviewer] Review the pull request: read every file, then publish your verdict.",
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
    await mcp.tool("link_repository", {
      agentId: idOf(delivery),
      provider: "github",
      repository: REPO,
      access: "write",
      triggers: ["mention"],
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

    if (options.fault === "wide-pr") {
      const files: Record<string, string> = {};
      for (let i = 0; i < 1001; i += 1) files[`src/f${String(i).padStart(4, "0")}.ts`] = `export const v${i} = ${i};\n`;
      await script([
        { action: "github.commit", repo: REPO, branch: "wide", files, author: "dev" },
        { action: "github.pull", repo: REPO, head: "wide", title: "Wide change", author: "dev" },
      ]);
      const inspectWide = async () => (await script([{ action: "github.inspect", repo: REPO }]))[0] as Inspect;
      await waitFor("the reviewer's check", options.timeoutMin * 60_000, async () =>
        (await inspectWide()).checkRuns.some((r) => r.name === CHECK_NAME && r.status === "completed")
          ? true
          : undefined,
      ).catch((error: Error) => log(error.message));
      await sleep(10_000);
      const snapshot = await inspectWide();
      const check = snapshot.checkRuns.filter((r) => r.name === CHECK_NAME).at(-1);
      // An APPROVE of a PR whose file list the host cut must be refused (file_list_truncated, bug 2).
      problems.wide = !check
        ? ["no review check on the 1,001-file PR (the reviewer did not run?)"]
        : check.conclusion === "success"
          ? ["the 1,001-file PR's review check concluded success"]
          : [];
      log(`wide PR review check: ${check?.status ?? "none"}/${String(check?.conclusion)}`);
      const reviews = snapshot.reviews.filter((r) => r.state === "APPROVED");
      if (reviews.length > 0) problems.wide.push(`an APPROVED review was posted: ${reviews.length}`);
      const calls = ((await (await fetch(`${SIM}/__sim/calls`)).json()) as { calls: RecordedCall[] }).calls;
      const runs = psql(
        `SELECT a.name || ' ' || r.status || ' ' || r."costUsd" FROM "Run" r JOIN "Agent" a ON a.id = r."agentId" ORDER BY r."startedAt"`,
        env.DATABASE_URL!,
      );
      problems.secrets = checkNoSecrets(calls, {
        openaiKey: FAKE_OPENAI,
        anthropicKey: FAKE_ANTHROPIC,
        webhookSecret: WEBHOOK_SECRET,
      });
      writeRecord(
        options,
        startedAt,
        problems,
        findings,
        unverifiedRoutesUsed(calls).map((r) => `${r.service} ${r.method} ${r.pattern}`),
        unverifiedEventsUsed(await deliveriesOf()),
        runs,
      );
      for (const [stage, list] of Object.entries(problems))
        log(`${stage}: ${list.length === 0 ? "ok" : list.join("; ")}`);
      return Object.values(problems).some((list) => list.length > 0) ? 1 : 0;
    }

    // 6. G1: the mention.
    const author = options.variant === "outsider" ? "outsider" : "dev";
    await script([
      {
        action: "github.issue",
        repo: REPO,
        title: "Add a Flow G joke",
        body: `@${SIM_SLUG} please add a knock-knock joke to jokes/.`,
        author,
      },
    ]);
    const issueNumber = 1;
    const deliveries = deliveriesOf;
    const firstDelivery = (await deliveries()).find(
      (d: { event: string; delivered: boolean }) => d.event === "issues" && d.delivered,
    ) as { id: string } | undefined;
    const runCount = () => Number(psql(`SELECT count(*) FROM "Run"`, env.DATABASE_URL!));
    if (options.variant === "outsider") {
      await sleep(20_000);
      problems.G1 = [...checkRunsStarted(Array.from({ length: runCount() }), 0)];
      const calls = ((await (await fetch(`${SIM}/__sim/calls?service=github`)).json()) as { calls: RecordedCall[] })
        .calls;
      problems.G1.push(...checkWroteNothing(calls));
    } else {
      await waitFor("the delivery run", 120_000, async () => (runCount() >= 1 ? true : undefined));
      // Redeliver the same event: wardby must not start a second run (duplicate delivery).
      if (firstDelivery) await script([{ action: "github.webhook_redeliver", id: firstDelivery.id }]);
      const deadline = options.timeoutMin * 60_000;
      const inspect = async () => (await script([{ action: "github.inspect", repo: REPO }]))[0] as Inspect;
      let stopResult: unknown;
      if (options.fault === "stop-at-finish") {
        // stop_run in the coding run's finish window (finding L1): the stopper is ready before the
        // builder's push, and stops the builder the moment the push lands (the PR, then the run's
        // completion, follow it).
        const stopper = wardby(["mcp"], { MCP_TRANSPORT: "stdio" }, "pipe");
        const stopClient = new McpStdio(stopper);
        await stopClient.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "flow-g", version: "1" },
        });
        stopClient.notify("notifications/initialized");
        // A slow GitHub: the builder's PR creation is held 20 s, so the stop lands while the coding
        // run is finishing (pushed, opening its PR) rather than after it.
        const held = await fetch(`${SIM}/__sim/faults`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            service: "github",
            method: "POST",
            path: "/repos/{owner}/{repo}/pulls",
            mode: "once",
            delayMs: 20_000,
            passThrough: true,
          }),
        });
        if (held.status !== 201) throw new Error(`could not hold the PR creation: ${held.status}`);
        const pushDeadline = Date.now() + deadline;
        for (;;) {
          const pushes = (
            (await (await fetch(`${SIM}/__sim/calls?service=github-git&method=POST`)).json()) as {
              calls: RecordedCall[];
            }
          ).calls.filter((c) => c.path.endsWith("git-receive-pack"));
          if (pushes.length > 0 || Date.now() > pushDeadline) break;
          await sleep(200);
        }
        const builderRun = psql(
          `SELECT r.id FROM "Run" r JOIN "Agent" a ON a.id = r."agentId" WHERE a.name = 'flow-g-builder' ORDER BY r."startedAt" DESC LIMIT 1`,
          env.DATABASE_URL!,
        );
        stopResult = await stopClient.tool("stop_run", { runId: builderRun }).catch((error: Error) => error.message);
        killTree(stopper);
        log(`stop_run at the push: ${JSON.stringify(stopResult).slice(0, 240)}`);
      }
      await waitFor("the pull request", deadline, async () =>
        (await inspect()).pulls.length > 0 ? true : undefined,
      ).catch((error: Error) => {
        if (options.fault !== "stop-at-finish") throw error;
        log(`${error.message} (stopped before the PR)`);
      });
      log("pull request opened");
      if (options.fault === "stop-at-finish") {
        const builderRun = psql(
          `SELECT r.id FROM "Run" r JOIN "Agent" a ON a.id = r."agentId" WHERE a.name = 'flow-g-builder' ORDER BY r."startedAt" DESC LIMIT 1`,
          env.DATABASE_URL!,
        );
        await sleep(30_000);
        const status = psql(`SELECT status FROM "Run" WHERE id = '${builderRun}'`, env.DATABASE_URL!);
        const snapshot = await inspect();
        const continuation = snapshot.checkRuns.filter((r) => r.name === "wardby/continuation").at(-1);
        problems.stop = [];
        if (!["succeeded", "cancelled"].includes(status)) problems.stop.push(`builder run ended ${status}`);
        // The stored outcome stays put (finding L1 would flip a cancelled run to succeeded later).
        await sleep(30_000);
        const later = psql(`SELECT status FROM "Run" WHERE id = '${builderRun}'`, env.DATABASE_URL!);
        if (later !== status) problems.stop.push(`builder run moved from ${status} to ${later} after the stop`);
        // A cancelled run must not leave a live PR behind that claims its work (lifecycle invariant:
        // PR/check text matches the stored state).
        if (status === "cancelled") {
          for (const pull of snapshot.pulls) {
            if (pull.state === "open" && (pull.body ?? "").includes(`<!-- wardby:${builderRun} -->`)) {
              problems.stop.push(`the cancelled run's PR #${pull.number} is open (draft=${String(pull.draft)})`);
            }
          }
        }
        // The PR's own check must tell the same story as the stored run (one terminal outcome).
        if (continuation && status === "cancelled" && continuation.conclusion === "success") {
          problems.stop.push("the run is stored cancelled but its PR check says success");
        }
        if (continuation && status === "succeeded" && continuation.conclusion !== "success") {
          problems.stop.push(
            `the run is stored succeeded but its PR check concluded ${String(continuation.conclusion)}`,
          );
        }
        log(
          `builder run after stop: ${status}; continuation check: ${continuation?.status ?? "none"}/${String(continuation?.conclusion)}; PRs: ${snapshot.pulls.length}`,
        );
        if (status === "cancelled" || snapshot.pulls.length === 0) {
          // The stop won: the rest of the flow has nothing to review. Record what the stop left behind.
          const calls = ((await (await fetch(`${SIM}/__sim/calls`)).json()) as { calls: RecordedCall[] }).calls;
          problems.secrets = checkNoSecrets(calls, {
            openaiKey: FAKE_OPENAI,
            anthropicKey: FAKE_ANTHROPIC,
            webhookSecret: WEBHOOK_SECRET,
          });
          const runs = psql(
            `SELECT a.name || ' ' || r.status || ' ' || r."costUsd" FROM "Run" r JOIN "Agent" a ON a.id = r."agentId" ORDER BY r."startedAt"`,
            env.DATABASE_URL!,
          );
          findings = splitFindings(problems, ["S1"]);
          writeRecord(
            options,
            startedAt,
            problems,
            findings,
            unverifiedRoutesUsed(calls).map((r) => `${r.service} ${r.method} ${r.pattern}`),
            unverifiedEventsUsed(await deliveriesOf()),
            `${runs}\nstop_run answered: ${JSON.stringify(stopResult).slice(0, 400)}\nPRs: ${JSON.stringify(snapshot.pulls.map((p) => ({ number: p.number, state: p.state, draft: p.draft })))}`,
          );
          for (const [stage, list] of Object.entries(problems))
            log(`${stage}: ${list.length === 0 ? "ok" : list.join("; ")}`);
          for (const [id, list] of Object.entries(findings)) log(`FINDING ${id} (unconfirmed): ${list.join("; ")}`);
          return Object.values(problems).some((list) => list.length > 0) ? 1 : 0;
        }
      }
      const pull = (await inspect()).pulls[0].number;
      await waitFor("the review check", deadline, async () =>
        (await inspect()).checkRuns.some((r) => r.name === CHECK_NAME && r.status === "completed") ? true : undefined,
      );
      log("review published");
      await waitFor("ready for review", 5 * 60_000, async () =>
        (await inspect()).pulls.find((p) => p.number === pull)?.draft === false ? true : undefined,
      ).catch((error: Error) => log(error.message));
      await script([{ action: "github.merge", repo: REPO, number: pull, method: "squash", author: "dev" }]);
      log("merged by dev");
      await sleep(30_000);
      const calls = ((await (await fetch(`${SIM}/__sim/calls`)).json()) as { calls: RecordedCall[] }).calls;
      const snapshot = await inspect();
      const firstPr =
        calls.find((c) => c.method === "POST" && c.path === `/repos/${REPO}/pulls`)?.seq ?? Number.MAX_SAFE_INTEGER;
      const runsStarted = Number(
        psql(
          `SELECT count(*) FROM "Run" r JOIN "Agent" a ON a.id = r."agentId" WHERE a.name = 'flow-g-delivery'`,
          env.DATABASE_URL!,
        ),
      );
      problems.G1 = checkRunsStarted(Array.from({ length: runsStarted }), 1);
      if (options.fault === "retry500") {
        // The first delivery was answered 500 by the relay: redelivered with the same id, routed once.
        const issues = (await deliveriesOf()).filter((d: { event: string }) => d.event === "issues");
        const statuses = (issues[0]?.attempts ?? []).map((a: { status: number | null }) => a.status);
        problems.retry = statuses[0] === 500 && statuses.at(-1) === 202 ? [] : [`attempts ${JSON.stringify(statuses)}`];
      }
      problems.G2 = checkAcknowledged(
        calls.filter((c) => c.service === "github" && c.seq < firstPr),
        REPO,
        issueNumber,
      );
      problems.G4 = checkPullRequestOpened(calls, snapshot, REPO, issueNumber);
      problems.G5 = checkReviewPublished(snapshot, pull, CHECK_NAME, "success");
      problems.G7 = checkMarkedReady(calls, snapshot, pull);
      problems.G8 = checkMergedOutcome(snapshot, REPO, issueNumber, pull, options.variant === "resolves");
      problems.secrets = checkNoSecrets(calls, {
        openaiKey: FAKE_OPENAI,
        anthropicKey: FAKE_ANTHROPIC,
        webhookSecret: WEBHOOK_SECRET,
      });
      const runs = psql(
        `SELECT a.name || ' ' || r.status || ' ' || r."costUsd" FROM "Run" r JOIN "Agent" a ON a.id = r."agentId" ORDER BY r."startedAt"`,
        env.DATABASE_URL!,
      );
      problems.G9 = runs
        .split("\n")
        .filter((line) => line && !/ (succeeded|completed) /.test(line))
        .map((line) => `run not succeeded: ${line}`);
      const all = await deliveries();
      // G8L is about the default flow (no closing keyword); the resolves variant checks closing instead.
      findings =
        options.variant === "default"
          ? splitFindings(problems, options.fault === "stop-at-finish" ? ["G8L", "S1"] : ["G8L"])
          : {};
      writeRecord(
        options,
        startedAt,
        problems,
        findings,
        unverifiedRoutesUsed(calls).map((r) => `${r.service} ${r.method} ${r.pattern}`),
        unverifiedEventsUsed(all),
        runs,
      );
    }
    const failed = Object.entries(problems).filter(([, list]) => list.length > 0);
    for (const [stage, list] of Object.entries(problems))
      log(`${stage}: ${list.length === 0 ? "ok" : list.join("; ")}`);
    for (const [id, list] of Object.entries(findings)) log(`FINDING ${id} (unconfirmed): ${list.join("; ")}`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    if (!options.keep) cleanup();
  }
}

function writeRecord(
  options: Options,
  startedAt: Date,
  problems: Record<string, string[]>,
  findings: Record<string, string[]>,
  routes: string[],
  events: string[],
  runs: string,
): void {
  const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
  const dir = join(ROOT, "docs/private/releases");
  mkdirSync(dir, { recursive: true });
  const suffix = options.fault === "none" ? "" : `-${options.fault}`;
  const file = join(dir, `${version}-flow-g-${options.agent}-${options.variant}${suffix}.md`);
  const lines = [
    `# Flow G (scripted) — ${options.agent}, ${options.variant}${options.fault === "none" ? "" : `, fault ${options.fault}`}`,
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
    "## Runs (agent status cost)",
    "```",
    runs,
    "```",
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
    process.stderr.write(`[flow-g] ${(error as Error).stack ?? String(error)}\n`);
    process.exit(2);
  },
);
