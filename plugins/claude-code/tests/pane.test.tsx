import { expect, mock, test } from "claude-code/testing";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const PANE = {
  plugin: "wardby-runs",
  component: "Pane",
  requestId: "wardby-runs",
  props: {
    title: "wardby runs",
    isFocused: false,
    bodyColumns: 48,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const;

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** Opens a run from the list: a Button in the terminal, the run's name link on the desktop. */
const openRun = (
  ui: { press: (t: { key: string; link?: { href: string } }) => Promise<unknown> },
  surface: string,
  id: string,
) =>
  surface === "desktop"
    ? ui.press({ key: `run-${id}`, link: { href: `https://wardby.invalid/run/${id}` } })
    : ui.press({ key: `run-${id}` });

/** A fake wardby server: list_agents, list_runs and get_run, with a run status the test can change. */
function fakeServer(on: Parameters<Parameters<typeof test>[1]>[1], state: { status: string }) {
  const calls: string[] = [];
  on("mcp.call", (_, e) => {
    calls.push(e.tool);
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_agents") return reply([{ id: "a1", name: "builder", budgetUsd: "1.0000" }]);
    if (e.tool === "list_runs")
      return reply([
        {
          id: "r1",
          agentId: "a1",
          ...(e.args.agentId === undefined ? { agentName: "builder", agentBudgetUsd: 1 } : {}),
          status: state.status,
          trigger: "webhook",
          costUsd: "0.210000",
          startedAt: iso(252_000),
          finishedAt: state.status === "running" ? null : iso(0),
          heartbeatAt: iso(8_000),
          turns: 31,
        },
      ]);
    if (e.tool === "get_run")
      return reply({
        id: "r1",
        status: state.status,
        request: "Rename /v1/accounts to /v1/workspaces",
        codingResult: {
          outcome: "pull_request_opened",
          repository: "your-org/api",
          pullRequestUrl: "https://github.com/your-org/api/pull/215",
        },
        services: ["postgres 16"],
      });
    return { value: { content: [{ type: "text", text: "unknown tool" }], isError: true } };
  });
  return calls;
}

function engine(on: Parameters<Parameters<typeof test>[1]>[1], toasts: string[]) {
  on("command.register", () => ({ value: { command: "wardby-runs" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.toast", (_, e) => {
    toasts.push(String(e.text));
    return { value: {} };
  });
  on("ui.status", () => ({ value: {} }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
}

test("lists a running run and opens its detail, on every surface", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  const toasts: string[] = [];
  engine(on, toasts);
  const calls = fakeServer(on, { status: "running" });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  // A current server lists runs across agents in one call, with no list_agents.
  expect(calls).toEqual(["list_runs"]);

  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    if (surface === "desktop") {
      // The desktop draws the mockup's summary tiles, a card per run and an SVG budget bar.
      // One summary sentence, and the run as a ledger line whose name is a link.
      expect((await ui.find({ type: "Text", text: /spent today/ }))?.text).toBe("1 running. $0.21 spent today.");
      expect((await ui.find({ key: "run-r1" }))?.type).toBe("Markdown");
    } else {
      expect((await ui.find({ type: "Text", text: /1 active/ }))?.text).toContain("$0.21 spent");
    }
    await openRun(ui, surface, "r1");
    await clock.settle();
    // The request is drawn as markdown.
    expect((await ui.find({ key: "request-text" }))?.props.text).toContain("Rename /v1/accounts");
    // What it produced: the pull request, named and linked, and the action to open it.
    expect((await ui.find({ type: "Link", text: /^Pull request #215 in your-org\/api$/ }))?.props.href).toBe(
      "https://github.com/your-org/api/pull/215",
    );
    expect(await ui.find({ type: "Link", text: /^Open pull request #215$/ })).toBeDefined();
    await ui.press({ key: "back" });
    // Back on the list: the run's row (a card on desktop) is there again.
    expect(await ui.find({ key: "run-r1" })).toBeDefined();
    await ui.unmount();
  }
});

test("a run that finishes raises a toast on the next poll", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  const toasts: string[] = [];
  engine(on, toasts);
  const run = { status: "running" };
  fakeServer(on, run);

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  expect(toasts).toEqual([]);

  run.status = "succeeded";
  await clock.advance(10_000);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toMatch(/^wardby · builder succeeded in .* \(\$0\.21\)$/);
});

test("nothing is polled until the pane opens", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const calls = fakeServer(on, { status: "running" });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await clock.advance(60_000);
  expect(calls).toEqual([]);

  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  expect(calls.length).toBeGreaterThan(0);
});

test("an older server without cross-agent listing falls back to one call per agent", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const calls: string[] = [];
  on("mcp.call", (_, e) => {
    calls.push(`${e.tool}${e.args.agentId ? ":" + String(e.args.agentId) : ""}`);
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs" && e.args.agentId === undefined)
      return { value: { content: [{ type: "text", text: "MCP error -32602: agentId is required" }], isError: true } };
    if (e.tool === "list_agents") return reply([{ id: "a1", name: "builder", budgetUsd: "1.0000" }]);
    if (e.tool === "list_runs")
      return reply([
        { id: "r1", status: "running", trigger: "manual", costUsd: "0.10", startedAt: iso(60_000), turns: 2 },
      ]);
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  expect(calls).toEqual(["list_runs", "list_agents", "list_runs:a1"]);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /1 active/ }))?.text).toContain("$0.10 spent");
  await ui.unmount();
});

/**
 * A server holding `total` runs (newest first) that pages list_runs with `before`, or ignores it as a
 * server before 0.9.2 does. Records each list_runs call's arguments.
 */
function pagingServer(
  on: Parameters<Parameters<typeof test>[1]>[1],
  total: number,
  opts: { ignoresBefore?: boolean } = {},
) {
  const calls: Record<string, unknown>[] = [];
  const all = Array.from({ length: total }, (_, i) => runRow(`r${i}`, "succeeded", 60_000 + i * 1000));
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool !== "list_runs") return reply({});
    calls.push({ ...e.args });
    const limit = Number(e.args.limit ?? 50);
    const at = e.args.before === undefined || opts.ignoresBefore ? 0 : all.findIndex((r) => r.id === e.args.before) + 1;
    return reply(all.slice(at, at + limit));
  });
  return calls;
}

test("a full refresh pages through the day 25 runs at a time and lists them all", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const calls = pagingServer(on, 60);

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  expect(calls.map((c) => [c.limit, c.before])).toEqual([
    [25, undefined],
    [25, "r24"],
    [25, "r49"],
  ]);
  expect(new Set(calls.map((c) => c.since)).size).toBe(1);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /in the last day/ }))?.text).toMatch(/60 in the last day/);
  expect(await ui.find({ type: "Text", text: /older than 0\.8\.0/ })).toBeUndefined();
  await ui.unmount();
});

test("a full refresh stops after 12 pages", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const calls = pagingServer(on, 400);

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  expect(calls).toHaveLength(12);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /in the last day/ }))?.text).toMatch(/300 in the last day/);
  await ui.unmount();
});

test("a server that ignores before gives one page, with no error and no repeats", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const calls = pagingServer(on, 60, { ignoresBefore: true });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  // The second call returns the first page again: the pane stops there.
  expect(calls).toHaveLength(2);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /in the last day/ }))?.text).toMatch(/25 in the last day/);
  expect(await ui.find({ type: "Text", text: /^wardby: / })).toBeUndefined();
  await ui.unmount();
});

test("an incremental refresh is still one call of up to 100 runs", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const calls = pagingServer(on, 60);

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  expect(calls).toHaveLength(3);
  await clock.advance(60_000);
  expect(calls).toHaveLength(4);
  expect(calls[3]).toEqual({ since: new Date(NOW - 30_000).toISOString(), limit: 100 });
});

test("a server before 0.8.0 shows the upgrade notice over the per-agent list, until it answers again", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  let upgraded = false;
  const calls: string[] = [];
  on("mcp.call", (_, e) => {
    calls.push(`${e.tool}${e.args.agentId ? ":" + String(e.args.agentId) : ""}`);
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs" && e.args.agentId === undefined && !upgraded)
      return { value: { content: [{ type: "text", text: "MCP error -32602: agentId is required" }], isError: true } };
    if (e.tool === "list_agents") return reply([{ id: "a1", name: "builder", budgetUsd: "1.0000" }]);
    if (e.tool === "list_runs") return reply([runRow("r1", "succeeded", 60_000)]);
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  expect(calls).toEqual(["list_runs", "list_agents", "list_runs:a1"]);
  const notice =
    "This wardby server is older than 0.8.0, so the pane runs in a limited mode: no pull-request grouping, " +
    "outcomes or run steps. Upgrade the server to 0.8.0 or later.";
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect((await ui.find({ type: "Text", text: /older than 0\.8\.0/ }))?.text).toBe(notice);
    expect(await ui.find({ type: "Text", text: /^wardby: / })).toBeUndefined();
    // The list is still there under it.
    expect(await ui.find({ key: "run-r1" })).toBeDefined();
    await ui.unmount();
  }

  // Upgraded: the next re-probe (every 6 polls) lists across agents again and the notice goes.
  upgraded = true;
  await clock.advance(10 * 60_000);
  expect(calls.filter((c) => c === "list_runs").length).toBeGreaterThan(1);
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await ui.find({ type: "Text", text: /older than 0\.8\.0/ })).toBeUndefined();
    expect(await ui.find({ key: "run-r1" })).toBeDefined();
    await ui.unmount();
  }
});

test("a server error shows in the pane instead of the list", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  on("mcp.call", () => ({
    value: { content: [{ type: "text", text: "insufficient_scope" }], isError: true },
  }));

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /insufficient_scope/ }))?.text).toBe(
    "wardby: list_runs: insufficient_scope",
  );
  await ui.unmount();
});

/** A server that records each list_runs call's `since`, and answers from `rows`. */
function recordingServer(on: Parameters<Parameters<typeof test>[1]>[1], rows: () => Record<string, unknown>[]) {
  const sinces: number[] = [];
  on("mcp.call", (_, e) => {
    if (e.tool === "list_runs") sinces.push(Date.parse(String(e.args.since)));
    return {
      value: {
        content: [{ type: "text", text: JSON.stringify(e.tool === "list_runs" ? rows() : {}) }],
        isError: false,
      },
    };
  });
  return sinces;
}

const runRow = (id: string, status: string, startedMsAgo: number) => ({
  id,
  agentId: "a1",
  agentName: "builder",
  agentBudgetUsd: 1,
  status,
  trigger: "manual",
  costUsd: "0.01",
  startedAt: iso(startedMsAgo),
  finishedAt: status === "running" ? null : iso(0),
  turns: 1,
});

test("refreshes every 10s while a run is active and every 60s when none is", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  let status = "running";
  const sinces = recordingServer(on, () => [runRow("r1", status, 60_000)]);

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  expect(sinces).toHaveLength(1);
  await clock.advance(10_000);
  expect(sinces).toHaveLength(2);

  status = "succeeded";
  await clock.advance(10_000);
  expect(sinces).toHaveLength(3);
  // Nothing is active now: the next refresh waits a minute.
  await clock.advance(55_000);
  expect(sinces).toHaveLength(3);
  await clock.advance(10_000);
  expect(sinces).toHaveLength(4);
});

test("after the first refresh, asks only for changes since the last one and keeps earlier rows", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  let reply = [runRow("r1", "running", 60_000), runRow("r2", "succeeded", 120_000)];
  const sinces = recordingServer(on, () => reply);

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  // The first refresh covers the whole day.
  expect(sinces[0]).toBe(NOW - 24 * 60 * 60 * 1000);

  reply = [runRow("r1", "running", 70_000)];
  await clock.advance(10_000);
  // The next asks from the last refresh, less 30s of overlap.
  expect(sinces[1]).toBe(NOW - 30_000);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  // r2 wasn't in the second reply but is still listed.
  expect((await ui.find({ type: "Text", text: /in the last day/ }))?.text).toMatch(/2 in the last day/);
  await ui.unmount();
});

test("backs off a failing server instead of asking every period", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  let calls = 0;
  on("mcp.call", () => {
    calls += 1;
    return { value: { content: [{ type: "text", text: "rate limited" }], isError: true } };
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  expect(calls).toBe(1);
  // Waits 10s, then 20s, then 40s: three more tries in the next 70 seconds, not seven.
  await clock.advance(70_000);
  expect(calls).toBe(4);
});

test("Refresh asks again, and /wardby-runs close closes the pane and stops polling", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const closed: string[] = [];
  on("ui.close", (_, e) => {
    closed.push(e.id);
    return { value: undefined };
  });
  const sinces = recordingServer(on, () => [runRow("r1", "running", 60_000)]);

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "refresh" });
  await clock.settle();
  expect(sinces).toHaveLength(2);
  expect(await ui.find({ key: "close" })).toBeDefined();
  await ui.unmount();

  await $.command.run({ command: "wardby-runs", args: "close" });
  expect(closed).toEqual(["wardby-runs"]);
  await clock.advance(60_000);
  expect(sinces).toHaveLength(2);
});

test("a list row shows a long pull request task as one short linked line", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const quoted = "The earlier review said: " + "x".repeat(2000);
  const reviewer = {
    ...runRow("r1", "succeeded", 60_000),
    agentName: "reviewer",
    trigger: "host_event",
    taskOverride: `Review pull request #12 in your-org/api (head 0123456789abcdef).\n\nA review-fix round concluded.\n\n<untrusted_context>\n${quoted}\n</untrusted_context>`,
  };
  recordingServer(on, () => [reviewer]);

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  const link = await ui.find({ type: "Link", text: /Review pull request #12/ });
  expect(link?.props.href).toBe("https://github.com/your-org/api/pull/12");
  expect(link?.props.label).toBe("Review pull request #12 in your-org/api");
  expect(await ui.find({ text: /untrusted_context|xxxxxxxxxx/ })).toBeUndefined();
});

test("rows show the trigger and task, and the status and text filters narrow the list", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const reviewer = {
    ...runRow("r1", "succeeded", 60_000),
    agentName: "reviewer",
    trigger: "host_event",
    taskOverride: "Review pull request #12 in your-org/api",
  };
  const builder = {
    ...runRow("r2", "running", 30_000),
    agentName: "builder",
    trigger: "subagent",
    parentRunId: "lead1",
  };
  const failed = { ...runRow("r3", "failed", 90_000), agentName: "planner", trigger: "scheduled" };
  recordingServer(on, () => [reviewer, builder, failed]);

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /GitHub\/Jira event/ })).toBeDefined();
  // The task names a pull request in a GitHub repository, so it is a link to it.
  const link = await ui.find({ type: "Link", text: /Review pull request #12/ });
  expect(link?.props.href).toBe("https://github.com/your-org/api/pull/12");
  expect(await ui.find({ type: "Text", text: /sub-agent \(from a lead run\)/ })).toBeDefined();

  await ui.press({ key: "status-failed" });
  expect(await ui.find({ key: "run-r3" })).toBeDefined();
  expect(await ui.find({ key: "run-r1" })).toBeUndefined();
  expect((await ui.find({ type: "Text", text: /of 3 shown/ }))?.text).toBe("1 of 3 shown");

  await ui.press({ key: "status-all" });
  await ui.input({ key: "filter-text", text: "pull request", kind: "change" });
  expect(await ui.find({ key: "run-r1" })).toBeDefined();
  expect(await ui.find({ key: "run-r2" })).toBeUndefined();

  await ui.press({ key: "clear-filter" });
  expect(await ui.find({ key: "run-r2" })).toBeDefined();
  // /wardby-runs clear does the same from the prompt.
  await ui.press({ key: "status-failed" });
  expect(await ui.find({ key: "run-r2" })).toBeUndefined();
  await $.command.run({ command: "wardby-runs", args: "clear" });
  expect(await ui.find({ key: "run-r2" })).toBeDefined();
  await ui.unmount();
});

test("Continue locally pipes the link to wardby resume and shows only the command, never the link", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const LINK = "https://wardby.example/transcripts/dl?s=FAKE-SIGNED-STATE-123";
  on("session.cwd", () => ({ value: "/home/me/code/wardby" }));
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([runRow("r1", "succeeded", 60_000)]);
    if (e.tool === "get_run")
      return reply({
        id: "r1",
        status: "succeeded",
        codingResult: {
          outcome: "pull_request_opened",
          repository: "your-org/api",
          pullRequestUrl: "https://github.com/your-org/api/pull/9",
        },
      });
    if (e.tool === "get_run_transcript")
      return reply({
        runId: "r1",
        status: "stored",
        repository: "your-org/api",
        download: { url: LINK, expiresAt: iso(-600_000) },
      });
    return reply({});
  });
  on("fs.stat", () => ({ value: { kind: "dir", size: 0, mtimeMs: 0, isLink: false } }));
  const copied: string[] = [];
  on("ui.copy", (_, e) => {
    copied.push(e.text);
    return { value: { isCopied: true } };
  });
  const spawned: { argv: readonly string[]; cwd?: string; stdin?: string }[] = [];
  on("process.run", (_, e) => {
    spawned.push({ argv: e.argv, cwd: e.init?.cwd, stdin: e.init?.stdin });
    return {
      value: {
        exitCode: 0,
        // A command that echoed the link would still not show it.
        stdout: `Imported run r1 from ${LINK}\ncd '/home/me/code/api-run-r1' && claude --resume /x/s.jsonl --append-system-prompt 'moved'\n`,
        stderr:
          "Checkout:     /home/me/code/api run r1 at wardby/r1\n" +
          "To remove the import later: delete /home/me/.wardby/sessions/r1 and run git worktree remove /home/me/code/api run r1.\n",
      },
    };
  });

  await $.session.start({ cwd: "/home/me/code/wardby", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  const dirInput = await ui.find({ key: "resume-dir" });
  expect(dirInput?.props.value).toBe("/home/me/code/api");

  await ui.press({ key: "continue-locally" });
  await clock.settle();
  expect(spawned).toHaveLength(1);
  expect(spawned[0].argv).toEqual(["npx", "-y", "@wardby/cli@latest", "resume", "-", "--print"]);
  expect(spawned[0].cwd).toBe("/home/me/code/api");
  expect(spawned[0].stdin).toBe(`${LINK}\n`);

  expect(await ui.find({ type: "Text", text: /cd '\/home\/me\/code\/api-run-r1' && claude --resume/ })).toBeDefined();
  expect(await ui.find({ key: "copy-command" })).toBeDefined();
  // What the import said to remove later, as commands to paste once done, quoted as the import quotes.
  const cleanup =
    "git -C /home/me/code/api worktree remove '/home/me/code/api run r1'\nrm -r /home/me/.wardby/sessions/r1";
  expect(await ui.find({ type: "Text", text: cleanup })).toBeDefined();
  await ui.press({ key: "copy-cleanup" });
  await clock.settle();
  expect(copied).toEqual([cleanup]);
  // The link is nowhere in what the pane draws.
  const texts = (await ui.findAll({ type: "Text" })).map((el) => el.text).join("\n");
  expect(texts).not.toContain("FAKE-SIGNED-STATE-123");
  await ui.unmount();
});

test("More shows the whole request wrapped, and Less cuts it back to a line", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const request = `Rename the accounts API. ${"Keep every existing client working. ".repeat(20)}END-OF-REQUEST`;
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([runRow("r1", "running", 60_000)]);
    if (e.tool === "get_run") return reply({ id: "r1", status: "running", request });
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "run-r1" });
  await clock.settle();
  // Cut short, as markdown, until expanded; then whole.
  expect((await ui.find({ key: "request-text" }))?.props.text).not.toContain("END-OF-REQUEST");

  await ui.press({ key: "expand" });
  expect((await ui.find({ key: "request-text" }))?.props.text).toContain("END-OF-REQUEST");
  expect((await ui.find({ key: "expand" }))?.text).toBe("Show less (m)");

  await ui.press({ key: "expand" });
  expect((await ui.find({ key: "request-text" }))?.props.text).not.toContain("END-OF-REQUEST");
  await ui.unmount();
});

test("sub-agent runs nest under their lead, and the detail shows the run tree", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const lead = { ...runRow("lead", "running", 300_000), agentName: "builder" };
  const migrate = {
    ...runRow("kid1", "succeeded", 200_000),
    agentName: "migration-writer",
    parentRunId: "lead",
    trigger: "subagent",
  };
  const client = {
    ...runRow("kid2", "running", 100_000),
    agentName: "client-updater",
    parentRunId: "lead",
    trigger: "subagent",
  };
  const other = { ...runRow("solo", "succeeded", 50_000), agentName: "reviewer" };
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([other, client, migrate, lead]);
    if (e.tool === "get_run") return reply({ id: e.args.runId, status: "running" });
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  // Newest tree first, children in the order they started, under their lead.
  const order = (await ui.findAll({ type: "Button" }))
    .map((el) => el.key)
    .filter((key): key is string => typeof key === "string" && key.startsWith("run-"));
  expect(order).toEqual(["run-solo", "run-lead", "run-kid1", "run-kid2"]);
  expect((await ui.find({ key: "run-kid1" }))?.text).toContain("└ ");

  await ui.press({ key: "run-kid2" });
  await clock.settle();
  expect(await ui.find({ type: "Text", text: /^Run tree$/ })).toBeDefined();
  expect((await ui.find({ type: "Text", text: /lead · this run|sub-agent · this run/ }))?.text).toContain(
    "client-updater",
  );
  await ui.press({ key: "tree-lead" });
  await clock.settle();
  expect((await ui.find({ type: "Text", text: /lead · this run|sub-agent · this run/ }))?.text).toContain("builder");
  await ui.unmount();
});

test("runs linked by a pull request sit under it newest first, with the event that started each", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const pr = { kind: "code_host", provider: "github", repository: "your-org/api", number: 160 };
  const opener = {
    ...runRow("open1", "succeeded", 600_000),
    agentName: "smoke",
    trigger: "manual",
    triggerInfo: { kind: "manual" },
    outcomes: [
      {
        kind: "pull_request",
        provider: "github",
        repository: "your-org/api",
        number: 160,
        url: "https://github.com/your-org/api/pull/160",
      },
    ],
  };
  const review = {
    ...runRow("rev1", "succeeded", 400_000),
    agentName: "pr-reviewer",
    trigger: "host_event",
    triggerInfo: { ...pr, event: "review" },
    outcomes: [{ kind: "check", provider: "github", repository: "your-org/api", number: 160, completed: true }],
  };
  const fix = {
    ...runRow("fix1", "running", 200_000),
    agentName: "delivery",
    trigger: "host_event",
    triggerInfo: { ...pr, event: "mention" },
    outcomes: [],
  };
  const builder = {
    ...runRow("bld1", "running", 100_000),
    agentName: "builder",
    trigger: "subagent",
    parentRunId: "fix1",
    triggerInfo: { kind: "subagent" },
    outcomes: [],
  };
  const other = {
    ...runRow("solo", "succeeded", 50_000),
    agentName: "auditor",
    triggerInfo: { kind: "scheduled" },
    outcomes: [],
  };
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([other, builder, fix, review, opener]);
    if (e.tool === "get_run") return reply({ id: e.args.runId, status: "succeeded" });
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  const heading = await ui.find({ type: "Link", text: /PR your-org\/api#160/ });
  expect(heading?.props.href).toBe("https://github.com/your-org/api/pull/160");
  const order = (await ui.findAll({ type: "Button" }))
    .map((el) => el.key)
    .filter((key): key is string => typeof key === "string" && key.startsWith("run-"));
  // Newest first: the lone audit run, then the chain newest first, the builder still under its lead.
  expect(order).toEqual(["run-solo", "run-fix1", "run-bld1", "run-rev1", "run-open1"]);
  expect((await ui.find({ key: "run-rev1" }))?.text).toContain("review → ");
  expect((await ui.find({ key: "run-fix1" }))?.text).toContain("mention → ");
  expect(await ui.find({ type: "Text", text: /check completed/ })).toBeDefined();

  await ui.press({ key: "run-rev1" });
  await clock.settle();
  expect(await ui.find({ type: "Text", text: /^Started by$/ })).toBeDefined();
  expect((await ui.find({ type: "Link", text: /your-org\/api#160/ }))?.props.href).toBe(
    "https://github.com/your-org/api/pull/160",
  );
  await ui.unmount();
});

test('the desktop ledger puts the newest run first: groups, "other" too, and the runs inside a group', async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const pr = { kind: "code_host", provider: "github", repository: "your-org/api", number: 160 };
  const opener = {
    ...runRow("open1", "succeeded", 600_000),
    agentName: "smoke",
    trigger: "manual",
    triggerInfo: { kind: "manual" },
    outcomes: [
      {
        kind: "pull_request",
        provider: "github",
        repository: "your-org/api",
        number: 160,
        url: "https://github.com/your-org/api/pull/160",
      },
    ],
  };
  const review = {
    ...runRow("rev1", "running", 400_000),
    agentName: "pr-reviewer",
    trigger: "host_event",
    triggerInfo: { ...pr, event: "review" },
    outcomes: [],
  };
  // (rev1 is running, so its group is open.) A manual run with no pull request, started last and still running: it belongs at the top.
  const solo = {
    ...runRow("solo", "running", 30_000),
    agentName: "coder",
    trigger: "manual",
    triggerInfo: { kind: "manual" },
    outcomes: [],
  };
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([opener, review, solo]);
    if (e.tool === "get_run") return reply({ id: e.args.runId, status: "succeeded" });
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  const groups = (await ui.findAll({ type: "Box" }))
    .map((el) => el.key)
    .filter((key): key is string => typeof key === "string" && key.startsWith("group-"));
  expect(groups[0]).toBe("group-other");
  const runs = (await ui.findAll({ type: "Markdown" }))
    .map((el) => el.key)
    .filter((key): key is string => typeof key === "string" && key.startsWith("run-"));
  expect(runs).toEqual(["run-solo", "run-rev1", "run-open1"]);
  await ui.unmount();
});

test("the desktop ledger groups runs by pull request, with totals, and a group collapses", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const pr = { kind: "code_host", provider: "github", repository: "your-org/api", number: 160 };
  const opener = {
    ...runRow("open1", "succeeded", 600_000),
    agentName: "smoke",
    costUsd: "0.16",
    triggerInfo: { kind: "manual" },
    outcomes: [
      {
        kind: "pull_request",
        provider: "github",
        repository: "your-org/api",
        number: 160,
        url: "https://github.com/your-org/api/pull/160",
      },
    ],
  };
  const review = {
    ...runRow("rev1", "succeeded", 400_000),
    agentName: "pr-reviewer",
    costUsd: "0.12",
    triggerInfo: { ...pr, event: "review" },
    outcomes: [],
  };
  const fix = {
    ...runRow("fix1", "running", 200_000),
    agentName: "delivery",
    costUsd: "0.04",
    taskOverride:
      "[This request is a follow-up on PR #160.]\nAutomatic fix round 1 of 2 for PR #160: the review requested changes.",
    triggerInfo: { ...pr, event: "mention" },
    outcomes: [],
  };
  const builder = {
    ...runRow("bld1", "running", 100_000),
    agentName: "builder",
    costUsd: "0.25",
    parentRunId: "fix1",
    triggerInfo: { kind: "subagent" },
    outcomes: [],
  };
  const lost = {
    ...runRow("lost1", "failed", 900_000),
    agentName: "smoke",
    costUsd: "0",
    triggerInfo: { kind: "manual" },
    outcomes: [],
  };
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([builder, fix, review, opener, lost]);
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  // The pull request's group: its link, state and total; then "Other" with the failed run.
  // One line per group: its name (the toggle), the pull request's ↗, its state; then its total.
  const head = (await ui.find({ key: "toggle-your-org/api#160" }))?.props.text as string;
  expect(head).toBe(
    "**[▼  api#160](https://wardby.invalid/group/your-org%2Fapi%23160)**  [↗](https://github.com/your-org/api/pull/160)  4 runs, fixing",
  );
  expect(await ui.find({ type: "Text", text: /^\$0\.57$/ })).toBeDefined();
  expect((await ui.find({ key: "toggle-other" }))?.props.text).toContain("1 run, failed");
  // Each line names its step: opened, review, fix 1, and the builder under its lead.
  expect((await ui.find({ key: "run-open1" }))?.props.text).toMatch(/^opened  \[smoke\]/);
  expect((await ui.find({ key: "run-rev1" }))?.props.text).toMatch(/^review  \[pr-reviewer\]/);
  expect((await ui.find({ key: "run-fix1" }))?.props.text).toMatch(/^fix 1  \[delivery\]/);
  expect((await ui.find({ key: "run-bld1" }))?.props.text).toMatch(/^└  \[builder\]/);

  // Collapse the pull request's group: its runs go, its row and total stay; then open it again.
  const key = "your-org/api#160";
  const toggle = { key: `toggle-${key}`, link: { href: `https://wardby.invalid/group/${encodeURIComponent(key)}` } };
  await ui.press(toggle);
  expect(await ui.find({ key: "run-rev1" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^\$0\.57$/ })).toBeDefined();
  await ui.press(toggle);
  expect(await ui.find({ key: "run-rev1" })).toBeDefined();
  // No Close button: the desktop pane has its own.
  expect(await ui.find({ key: "close" })).toBeUndefined();
  await ui.unmount();
});

test("Strips: a card per pull request with its steps drawn, the active step shown, and a step picked", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const pr = { kind: "code_host", provider: "github", repository: "your-org/api", number: 160 };
  const opener = {
    ...runRow("open1", "succeeded", 600_000),
    agentName: "smoke",
    triggerInfo: { kind: "manual" },
    outcomes: [
      {
        kind: "pull_request",
        provider: "github",
        repository: "your-org/api",
        number: 160,
        url: "https://github.com/your-org/api/pull/160",
      },
    ],
  };
  const review = {
    ...runRow("rev1", "succeeded", 400_000),
    agentName: "pr-reviewer",
    triggerInfo: { ...pr, event: "review" },
    outcomes: [],
  };
  const fix = {
    ...runRow("fix1", "running", 200_000),
    agentName: "delivery",
    taskOverride: "Automatic fix round 1 of 2 for PR #160: the review requested changes.",
    triggerInfo: { ...pr, event: "mention" },
    outcomes: [],
  };
  const builder = {
    ...runRow("bld1", "running", 100_000),
    agentName: "builder",
    parentRunId: "fix1",
    triggerInfo: { kind: "subagent" },
    outcomes: [],
  };
  const lone = {
    ...runRow("lone1", "failed", 900_000),
    agentName: "smoke",
    triggerInfo: { kind: "manual" },
    outcomes: [],
  };
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([builder, fix, review, opener, lone]);
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await ui.press({ key: "view-strips" });

  // A column per lead step, its drawing over its name: the builder is folded into its lead.
  // The card's colour bar is in its group's state colour; the steps follow it.
  expect((await ui.findAll({ type: "Svg" })).map((el) => el.props.alt)).toEqual([
    "running group",
    "opened succeeded",
    "review succeeded",
    "fix 1 running",
  ]);
  // The active step is the one shown, with its sub-agent run under it.
  expect(await ui.find({ type: "Text", text: /^Fix round 1 of 2$/ })).toBeDefined();
  expect((await ui.find({ key: "run-bld1" }))?.props.text).toContain("[builder]");
  // The step shown is in bold; pressing another step's name shows it instead.
  expect((await ui.find({ key: "step-link-fix1" }))?.props.text).toBe("**fix 1**");
  await ui.press({ key: "step-link-rev1", link: { href: "https://wardby.invalid/step/your-org%2Fapi%23160/rev1" } });
  expect(await ui.find({ type: "Text", text: /^Review$/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /^Fix round 1 of 2$/ })).toBeUndefined();
  // Runs that touch no pull request are listed under the cards.
  expect(await ui.find({ type: "Text", text: /Other runs/ })).toBeDefined();
  expect((await ui.find({ key: "run-lone1" }))?.props.text).toContain("failed");

  // And back to the ledger.
  await ui.press({ key: "view-ledger" });
  // The strips' step drawings are gone (the ledger draws only thin budget bars).
  expect((await ui.findAll({ type: "Svg" })).map((el) => el.props.alt)).not.toContain("fix 1 running");
  expect(await ui.find({ key: "toggle-your-org/api#160" })).toBeDefined();
  await ui.unmount();
});

test("the final text is drawn as markdown, about three lines until expanded", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const lines = Array.from({ length: 40 }, (_, i) => `- \`tests/test_${i}.py\`: updated the expected count`);
  const finalText = `## Summary\n\nAdded one new joke.\n\n${lines.join("\n")}`;
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([runRow("r1", "succeeded", 60_000)]);
    if (e.tool === "get_run") return reply({ id: "r1", status: "succeeded", finalText });
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  const cut = (await ui.find({ key: "final-text" }))?.props.text as string;
  expect(cut.startsWith("## Summary")).toBe(true);
  // About three lines: the heading, the sentence, and the first item cut at a word with an ellipsis.
  expect(cut.split("\n").filter((line) => line.trim() !== "")).toHaveLength(3);
  expect(cut).toMatch(/updated the expected…$/);
  expect(JSON.stringify(await ui.find({ key: "final-more" }))).toMatch(/… \d+ more lines/);
  await ui.press({ key: "expand" });
  expect((await ui.find({ key: "final-text" }))?.props.text).toBe(finalText);
  expect(await ui.find({ key: "final-more" })).toBeUndefined();
  await ui.unmount();
});

test("colour carries meaning: amber past 80% of budget, a red error, no key badges on the desktop", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const hungry = { ...runRow("h1", "failed", 60_000), costUsd: "0.85" };
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([hungry]);
    if (e.tool === "get_run")
      return reply({
        id: "h1",
        status: "failed",
        failureCategory: "worker_start",
        error: "coding_failure_executor:diag-1",
      });
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  // In the ledger, the spend of a run at 85% of its budget is amber.
  expect((await ui.find({ type: "Text", text: /^\$0\.85 of \$1\.00$/ }))?.props.color).toBe("warning");
  await openRun(ui, "desktop", "h1");
  await clock.settle();
  // The detail: the status as a pill, its word in the theme colour on a see-through tint (never a fixed
  // light fill, for dark mode); a dim line of how long it ran and when it finished; the error first.
  const chip = await ui.find({ type: "Text", text: /^ failed $/ });
  expect(chip?.props.color).toBe("error");
  expect(chip?.props.backgroundColor).toBe("#ef444429");
  expect(await ui.find({ type: "Text", text: /^1m 0s · finished 0s ago$/ })).toBeDefined();
  expect((await ui.find({ type: "Text", text: /^worker start$/ }))?.props.color).toBe("error");
  expect((await ui.find({ type: "Text", text: /\$0\.85 of \$1\.00/ }))?.props.color).toBe("warning");
  // Desktop buttons carry no key badges.
  expect((await ui.find({ key: "back" }))?.props.hotkey).toBeUndefined();
  await ui.unmount();
});

test("a one-run pull request is one line, and a finished one with several runs starts folded", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const at = (number: number) => ({
    kind: "code_host",
    provider: "github",
    repository: "your-org/web",
    number,
    event: "review",
  });
  const single = {
    ...runRow("s1", "succeeded", 50_000),
    agentName: "web-reviewer",
    triggerInfo: at(474),
    outcomes: [],
  };
  const doneA = {
    ...runRow("d1", "succeeded", 300_000),
    agentName: "web-reviewer",
    triggerInfo: at(473),
    outcomes: [],
  };
  const doneB = {
    ...runRow("d2", "succeeded", 200_000),
    agentName: "web-reviewer",
    triggerInfo: at(473),
    outcomes: [],
  };
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([single, doneB, doneA]);
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  // #474: no group row, the pull request beside the agent on the run's own line.
  expect(await ui.find({ key: "toggle-your-org/web#474" })).toBeUndefined();
  expect((await ui.find({ key: "run-s1" }))?.props.text).toBe(
    "review  [web-reviewer](https://wardby.invalid/run/s1)  [web#474 ↗](https://github.com/your-org/web/pull/474)",
  );
  // #473: finished, so folded until opened.
  expect((await ui.find({ key: "toggle-your-org/web#473" }))?.props.text).toContain("▶  web#473");
  expect(await ui.find({ key: "run-d1" })).toBeUndefined();
  await ui.press({
    key: "toggle-your-org/web#473",
    link: { href: `https://wardby.invalid/group/${encodeURIComponent("your-org/web#473")}` },
  });
  expect(await ui.find({ key: "run-d1" })).toBeDefined();
  await ui.unmount();
});

test("dark mode: nothing the pane draws uses a fixed light fill or a fixed hex text colour", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const pr = { kind: "code_host", provider: "github", repository: "your-org/api", number: 160 };
  const rows = [
    { ...runRow("a", "running", 60_000), triggerInfo: { ...pr, event: "mention" }, outcomes: [] },
    { ...runRow("b", "succeeded", 120_000), triggerInfo: { ...pr, event: "review" }, outcomes: [] },
    { ...runRow("c", "failed", 180_000), triggerInfo: { kind: "manual" }, outcomes: [] },
  ];
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply(rows);
    if (e.tool === "get_run") return reply({ id: "c", status: "failed", failureCategory: "worker_start", error: "x" });
    return reply({});
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  const check = async () => {
    for (const type of ["Box", "Text"]) {
      for (const el of await ui.findAll({ type })) {
        // A pill's tint is see-through (alpha under 25%), so it darkens with a dark panel: never a fixed fill.
        const bg = el.props.backgroundColor;
        if (bg !== undefined) expect(String(bg), `${type} ${el.text}`).toMatch(/^#[0-9a-f]{6}[0-3][0-9a-f]$/i);
        for (const prop of ["color", "borderColor"]) {
          const value = el.props[prop];
          if (typeof value === "string") expect(value.startsWith("#"), `${type} ${prop} ${value}`).toBe(false);
        }
      }
    }
  };
  await check();
  // The view and the filter are button bars, the choice in force the primary button.
  expect((await ui.find({ key: "view-ledger" }))?.props.variant).toBe("primary");
  expect((await ui.find({ key: "view-strips" }))?.props.variant).toBe("secondary");
  expect((await ui.find({ key: "status-all" }))?.props.variant).toBe("primary");
  await ui.press({ key: "status-failed" });
  expect((await ui.find({ key: "status-failed" }))?.props.variant).toBe("primary");
  await ui.press({ key: "status-all" });
  // Groups are panels with a see-through background (checked above) and a colour bar on top, not a border.
  const groups = (await ui.findAll({ type: "Box" })).filter(
    (el) => /^group-/.test(String(el.key ?? "")) && !String(el.key).endsWith("-bar"),
  );
  expect(groups.length).toBeGreaterThan(0);
  expect(groups.every((el) => el.props.borderStyle === undefined && el.props.backgroundColor !== undefined)).toBe(true);
  const groupBars = (await ui.findAll({ type: "Svg" })).filter((el) => String(el.props.alt).endsWith(" group"));
  expect(groupBars.map((el) => el.props.alt).sort()).toEqual(["failed group", "running group"]);
  await openRun(ui, "desktop", "c");
  await clock.settle();
  await check();
  await ui.press({ key: "back" });
  await ui.press({ key: "view-strips" });
  await check();
  await ui.unmount();
});

const lastStep = (seq: number, line: string) => ({
  seq,
  at: iso(1000),
  kind: "tool",
  tool: "Bash",
  summary: line,
  status: null,
  line,
});

test("list rows show the last step under the agent name for running and failed runs only", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const rows = [
    { ...runRow("a", "running", 60_000), lastStep: lastStep(3, "Bash: npm test") },
    { ...runRow("b", "failed", 120_000), lastStep: lastStep(9, "Edit: src/app.ts (error)") },
    { ...runRow("c", "succeeded", 180_000), lastStep: lastStep(4, "said: Finished: changes ready") },
    { ...runRow("e", "stopped", 300_000), lastStep: lastStep(2, "Bash: sleep 9") },
    { ...runRow("f", "budget_exhausted", 360_000), lastStep: lastStep(5, "Read: README.md") },
    // An older server, or a run without steps: no lastStep, nothing extra.
    runRow("d", "running", 240_000),
  ];
  on("mcp.call", (_, e) => ({
    value: { content: [{ type: "text", text: JSON.stringify(e.tool === "list_runs" ? rows : {}) }], isError: false },
  }));
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    // The test kit drops `key` on Text, so each key sits on a wrapping Box and the Text child is asserted.
    const a = await ui.find({ key: "last-a" });
    expect(a?.type).toBe("Box");
    expect(JSON.stringify(a)).toContain("Bash: npm test");
    expect(JSON.stringify(await ui.find({ key: "last-b" }))).toContain("Edit: src/app.ts (error)");
    expect(await ui.find({ key: "last-c" })).toBeUndefined();
    expect(await ui.find({ key: "last-d" })).toBeUndefined();
    expect(await ui.find({ key: "last-e" })).toBeUndefined();
    expect(await ui.find({ key: "last-f" })).toBeUndefined();
    await ui.unmount();
  }
});

/** A server with one run r1 whose steps are 1..state.last: Bash, ok except the newest (still running). */
function stepsServer(
  on: Parameters<Parameters<typeof test>[1]>[1],
  state: { status: string; last: number; steps?: "off" | "unknown" | "refused" | "empty" },
) {
  const stepCalls: Record<string, unknown>[] = [];
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    const fail = (text: string) => ({ value: { content: [{ type: "text", text }], isError: true } });
    const last = state.last > 0 ? lastStep(state.last, `Bash: step ${state.last}`) : undefined;
    if (e.tool === "list_runs")
      return reply([{ ...runRow("r1", state.status, 60_000), ...(last ? { lastStep: last } : {}) }]);
    if (e.tool === "get_run")
      return reply({
        id: "r1",
        status: state.status,
        codingResult: { outcome: "changes_ready" },
        ...(last ? { lastStep: last } : {}),
      });
    if (e.tool === "get_run_steps") {
      stepCalls.push(e.args);
      if (state.steps === "unknown") return fail("MCP error -32602: Tool get_run_steps not found");
      if (state.steps === "refused") return fail("Claude Code auto mode refused mcp__wardby__get_run_steps");
      if (state.steps === "off") return reply({ runId: "r1", level: "off", steps: [], next: null, dropped: 0 });
      if (state.steps === "empty") return reply({ runId: "r1", level: "summary", steps: [], next: null, dropped: 0 });
      const after = Number(e.args.after ?? 0);
      const limit = Number(e.args.limit ?? 50);
      const seqs = Array.from({ length: state.last }, (_, i) => i + 1).filter((s) => s > after);
      const page = seqs.slice(0, limit);
      return reply({
        runId: "r1",
        level: "summary",
        steps: page.map((seq) => ({
          seq,
          at: iso(1000),
          kind: "tool",
          tool: "Bash",
          summary: `step ${seq}`,
          status: seq === state.last && state.status === "running" ? null : seq % 10 === 0 ? "exit 1" : "ok",
        })),
        next: seqs.length > limit ? page[page.length - 1] : null,
        dropped: 0,
      });
    }
    return reply({});
  });
  return { stepCalls };
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: "Text" })).map((el) => el.text).join("\n");

test("a running run's detail shows its last 8 steps, read again each poll", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const state = { status: "running", last: 12 };
  const { stepCalls } = stepsServer(on, state);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  for (const surface of ["terminal", "desktop"] as const) {
    state.last = 12;
    stepCalls.length = 0;
    const ui = await $.ui.mount({ ...PANE, surface });
    await openRun(ui, surface, "r1");
    await clock.settle();
    expect(stepCalls[0]).toEqual({ runId: "r1", after: 4, limit: 200 });
    expect(await texts(ui)).toContain("Recent steps");
    expect(await ui.find({ key: "step-4" })).toBeUndefined();
    expect(JSON.stringify(await ui.find({ key: "step-5" }))).toContain("step 5");
    // The result is the row's gutter: the exit code "1", then the tool and "step 10".
    expect((await ui.find({ key: "step-10" }))?.text).toMatch(/^\s*1\s*(Bash:\s*)?step 10/);
    expect((await ui.find({ key: "step-12" }))?.type).toBe("Box");
    state.last = 14;
    await clock.advance(10_000);
    expect(stepCalls.at(-1)).toEqual({ runId: "r1", after: 6, limit: 200 });
    expect(await ui.find({ key: "step-6" })).toBeUndefined();
    expect(await ui.find({ key: "step-14" })).toBeDefined();
    await ui.press({ key: "back" });
    await ui.unmount();
  }
});

test("a finished run lists its steps 200 at a time, with More steps", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const { stepCalls } = stepsServer(on, { status: "succeeded", last: 205 });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  expect(stepCalls).toEqual([{ runId: "r1", after: 0, limit: 200 }]);
  expect(await texts(ui)).toMatch(/^Steps$/m);
  expect(await ui.find({ key: "step-1" })).toBeDefined();
  expect(await ui.find({ key: "step-200" })).toBeDefined();
  expect(await ui.find({ key: "step-201" })).toBeUndefined();
  await ui.press({ key: "more-steps" });
  await clock.settle();
  expect(stepCalls.at(-1)).toEqual({ runId: "r1", after: 200, limit: 200 });
  expect(await ui.find({ key: "step-205" })).toBeDefined();
  expect(await ui.find({ key: "more-steps" })).toBeUndefined();
  // A finished run's list is read once: polls don't ask again.
  await clock.advance(120_000);
  expect(stepCalls).toHaveLength(2);
  await ui.unmount();
});

test("a late steps reply for a run no longer open never replaces the open run's steps", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reply = (value: unknown) => ({
    value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
  });
  on("mcp.call", async (_, e) => {
    if (e.tool === "list_runs") return reply([runRow("rA", "succeeded", 60_000), runRow("rB", "succeeded", 70_000)]);
    if (e.tool === "get_run") return reply({ id: e.args.runId, status: "succeeded" });
    if (e.tool === "get_run_steps") {
      const id = String(e.args.runId);
      if (id === "rA") await gate;
      const step = { seq: 1, at: iso(1000), kind: "tool", tool: "Bash", summary: `only ${id}`, status: "ok" };
      return reply({ runId: id, level: "summary", steps: [step], next: null, dropped: 0 });
    }
    return reply({});
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "rA");
  await ui.press({ key: "back" });
  await openRun(ui, "terminal", "rB");
  await clock.settle();
  expect(await texts(ui)).toContain("Bash: only rB");
  release();
  await clock.settle();
  const shown = await texts(ui);
  expect(shown).toContain("Bash: only rB");
  expect(shown).not.toContain("only rA");
  await ui.unmount();
});

test("More steps pressed twice before the reply lists each step once", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const { stepCalls } = stepsServer(on, { status: "succeeded", last: 205 });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  await Promise.all([ui.press({ key: "more-steps" }), ui.press({ key: "more-steps" })]);
  await clock.settle();
  expect(stepCalls.filter((c) => c.after === 200)).toHaveLength(1);
  expect(await ui.findAll({ key: "step-201" })).toHaveLength(1);
  expect(await ui.findAll({ key: "step-205" })).toHaveLength(1);
  await ui.unmount();
});

test("a run that finishes while open turns Recent steps into Steps", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const state = { status: "running", last: 3 };
  const { stepCalls } = stepsServer(on, state);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  expect(await texts(ui)).toContain("Recent steps");
  state.status = "succeeded";
  await clock.advance(10_000);
  expect(stepCalls.at(-1)).toEqual({ runId: "r1", after: 0, limit: 200 });
  expect(await texts(ui)).toMatch(/^Steps$/m);
  await ui.unmount();
});

const offNotices = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: "Text" })).filter((el) => el.text === "Steps are off on this server.");

test("an older server without get_run_steps: no steps UI, no error, asked again every 6 polls", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const { stepCalls } = stepsServer(on, { status: "running", last: 5, steps: "unknown" });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  expect(stepCalls).toHaveLength(1);
  const shown = await texts(ui);
  expect(shown).not.toMatch(/steps/i);
  expect(shown).not.toMatch(/not found|wardby:/);
  expect(await ui.find({ key: "step-5" })).toBeUndefined();
  expect(await ui.find({ key: "steps-notice" })).toBeUndefined();
  // Polls keep refreshing the run but don't ask for steps...
  await clock.advance(50_000);
  expect(stepCalls).toHaveLength(1);
  // ...until the re-probe (every AGENTS_EVERY = 6 polls).
  await clock.advance(20_000);
  expect(stepCalls).toHaveLength(2);
  await ui.unmount();
});

test("an older server that gains get_run_steps shows the steps at the next re-probe", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const state = { status: "running", last: 5, steps: "unknown" as "unknown" | undefined };
  const { stepCalls } = stepsServer(on, state);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  expect(await texts(ui)).not.toMatch(/steps/i);
  state.steps = undefined;
  await clock.advance(50_000);
  expect(stepCalls).toHaveLength(1);
  expect(await texts(ui)).not.toMatch(/steps/i);
  await clock.advance(10_000);
  expect(stepCalls).toHaveLength(2);
  expect(await texts(ui)).toContain("Recent steps");
  expect(JSON.stringify(await ui.find({ key: "step-5" }))).toContain("Bash: step 5");
  await ui.unmount();
});

test("an older server without lastStep: list rows show nothing extra", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  fakeServer(on, { status: "running" });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await ui.find({ key: "last-r1" })).toBeUndefined();
    // The row itself is still drawn.
    expect(await ui.find({ key: "run-r1" })).toBeDefined();
    await ui.unmount();
  }
});

test("steps off on the server: one line, and no more calls until the re-probe", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const { stepCalls } = stepsServer(on, { status: "running", last: 0, steps: "off" });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  expect(await offNotices(ui)).toHaveLength(1);
  expect(await texts(ui)).not.toContain("Recent steps");
  await clock.advance(30_000);
  expect(stepCalls).toHaveLength(1);
  expect(await offNotices(ui)).toHaveLength(1);
  // The re-probe asks once more, and the notice is still shown once.
  await clock.advance(40_000);
  expect(stepCalls).toHaveLength(2);
  expect(await offNotices(ui)).toHaveLength(1);
  await ui.unmount();
});

test("an empty step list on a coding run shows nothing, running or finished", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const state = { status: "running", last: 0, steps: "empty" as const };
  stepsServer(on, state);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  expect(await texts(ui)).not.toMatch(/step/i);
  state.status = "succeeded";
  await clock.advance(10_000);
  expect(await texts(ui)).not.toMatch(/step/i);
  expect(await ui.find({ key: "steps-notice" })).toBeUndefined();
  expect(await ui.find({ key: "steps-off" })).toBeUndefined();
  await ui.unmount();
});

test("auto mode refusing get_run_steps alone shows which rule to add, not an error", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  stepsServer(on, { status: "running", last: 4, steps: "refused" });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  const notice = JSON.stringify(await ui.find({ key: "steps-notice" }));
  expect(notice).toContain("Allow mcp__wardby__get_run_steps in /permissions to see this run's steps.");
  const shown = await texts(ui);
  expect(shown).not.toMatch(/^wardby:/m);
  expect(shown).not.toContain("refused");
  expect(await ui.find({ key: "step-4" })).toBeUndefined();
  await ui.unmount();
});

test("a step summary is drawn as plain text: never markdown, never a link", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  stepsReply(on, "[click](https://example.invalid) **b**");
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  const row = await ui.find({ key: "step-1" });
  expect(row?.type).toBe("Box");
  // No pill: the summary as written.
  expect(row?.text).toContain("[click](https://example.invalid) **b**");
  expect(row?.text).not.toContain("said");
  expect(await ui.find({ type: "Link", text: /click/ })).toBeUndefined();
  expect((await ui.findAll({ type: "Markdown" })).some((el) => String(el.props.text).includes("example.invalid"))).toBe(
    false,
  );
  await ui.unmount();
});

test("a long said step wraps to about two rows, and its chevron shows every stored character", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const long = `${"alpha beta gamma delta ".repeat(40)}END-OF-SUMMARY`;
  stepsReply(on, long);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await openRun(ui, surface, "r1");
    await clock.settle();
    const cut = JSON.stringify(await ui.find({ key: "step-1" }));
    expect(cut).not.toContain("END-OF-SUMMARY");
    expect(cut).toContain("…");
    expect(cut).not.toContain("truncate");
    expect(cut).toContain('"wrap":"wrap"');
    await ui.press({ key: "step-detail-1" });
    const row = JSON.stringify(await ui.find({ key: "step-1" }));
    expect(row).toContain(long);
    expect(row).toContain('"wrap":"wrap"');
    await ui.press({ key: "back" });
    await ui.unmount();
  }
});

/** A server with one running run r1 and one `said` step whose summary is `summary`. */
function stepsReply(on: Parameters<Parameters<typeof test>[1]>[1], summary: string) {
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([runRow("r1", "running", 60_000)]);
    if (e.tool === "get_run") return reply({ id: "r1", status: "running", lastStep: lastStep(1, "x") });
    if (e.tool === "get_run_steps")
      return reply({
        level: "summary",
        steps: [{ seq: 1, at: iso(0), kind: "said", tool: null, summary, status: null }],
        next: null,
        dropped: 0,
      });
    return reply({});
  });
}

function detailServer(
  on: Parameters<Parameters<typeof test>[1]>[1],
  withDetail: boolean,
  details = ["npm test\n\n--- output (end) ---\nall [link](https://evil.invalid) passed", "ls"],
) {
  const reply = (value: unknown) => ({
    value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
  });
  on("mcp.call", (_, e) => {
    if (e.tool === "list_runs") return reply([runRow("r1", "succeeded", 60_000)]);
    if (e.tool === "get_run") return reply({ id: "r1", status: "succeeded" });
    if (e.tool === "get_run_steps") {
      const step = (seq: number, detail: string) => ({
        seq,
        at: iso(1000),
        kind: "tool",
        tool: "Bash",
        summary: `cmd ${seq}`,
        status: "ok",
        ...(withDetail ? { detail } : {}),
      });
      return reply({
        runId: "r1",
        level: withDetail ? "detail" : "summary",
        steps: details.map((detail, i) => step(i + 1, detail)),
        next: null,
        dropped: 0,
      });
    }
    return reply({});
  });
}

for (const surface of ["desktop", "terminal"] as const) {
  test(`${surface}: a step with detail expands to plain wrapped text`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW });
    engine(on, []);
    detailServer(on, true);
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await $.command.run({ command: "wardby-runs", args: "" });
    await clock.settle();
    const ui = await $.ui.mount({ ...PANE, surface });
    await openRun(ui, surface, "r1");
    await clock.settle();
    expect(await texts(ui)).not.toContain("all [link](https://evil.invalid) passed");
    await ui.press({ key: "step-detail-1" });
    const detailText = (await ui.findAll({ type: "Text" })).find((el) => el.text.includes("all [link]"));
    expect(detailText?.props.wrap).toBe("wrap");
    expect(await ui.findAll({ type: "Markdown" })).toHaveLength(0);
    expect(await ui.findAll({ type: "Link" })).toHaveLength(0);
    await ui.press({ key: "step-detail-1" });
    expect(await texts(ui)).not.toContain("passed");
    await ui.unmount();
  });
}

test("desktop: a shell step shows its command alone; another tool keeps its name", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const reply = (value: unknown) => ({
    value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
  });
  on("mcp.call", (_, e) => {
    if (e.tool === "list_runs") return reply([runRow("r1", "succeeded", 60_000)]);
    if (e.tool === "get_run") return reply({ id: "r1", status: "succeeded" });
    if (e.tool === "get_run_steps") {
      return reply({
        runId: "r1",
        level: "summary",
        steps: [
          { seq: 1, at: iso(1000), kind: "tool", tool: "Bash", summary: "ls -la", status: "ok" },
          { seq: 2, at: iso(1000), kind: "tool", tool: "Edit", summary: "src/app.ts", status: "ok" },
        ],
        next: null,
        dropped: 0,
      });
    }
    return reply({});
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  const shell = (await ui.find({ key: "step-1" }))?.text ?? "";
  expect(shell).toContain("ls -la");
  expect(shell).not.toContain("Bash");
  expect((await ui.find({ key: "step-2" }))?.text).toMatch(/Edit\s*src\/app\.ts/);
  await ui.unmount();
});

test("desktop: no Show detail button, and the row's one chevron opens and closes the step", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  detailServer(on, true);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  expect(await ui.find({ key: "step-toggle-button-1" })).toBeUndefined();
  const buttons = (await ui.findAll({ type: "Button" })).filter((el) => /show detail|hide detail/i.test(el.text));
  expect(buttons).toHaveLength(0);
  // The row itself is a Box, not a Button; its only control is a one-glyph plain chevron.
  const row = (await ui.find({ key: "step-row-1" })) as unknown as { type: string };
  expect(row.type).toBe("Box");
  // It tints under the pointer: a see-through wash, so it suits light and dark (find leaves hover out; the tree has it).
  const tree = JSON.stringify((await ui.findAll({ type: "Box" }))[0]);
  expect(tree).toMatch(/"key":"step-row-1"[^}]*\},"hover":\{"backgroundColor":"#[0-9a-f]{6}[0-3][0-9a-f]"\}/);
  const inRow = JSON.stringify(row);
  expect(inRow.match(/"type":"Button"/g)).toHaveLength(1);
  const chevron = await ui.find({ key: "step-detail-1" });
  expect(chevron?.props.plain).toBe(true);
  expect(chevron?.props.label).toBe("▸");
  await ui.press({ key: "step-detail-1" });
  expect(await texts(ui)).toContain("all [link](https://evil.invalid) passed");
  expect((await ui.find({ key: "step-detail-1" }))?.props.label).toBe("▾");
  await ui.press({ key: "step-detail-1" });
  expect(await texts(ui)).not.toContain("passed");
  expect((await ui.find({ key: "step-detail-1" }))?.props.label).toBe("▸");
  await ui.unmount();
});

test("terminal: no per-step detail buttons, the j/k/e row instead", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  detailServer(on, true);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  expect(await ui.find({ key: "step-toggle-button-1" })).toBeUndefined();
  expect(await ui.find({ key: "step-open" })).toBeDefined();
  await ui.unmount();
});

test("terminal: j and k move between steps with detail, e opens one", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  detailServer(on, true);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  expect((await ui.find({ key: "step-next" }))?.props.hotkey).toBe("j");
  await ui.press({ key: "step-next" });
  await ui.press({ key: "step-open" });
  expect(await texts(ui)).toContain("--- output (end) ---");
  await ui.press({ key: "step-next" });
  expect(await texts(ui)).not.toContain("--- output (end) ---");
  expect(await texts(ui)).toMatch(/^ls$/m);
  await ui.unmount();
});

test("an older server (no detail in steps): no expand controls", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  detailServer(on, false);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  expect(await texts(ui)).toContain("Bash: cmd 1");
  expect(await ui.find({ key: "step-detail-1" })).toBeUndefined();
  expect(await ui.find({ key: "step-next" })).toBeUndefined();
  await ui.unmount();
});

test("an empty detail is no detail: no expand control for that step", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  detailServer(on, true, ["", "ls"]);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  expect(await ui.find({ key: "step-detail-1" })).toBeUndefined();
  expect(await ui.find({ key: "step-detail-2" })).toBeDefined();
  expect(await texts(ui)).toContain("Bash: cmd 1");
  expect(await texts(ui)).not.toMatch(/cmd 1.*▸/);
  await ui.unmount();
});

for (const surface of ["desktop", "terminal"] as const) {
  test(`${surface}: a long detail shows its last 40 lines, wrapped, under a count of the rest`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW });
    engine(on, []);
    const lines = Array.from({ length: 100 }, (_, i) => `output line ${i + 1}`);
    detailServer(on, true, [lines.join("\n"), "ls"]);
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await $.command.run({ command: "wardby-runs", args: "" });
    await clock.settle();
    const ui = await $.ui.mount({ ...PANE, surface });
    await openRun(ui, surface, "r1");
    await clock.settle();
    await ui.press({ key: "step-detail-1" });
    const shown = await texts(ui);
    expect(shown).toContain("… 60 more lines");
    expect(shown).not.toMatch(/^output line 60$/m);
    expect(shown).toMatch(/^output line 61$/m);
    expect(shown).toMatch(/^output line 100$/m);
    const detailText = (await ui.findAll({ type: "Text" })).find((el) => el.text.startsWith("output line 61"));
    expect(detailText?.props.wrap).toBe("wrap");
    await ui.unmount();
  });
}

test("a step stored by an older server with escape sequences is drawn without them", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  // Fake content: an OSC 8 link and colour codes in the summary, an OSC 52 clipboard write in the detail.
  const esc = "\u001b";
  const reply = (value: unknown) => ({
    value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
  });
  on("mcp.call", (_, e) => {
    if (e.tool === "list_runs") return reply([runRow("r1", "succeeded", 60_000)]);
    if (e.tool === "get_run") return reply({ id: "r1", status: "succeeded" });
    if (e.tool === "get_run_steps")
      return reply({
        runId: "r1",
        level: "detail",
        steps: [
          {
            seq: 1,
            at: iso(1000),
            kind: "tool",
            tool: "Bash",
            summary: `${esc}]8;;https://evil.invalid\u0007npm${esc}]8;;\u0007 ${esc}[1mtest${esc}[0m`,
            status: "ok",
            detail: `npm test\n\n--- output (end) ---\n${esc}]52;c;ZmFrZQ==\u0007${esc}[31mfailed${esc}[0m\r\n`,
          },
        ],
        next: null,
        dropped: 0,
      });
    return reply({});
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  await ui.press({ key: "step-detail-1" });
  const shown = await texts(ui);
  expect(shown).toContain("Bash: npm test");
  expect(shown).toContain("--- output (end) ---\nfailed");
  expect(shown).not.toContain(esc);
  expect(shown).not.toContain("\r");
  expect(shown).not.toContain("evil.invalid");
  expect(shown).not.toContain("ZmFrZQ");
  await ui.unmount();
});

/** A server with one finished run r1 that has every section: request, outcomes, services, steps, final text. */
function fullServer(
  on: Parameters<Parameters<typeof test>[1]>[1],
  extra: { request?: string; finalText?: string; error?: string; status?: string } = {},
) {
  const reply = (value: unknown) => ({
    value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
  });
  const status = extra.status ?? "succeeded";
  on("mcp.call", (_, e) => {
    if (e.tool === "list_runs")
      return reply([
        {
          ...runRow("r1", status, 60_000),
          costUsd: "0.21",
          outcomes: [
            {
              kind: "pull_request",
              provider: "github",
              repository: "your-org/api",
              number: 9,
              url: "https://github.com/your-org/api/pull/9",
            },
          ],
        },
        { ...runRow("k1", "succeeded", 30_000), agentName: "helper", parentRunId: "r1", trigger: "subagent" },
      ]);
    if (e.tool === "get_run")
      return reply({
        id: "r1",
        status,
        request: extra.request ?? "Rename the accounts API.",
        finalText: extra.finalText ?? "Done.",
        ...(extra.error ? { error: extra.error, failureCategory: "worker_start" } : {}),
        pricingSnapshot: { modelId: "test-model-1" },
        codingResult: {
          outcome: "pull_request_opened",
          repository: "your-org/api",
          pullRequestUrl: "https://github.com/your-org/api/pull/9",
        },
        services: ["postgres 16"],
        serviceReadiness: [{ name: "postgres", state: "ready", attempts: 1 }],
      });
    if (e.tool === "get_run_steps")
      return reply({
        runId: "r1",
        level: "detail",
        steps: [
          {
            seq: 1,
            at: iso(1000),
            kind: "tool",
            tool: "Bash",
            summary: "npm test",
            status: "ok",
            detail: "npm test\n--- output (end) ---\nall passed",
          },
        ],
        next: null,
        dropped: 0,
      });
    return reply({});
  });
}

/** Opens fullServer's r1: on the desktop its finished pull request's group starts folded, so unfold it first. */
async function openFull(
  ui: { press: (t: { key: string; link?: { href: string } }) => Promise<unknown> },
  surface: "desktop" | "terminal",
) {
  if (surface === "desktop") {
    const key = "your-org/api#9";
    await ui.press({ key: `toggle-${key}`, link: { href: `https://wardby.invalid/group/${encodeURIComponent(key)}` } });
  }
  await openRun(ui, surface, "r1");
}

test("pills: a soft tint and the theme colour on the desktop, coloured text on the terminal", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  fullServer(on);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  for (const surface of ["desktop", "terminal"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await openFull(ui, surface);
    await clock.settle();
    const status = await ui.find({ type: "Text", text: surface === "desktop" ? /^ succeeded $/ : /^✓ succeeded$/ });
    expect(status?.props.color).toBe("success");
    const words = surface === "desktop" ? [" PR ", " ready ", " detail "] : ["[PR]", "[ready]", "[detail]"];
    for (const word of words) {
      const el = (await ui.findAll({ type: "Text" })).find((t) => t.text === word);
      expect(el, word).toBeDefined();
      if (surface === "desktop") expect(String(el?.props.backgroundColor)).toMatch(/^#[0-9a-f]{8}$/);
      else expect(el?.props.backgroundColor).toBeUndefined();
    }
    // The header: the short run id, and a dim line with the repository and model.
    expect(await ui.find({ type: "Text", text: /^your-org\/api · test-model-1 · / })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /^\$0\.21 of \$1\.00 budget$/ })).toBeDefined();
    expect(await ui.find({ type: "Text", text: /^turn 1$/ })).toBeDefined();
    await ui.press({ key: "back" });
    await ui.unmount();
  }
});

test("the terminal never gets a tint, an SVG or a hex colour", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  fullServer(on, { error: "boom" });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  const check = async () => {
    expect(await ui.findAll({ type: "Svg" })).toHaveLength(0);
    for (const type of ["Box", "Text"]) {
      for (const el of await ui.findAll({ type })) {
        expect(el.props.backgroundColor, `${type} ${el.text}`).toBeUndefined();
        const color = el.props.color;
        if (typeof color === "string") expect(color.startsWith("#"), `${type} ${color}`).toBe(false);
      }
    }
  };
  await check();
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  await ui.press({ key: "step-detail-1" });
  await check();
  // Pills are words in brackets on the terminal, coloured but never tinted.
  for (const word of ["[PR]", "[ready]", "[detail]"]) {
    expect(
      (await ui.findAll({ type: "Text" })).some((t) => t.text === word),
      word,
    ).toBe(true);
  }
  // The budget is a text bar on the terminal.
  expect(await texts(ui)).toMatch(/[▓░]{10,}/);
  await ui.unmount();
});

for (const surface of ["desktop", "terminal"] as const) {
  test(`${surface}: a long request and final answer show about three lines and how many more`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW });
    engine(on, []);
    const many = (word: string) => Array.from({ length: 10 }, (_, i) => `${word} line ${i + 1}`).join("\n");
    fullServer(on, { request: many("request"), finalText: many("answer") });
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await $.command.run({ command: "wardby-runs", args: "" });
    await clock.settle();
    const ui = await $.ui.mount({ ...PANE, surface });
    await openFull(ui, surface);
    await clock.settle();
    const suffix = surface === "desktop" ? "" : " (m)";
    for (const [key, word] of [
      ["request", "request"],
      ["final", "answer"],
    ]) {
      expect((await ui.find({ key: `${key}-text` }))?.props.text).toBe(
        `${word} line 1\n${word} line 2\n${word} line 3`,
      );
      expect((await ui.find({ key: `${key}-more` }))?.text).toBe(`… 7 more lines${suffix}`);
    }
    await ui.press({ key: "expand" });
    expect((await ui.find({ key: "request-text" }))?.props.text).toBe(many("request"));
    expect(await ui.find({ key: "request-more" })).toBeUndefined();
    await ui.unmount();
  });
}

test("the action row comes last: the pull request first, then Show full text and Copy run id", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  fullServer(on, { request: Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n") });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  for (const surface of ["desktop", "terminal"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await openFull(ui, surface);
    await clock.settle();
    const row = (await ui.find({ key: "actions" })) as unknown as {
      children: { type: string; props: { key?: string; label?: string } }[];
    };
    expect(row.children.map((c) => (c.type === "Link" ? `Link:${c.props.label}` : c.props.key))).toEqual([
      "Link:Open pull request #9",
      "expand",
      "copy-id",
    ]);
    // The action row is the detail's last element: after every card.
    const tree = JSON.stringify((await ui.findAll({ type: "Box" }))[0]);
    expect(tree.lastIndexOf('"key":"actions"')).toBeGreaterThan(tree.lastIndexOf('"key":"final-card"'));
    await ui.press({ key: "back" });
    await ui.unmount();
  }
});

test("list rows show the spend as $x of $y at the right, and the desktop a thin budget bar", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  fakeServer(on, { status: "running" });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await ui.find({ type: "Text", text: /^ ?\$0\.21 of \$1\.00$/ })).toBeDefined();
    const bars = (await ui.findAll({ type: "Svg" }))
      .map((el) => el.props.alt)
      .filter((alt) => !String(alt).endsWith(" group"));
    expect(bars).toEqual(surface === "desktop" ? ["$0.21 of $1.00 budget"] : []);
    await ui.unmount();
  }
});

test("desktop: each section's Copy button copies its full, uncut text and says so", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  const toasts: string[] = [];
  engine(on, toasts);
  const request = Array.from({ length: 12 }, (_, i) => `request line ${i + 1}`).join("\n");
  const finalText = Array.from({ length: 12 }, (_, i) => `answer line ${i + 1}`).join("\n");
  fullServer(on, { request, finalText, error: "the worker could not start", status: "failed" });
  const copies: string[] = [];
  let isCopied = true;
  on("ui.copy", (_, e) => {
    copies.push(String(e.text));
    return { value: isCopied ? { isCopied: true } : { isCopied: false, reason: "no clipboard" } };
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  for (const key of ["copy-started", "copy-produced", "copy-tree", "copy-final", "copy-error"]) {
    expect((await ui.find({ key }))?.props.label, key).toBe("Copy");
  }
  await ui.press({ key: "copy-started" });
  expect(copies.at(-1)).toBe(request);
  expect(toasts.at(-1)).toBe("Copied");
  await ui.press({ key: "copy-final" });
  expect(copies.at(-1)).toBe(finalText);
  await ui.press({ key: "copy-produced" });
  expect(copies.at(-1)).toBe("opened PR #9 https://github.com/your-org/api/pull/9");
  await ui.press({ key: "copy-tree" });
  expect(copies.at(-1)).toBe("builder failed r1 $0.21\n  helper succeeded k1 $0.01");
  await ui.press({ key: "copy-error" });
  expect(copies.at(-1)).toBe("the worker could not start");
  // An open step's detail: Copy in its header, the detail as stored.
  expect(await ui.find({ key: "copy-step-1" })).toBeUndefined();
  await ui.press({ key: "step-detail-1" });
  await ui.press({ key: "copy-step-1" });
  expect(copies.at(-1)).toBe("npm test\n--- output (end) ---\nall passed");
  isCopied = false;
  await ui.press({ key: "copy-final" });
  expect(toasts.at(-1)).toBe("Couldn't copy");
  await ui.unmount();
});

test("terminal: one Copy section key (y) copies the open step's detail", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  const toasts: string[] = [];
  engine(on, toasts);
  fullServer(on);
  const copies: string[] = [];
  on("ui.copy", (_, e) => {
    copies.push(String(e.text));
    return { value: { isCopied: true } };
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  // No per-card copy buttons on the terminal, and nothing to copy until a step is open.
  expect(await ui.find({ key: "copy-final" })).toBeUndefined();
  expect(await ui.find({ key: "copy-section" })).toBeUndefined();
  await ui.press({ key: "step-open" });
  expect((await ui.find({ key: "copy-section" }))?.props.hotkey).toBe("y");
  await ui.press({ key: "copy-section" });
  expect(copies).toEqual(["npm test\n--- output (end) ---\nall passed"]);
  expect(toasts.at(-1)).toBe("Copied");
  await ui.unmount();
});

/** Codex-shaped steps: ls -la (exit 0), git log (exit 128) and a long said step, each with detail. */
const CODEX_LS =
  '{"cmd":"ls -la","workdir":"/workspace"}\n\n--- output (end) ---\n' +
  "Chunk ID: 0a1b2c\nWall time: 0.0 seconds\nProcess exited with code 0\nOriginal token count: 12\nOutput:\n" +
  "total 53\nREADME.md\npyproject.toml\n";
const CODEX_GIT =
  '{"cmd":["bash","-lc","git log --oneline -10"]}\n\n--- output (end) ---\n' +
  "Chunk ID: 0a1b2d\nWall time: 0.0 seconds\nProcess exited with code 128\nOriginal token count: 9\nOutput:\n" +
  "fatal: not a git repository\n";
const SAID = `The package is named knock-knock-jokes. ${"It has a small command-line joke system. ".repeat(12)}LAST-WORDS`;

function codexServer(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const reply = (value: unknown) => ({
    value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
  });
  on("mcp.call", (_, e) => {
    if (e.tool === "list_runs") return reply([runRow("r1", "succeeded", 60_000)]);
    if (e.tool === "get_run") return reply({ id: "r1", status: "succeeded" });
    if (e.tool === "get_run_steps")
      return reply({
        runId: "r1",
        level: "detail",
        steps: [
          { seq: 1, at: iso(3000), kind: "tool", tool: "Bash", summary: "ls -la", status: "ok", detail: CODEX_LS },
          {
            seq: 2,
            at: iso(2000),
            kind: "tool",
            tool: "Bash",
            summary: "git log --oneline -10",
            status: "exit 128",
            detail: CODEX_GIT,
          },
          { seq: 3, at: iso(1000), kind: "said", tool: null, summary: SAID, status: null, detail: SAID },
        ],
        next: null,
        dropped: 0,
      });
    return reply({});
  });
}

for (const surface of ["desktop", "terminal"] as const) {
  test(`${surface}: an open step shows "$ command", its exit status and the output without Codex's framing`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW });
    engine(on, []);
    codexServer(on);
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await $.command.run({ command: "wardby-runs", args: "" });
    await clock.settle();
    const ui = await $.ui.mount({ ...PANE, surface });
    await openRun(ui, surface, "r1");
    await clock.settle();
    await ui.press({ key: "step-detail-1" });
    const shown = await texts(ui);
    expect(shown).toMatch(/^\$ ls -la$/m);
    expect(shown).toMatch(/^exit 0$/m);
    expect(shown).toContain("total 53\nREADME.md\npyproject.toml");
    for (const framing of ["Chunk ID", "Wall time", "Process exited", "Original token count", "Output:", "workdir"]) {
      expect(shown, framing).not.toContain(framing);
    }
    // A shell's -lc argv reads as its script; the exit code comes from the output's framing.
    await ui.press({ key: "step-detail-2" });
    const failed = await texts(ui);
    expect(failed).toMatch(/^\$ git log --oneline -10$/m);
    expect(failed).toMatch(/^exit 128$/m);
    expect(failed).toContain("fatal: not a git repository");
    expect(failed).not.toContain("total 53");
    await ui.unmount();
  });
}

test("desktop: an open step's Copy copies the full stored detail, framing and all", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  codexServer(on);
  const copies: string[] = [];
  on("ui.copy", (_, e) => {
    copies.push(String(e.text));
    return { value: { isCopied: true } };
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  await ui.press({ key: "step-detail-1" });
  // The panel shows the output without Codex's framing, but Copy copies the detail as stored.
  expect(await texts(ui)).not.toContain("Chunk ID");
  await ui.press({ key: "copy-step-1" });
  expect(copies).toEqual([CODEX_LS]);
  expect(copies[0]).toContain("Chunk ID: 0a1b2c");
  await ui.unmount();
});

for (const surface of ["desktop", "terminal"] as const) {
  test(`${surface}: a failed step's gutter shows its exit code, a passed one ✓, and no pill`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW });
    engine(on, []);
    codexServer(on);
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await $.command.run({ command: "wardby-runs", args: "" });
    await clock.settle();
    const ui = await $.ui.mount({ ...PANE, surface });
    await openRun(ui, surface, "r1");
    await clock.settle();
    const failedMark = JSON.stringify(await ui.find({ key: "step-mark-2" }));
    expect(failedMark).toContain("128");
    expect(failedMark).not.toContain("exit");
    expect(JSON.stringify(await ui.find({ key: "step-mark-1" }))).toContain("✓");
    expect((await ui.find({ key: "step-2" }))?.text).not.toMatch(/\[exit 128\]| exit 128 /);
    if (surface === "desktop") {
      const code = (await ui.findAll({ type: "Text" })).find((el) => el.text.trim() === "128");
      expect(code?.props.color).toBe("#e33d37");
      expect(String(code?.props.backgroundColor)).toMatch(/^#e33d37[0-3][0-9a-f]$/);
      const ok = (await ui.findAll({ type: "Text" })).find((el) => el.text === "✓");
      expect(ok?.props.color).toBe("#15b982");
    }
    await ui.unmount();
  });
}

test("desktop: a said row is not a Button, is cut to about two rows, and never runs off the edge", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  codexServer(on);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  const row = (await ui.find({ key: "step-row-3" })) as unknown as { type: string };
  expect(row.type).toBe("Box");
  // Its one Button is the chevron.
  expect(JSON.stringify(row).match(/"type":"Button"/g)).toHaveLength(1);
  const said = (await ui.findAll({ type: "Text" })).find((el) => el.text.startsWith("The package is named"));
  expect(said?.props.wrap).toBe("wrap");
  expect(said?.text.endsWith("…")).toBe(true);
  expect(said?.text).not.toContain("LAST-WORDS");
  // About two rows of the pane's room (48 columns less the card, gutter and chevron).
  expect(said?.text.length).toBeLessThanOrEqual(2 * 48);
  // The quiet rule on its left: a narrow tinted column, not a border.
  expect(await ui.find({ key: "step-rule-3" })).toBeDefined();
  await ui.press({ key: "step-detail-3" });
  const full = (await ui.findAll({ type: "Text" })).find((el) => el.text.startsWith("The package is named"));
  expect(full?.text).toContain("LAST-WORDS");
  await ui.unmount();
});

/** Every detail card fullServer's failed r1 draws, with its colour. */
const CARD_COLORS: Record<string, string> = {
  "error-card": "#e33d37",
  "started-card": "#75d4ff",
  "produced-card": "#15b982",
  "tree-card": "#3d6aa3",
  "services-card": "#c9aa70",
  "steps-card": "#657287",
  "final-card": "#3d6aa3",
  "continue-card": "#657287",
};

test("desktop: every detail card opens with a colour bar in its kind's wardby colour", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  fullServer(on, { error: "boom", status: "failed" });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  for (const [key, color] of Object.entries(CARD_COLORS)) {
    const card = (await ui.find({ key })) as unknown as {
      props: Record<string, unknown>;
      children: { props: { key?: string } }[];
    };
    expect(card, key).toBeDefined();
    // A borderless panel, so the bar sits flush on its top edge (a border's inset left a gap above it).
    expect(card.props.borderStyle, key).toBeUndefined();
    expect(card.props.backgroundColor, key).toBeDefined();
    // The bar is the card's first child: a 3 px SVG strip in the card's colour.
    expect(card.children[0].props.key, key).toBe(`${key}-bar`);
    const bar = JSON.stringify(await ui.find({ key: `${key}-bar` }));
    expect(bar, key).toContain('"type":"Svg"');
    expect(bar, key).toContain(`stroke=\\"${color}\\"`);
    // Round ends that stay round however wide the card: a round-capped stroke that does not scale.
    expect(bar, key).toContain('stroke-linecap=\\"round\\"');
    expect(bar, key).toContain("non-scaling-stroke");
    expect(bar, key).toContain('"height":3');
    // A surface draws an Svg only with alt text: an empty alt left a blank gap where the bar belongs.
    expect(bar, key).toMatch(/"alt":"[^"]+"/);
  }
  await ui.unmount();
});

test("terminal: every detail card's rounded border is in its kind's colour, and no SVG", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  fullServer(on, { error: "boom", status: "failed" });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  for (const [key, color] of Object.entries(CARD_COLORS)) {
    const card = await ui.find({ key });
    expect(card, key).toBeDefined();
    expect(card?.props.borderStyle, key).toBe("round");
    expect(card?.props.borderColor, key).toBe(color);
    expect(await ui.find({ key: `${key}-bar` }), key).toBeUndefined();
  }
  expect(await ui.findAll({ type: "Svg" })).toHaveLength(0);
  await ui.unmount();
});

/**
 * A server that sends long fields as a first page (one with get_run_text): get_run with <field>More, and
 * get_run_text in pieces of `piece` characters. `text: "unknown"` is an older server without get_run_text.
 */
function pagedTextServer(
  on: Parameters<Parameters<typeof test>[1]>[1],
  full: { request: string; finalText: string; error: string; taskOverride?: string },
  opts: { text?: "yes" | "unknown" | "refused"; piece?: number; first?: number } = {},
) {
  const first = opts.first ?? 8000;
  const piece = opts.piece ?? 32000;
  const textCalls: { field: string; offset: number }[] = [];
  const reply = (value: unknown) => ({
    value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
  });
  const fail = (text: string) => ({ value: { content: [{ type: "text", text }], isError: true } });
  const page = (field: string, text: string) =>
    text.length > first
      ? { [field]: text.slice(0, first), [`${field}More`]: { next: first, total: text.length } }
      : { [field]: text };
  on("mcp.call", (_, e) => {
    if (e.tool === "list_runs")
      return reply([{ ...runRow("r1", "failed", 60_000), taskOverride: full.taskOverride ?? null }]);
    if (e.tool === "get_run")
      return reply({
        id: "r1",
        status: "failed",
        ...page("request", full.request),
        ...page("finalText", full.finalText),
        ...page("error", full.error),
        ...(full.taskOverride ? page("taskOverride", full.taskOverride) : {}),
      });
    if (e.tool === "get_run_text") {
      if (opts.text === "unknown") return fail("MCP error -32602: Tool get_run_text not found");
      if (opts.text === "refused") return fail("Claude Code auto mode refused mcp__wardby__get_run_text");
      const field = String(e.args.field) as keyof typeof full;
      const offset = Number(e.args.offset ?? 0);
      textCalls.push({ field, offset });
      const text = full[field] ?? "";
      const end = Math.min(text.length, offset + piece);
      return reply({
        runId: "r1",
        field,
        offset,
        text: text.slice(offset, end),
        next: end < text.length ? end : null,
        total: text.length,
      });
    }
    if (e.tool === "get_run_steps") return reply({ runId: "r1", level: "summary", steps: [], next: null, dropped: 0 });
    return reply({});
  });
  return textCalls;
}

const longText = (label: string, n: number) =>
  Array.from(
    { length: Math.ceil(n / 50) },
    (_, i) => `${label} line ${String(i).padStart(5, "0")} `.padEnd(49, ".") + "\n",
  )
    .join("")
    .slice(0, n);

test("Show full text reads the rest of a long request, final answer and error, piece by piece", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const full = {
    request: longText("request", 40_000),
    finalText: longText("answer", 20_000),
    error: longText("error", 9_000),
  };
  const textCalls = pagedTextServer(on, full, { piece: 15_000 });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  // Only get_run's first pages until asked; the error says there is more.
  expect(textCalls).toEqual([]);
  expect(JSON.stringify(await ui.find({ key: "error-more" }))).toContain("1000 more characters");
  expect((await ui.find({ key: "expand" }))?.props.hotkey).toBe("m");
  await ui.press({ key: "expand" });
  await clock.settle();
  expect(textCalls).toEqual([
    { field: "request", offset: 8000 },
    { field: "request", offset: 23_000 },
    { field: "request", offset: 38_000 },
    { field: "finalText", offset: 8000 },
    { field: "error", offset: 8000 },
  ]);
  expect((await ui.find({ key: "request-text" }))?.props.text).toBe(full.request);
  expect((await ui.find({ key: "final-text" }))?.props.text).toBe(full.finalText);
  expect(JSON.stringify(await ui.find({ type: "Text", text: /^error line 00000/ }))).toContain("error line 00179");
  expect(await ui.find({ key: "error-more" })).toBeUndefined();
  // Collapsing and expanding again reads nothing more.
  await ui.press({ key: "expand" });
  await ui.press({ key: "expand" });
  await clock.settle();
  expect(textCalls).toHaveLength(5);
  await ui.unmount();
});

test("desktop: Copy on a long field reads the rest first and copies the whole text", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  const toasts: string[] = [];
  engine(on, toasts);
  const full = {
    request: longText("request", 12_000),
    finalText: longText("answer", 30_000),
    error: longText("error", 8_500),
  };
  const textCalls = pagedTextServer(on, full);
  const copies: string[] = [];
  on("ui.copy", (_, e) => {
    copies.push(String(e.text));
    return { value: { isCopied: true } };
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  await ui.press({ key: "copy-final" });
  await clock.settle();
  expect(copies.at(-1)).toBe(full.finalText);
  expect(toasts.at(-1)).toBe("Copied");
  // One call read every field the server cut; a second Copy reads nothing more.
  expect(textCalls.map((c) => c.field)).toEqual(["request", "finalText", "error"]);
  await ui.press({ key: "copy-started" });
  await clock.settle();
  expect(copies.at(-1)).toBe(full.request);
  await ui.press({ key: "copy-error" });
  await clock.settle();
  expect(copies.at(-1)).toBe(full.error);
  expect(textCalls).toHaveLength(3);
  await ui.unmount();
});

test("desktop: a long task without a request: Copy reads the rest of taskOverride", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const taskOverride = longText("task", 10_000);
  const textCalls = pagedTextServer(on, { request: "", finalText: "Done.", error: "", taskOverride });
  const copies: string[] = [];
  on("ui.copy", (_, e) => {
    copies.push(String(e.text));
    return { value: { isCopied: true } };
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  await ui.press({ key: "copy-started" });
  await clock.settle();
  expect(textCalls).toEqual([{ field: "taskOverride", offset: 8000 }]);
  expect(copies.at(-1)).toBe(taskOverride);
  await ui.unmount();
});

test("an older server without get_run_text: Show full text and Copy keep the first page, with no error", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  const toasts: string[] = [];
  engine(on, toasts);
  const full = { request: longText("request", 9_000), finalText: longText("answer", 9_000), error: "short" };
  pagedTextServer(on, full, { text: "unknown" });
  const copies: string[] = [];
  on("ui.copy", (_, e) => {
    copies.push(String(e.text));
    return { value: { isCopied: true } };
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  await ui.press({ key: "expand" });
  await clock.settle();
  expect((await ui.find({ key: "final-text" }))?.props.text).toBe(full.finalText.slice(0, 8000));
  await ui.press({ key: "copy-final" });
  await clock.settle();
  expect(copies.at(-1)).toBe(full.finalText.slice(0, 8000));
  expect(toasts.at(-1)).toBe("Copied");
  // No error line in the pane.
  expect(await ui.find({ type: "Text", text: /^wardby: / })).toBeUndefined();
  await ui.unmount();
});

test("auto mode refusing get_run_text: the first page stays, and a toast names the rule to allow", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  const toasts: string[] = [];
  engine(on, toasts);
  const full = { request: "Short.", finalText: longText("answer", 9_000), error: "" };
  pagedTextServer(on, full, { text: "refused" });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await openRun(ui, "terminal", "r1");
  await clock.settle();
  await ui.press({ key: "expand" });
  await clock.settle();
  expect(toasts.at(-1)).toBe("Allow mcp__wardby__get_run_text in /permissions to read the rest of this run's text.");
  expect((await ui.find({ key: "final-text" }))?.props.text).toBe(full.finalText.slice(0, 8000));
  expect(await ui.find({ type: "Text", text: /^wardby: / })).toBeUndefined();
  await ui.unmount();
});

test("the filter text also searches the server for older runs, and an older run opens", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  const today = { ...runRow("r1", "succeeded", 60_000), agentName: "reviewer" };
  const yearOld = {
    ...runRow("old1", "failed", 365 * 24 * 3_600_000),
    agentName: "builder",
    finishedAt: iso(365 * 24 * 3_600_000),
  };
  const queries: Record<string, unknown>[] = [];
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs" && e.args.query !== undefined) {
      queries.push(e.args);
      if (e.args.query === "wardby-runs-probe-no-such-run-3f9c1d") return reply([]);
      // The server matches the repository, which the day's rows don't show: today's run, and a year-old one.
      return reply(e.args.before === undefined ? [today, yearOld] : []);
    }
    if (e.tool === "list_runs") return reply([today]);
    if (e.tool === "get_run") return reply({ id: "old1", status: "failed", request: "Fix the login page" });
    return reply({});
  });

  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.input({ key: "filter-text", text: "your-org/web", kind: "change" });
  await clock.advance(1_000);
  await clock.settle();
  // A probe, then the search itself; nothing sent before typing paused.
  expect(queries.map((q) => q.query)).toEqual(["wardby-runs-probe-no-such-run-3f9c1d", "your-org/web"]);
  expect(await ui.find({ type: "Text", text: "Older runs" })).toBeDefined();
  // Today's run is in the list above already; only the older one is added.
  expect(await ui.find({ key: "older-run-r1" })).toBeUndefined();
  const button = await ui.find({ key: "older-run-old1" });
  expect(button?.props.label).toBe("builder · failed · 2025-11-06");
  await ui.press({ key: "older-run-old1" });
  await clock.settle();
  expect((await ui.find({ key: "request-text" }))?.props.text).toContain("Fix the login page");
  await ui.press({ key: "back" });
  await ui.press({ key: "clear-filter" });
  expect(await ui.find({ type: "Text", text: "Older runs" })).toBeUndefined();
  await ui.unmount();
});

test("an older server, which ignores query, gets no older-runs search", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  recordingServer(on, () => [runRow("r1", "succeeded", 60_000)]);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.input({ key: "filter-text", text: "zzz", kind: "change" });
  await clock.advance(1_000);
  await clock.settle();
  expect(await ui.find({ type: "Text", text: /needs 0\.9\.7 or later/ })).toBeDefined();
  expect(await ui.find({ key: "older-run-r1" })).toBeUndefined();
  await ui.unmount();
});

test("Continue locally without npx on the session's PATH runs the login shell's npx with its PATH", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  on("session.cwd", () => ({ value: "/home/me/code/wardby" }));
  on("env.get", (_, e) => ({ value: e.name === "SHELL" ? "/bin/zsh" : undefined }));
  on("mcp.call", (_, e) => {
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([runRow("r1", "succeeded", 60_000)]);
    if (e.tool === "get_run")
      return reply({
        id: "r1",
        status: "succeeded",
        codingResult: { outcome: "pull_request_opened", repository: "your-org/api" },
      });
    if (e.tool === "get_run_transcript")
      return reply({
        runId: "r1",
        status: "stored",
        repository: "your-org/api",
        download: { url: "https://wardby.example/dl?s=FAKE" },
      });
    return reply({});
  });
  on("fs.stat", () => ({ value: { kind: "dir", size: 0, mtimeMs: 0, isLink: false } }));
  const spawned: { argv: readonly string[]; env?: Record<string, string> }[] = [];
  on("process.run", (_, e) => {
    spawned.push({ argv: e.argv, env: e.init?.env });
    if (e.argv[0] === "npx") return { deny: "failed to start: ENOENT: posix_spawn 'npx'" };
    if (e.argv[0] === "/bin/zsh")
      return {
        value: {
          exitCode: 0,
          // What the rc files print comes before the answer.
          stdout: "Now using node v24\n\n@@wardby-npx@@/home/me/.nvm/bin/npx@@/home/me/.nvm/bin:/usr/bin@@\n",
          stderr: "",
        },
      };
    return {
      value: { exitCode: 0, stdout: "cd '/home/me/code/api-run-r1' && claude --resume /x/s.jsonl\n", stderr: "" },
    };
  });

  await $.session.start({ cwd: "/home/me/code/wardby", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  await ui.press({ key: "continue-locally" });
  await clock.settle();
  expect(spawned.map((s) => s.argv[0])).toEqual(["npx", "/bin/zsh", "/home/me/.nvm/bin/npx"]);
  expect(spawned[1].argv.slice(1, 2)).toEqual(["-lic"]);
  expect(spawned[2].argv.slice(1)).toEqual(["-y", "@wardby/cli@latest", "resume", "-", "--print"]);
  expect(spawned[2].env).toEqual({ PATH: "/home/me/.nvm/bin:/usr/bin" });
  expect(await ui.find({ type: "Text", text: /claude --resume/ })).toBeDefined();
  await ui.unmount();
});

/** A finished coding run in your-org/api with a pull request, and its stored transcript. */
function resumeServer(on: Parameters<Parameters<typeof test>[1]>[1], asked: string[]) {
  on("mcp.call", (_, e) => {
    asked.push(e.tool);
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (e.tool === "list_runs") return reply([runRow("r1", "succeeded", 60_000)]);
    if (e.tool === "get_run")
      return reply({
        id: "r1",
        status: "succeeded",
        codingResult: {
          outcome: "pull_request_opened",
          repository: "your-org/api",
          pullRequestUrl: "https://github.com/your-org/api/pull/9",
        },
      });
    if (e.tool === "get_run_transcript")
      return reply({ runId: "r1", status: "stored", download: { url: "https://wardby.example/dl?s=FAKE" } });
    return reply({});
  });
}

const DIR_STAT = { kind: "dir", size: 0, mtimeMs: 0, isLink: false } as const;
const dirEntry = (name: string) => ({ name, kind: "dir", size: 0, mtimeMs: 0, isLink: false }) as const;

test("Continue locally into a folder that is not there says so, offers a clone, and starts nothing", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  on("session.cwd", () => ({ value: "/home/me/code/wardby" }));
  const asked: string[] = [];
  resumeServer(on, asked);
  on("fs.stat", () => ({ deny: "ENOENT: no such file or directory" }));
  on("fs.list", () => ({ value: [dirEntry("wardby"), dirEntry("other")] }));
  on("fs.read", (_, e) =>
    e.path === "/home/me/code/other/.git/config"
      ? { value: '[remote "origin"]\n\turl = git@github.com:your-org/web.git\n' }
      : { deny: "ENOENT" },
  );
  const spawned: string[][] = [];
  on("process.run", (_, e) => {
    spawned.push([...e.argv]);
    return { deny: "failed to start: ENOENT: posix_spawn" };
  });

  await $.session.start({ cwd: "/home/me/code/wardby", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  await ui.press({ key: "continue-locally" });
  await clock.settle();
  expect(spawned).toEqual([]);
  expect(asked).not.toContain("get_run_transcript");
  expect(await ui.find({ type: "Text", text: /No folder at \/home\/me\/code\/api\./ })).toBeDefined();
  expect(await ui.find({ key: "use-clone-0" })).toBeUndefined();
  expect((await ui.find({ key: "clone-repo" }))?.text).toContain("Clone your-org/api into /home/me/code/api");
  expect(await ui.find({ type: "Text", text: /npx/ })).toBeUndefined();
  await ui.unmount();
});

test("Continue locally finds a clone in a subfolder nearby, and Use continues there", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  on("session.cwd", () => ({ value: "/home/me/code/wardby" }));
  resumeServer(on, []);
  on("fs.stat", (_, e) => (e.path === "/home/me/code/api" ? { deny: "ENOENT" } : { value: DIR_STAT }));
  const listed: string[] = [];
  on("fs.list", (_, e) => {
    listed.push(e.path);
    if (e.path === "/home/me/code")
      return { value: [dirEntry("wardby"), dirEntry("work"), dirEntry(".hidden"), dirEntry("node_modules")] };
    if (e.path === "/home/me/code/work") return { value: [dirEntry("my-api")] };
    return { value: [] };
  });
  on("fs.read", (_, e) =>
    e.path === "/home/me/code/wardby/.git/config"
      ? { value: '[remote "origin"]\n\turl = https://github.com/your-org/wardby.git\n' }
      : e.path === "/home/me/code/work/my-api/.git/config"
        ? { value: '[remote "origin"]\n\turl = https://github.com/Your-Org/api.git\n' }
        : { deny: "ENOENT" },
  );
  const spawned: { argv: readonly string[]; cwd?: string }[] = [];
  on("process.run", (_, e) => {
    spawned.push({ argv: e.argv, cwd: e.init?.cwd });
    return {
      value: { exitCode: 0, stdout: "cd '/home/me/code/my-api-run-r1' && claude --resume /x/s.jsonl\n", stderr: "" },
    };
  });

  await $.session.start({ cwd: "/home/me/code/wardby", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  await ui.press({ key: "continue-locally" });
  await clock.settle();
  expect((await ui.find({ key: "use-clone-0" }))?.text).toContain("Use /home/me/code/work/my-api");
  expect(await ui.find({ key: "use-clone-1" })).toBeUndefined();
  // Another repository is a clone, so it is not searched inside.
  expect(listed).not.toContain("/home/me/code/wardby");

  await ui.press({ key: "use-clone-0" });
  await clock.settle();
  expect(spawned).toHaveLength(1);
  expect(spawned[0].argv[0]).toBe("npx");
  expect(spawned[0].cwd).toBe("/home/me/code/work/my-api");
  expect((await ui.find({ key: "resume-dir" }))?.props.value).toBe("/home/me/code/work/my-api");
  expect(await ui.find({ type: "Text", text: /my-api-run-r1/ })).toBeDefined();
  await ui.unmount();
});

test("Clone runs git clone from the pull request's host, then continues in the new clone", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  on("session.cwd", () => ({ value: "/home/me/code/wardby" }));
  resumeServer(on, []);
  let cloned = false;
  on("fs.stat", () => (cloned ? { value: DIR_STAT } : { deny: "ENOENT" }));
  on("fs.list", () => ({ value: [] }));
  const spawned: { argv: readonly string[]; cwd?: string }[] = [];
  on("process.run", (_, e) => {
    spawned.push({ argv: e.argv, cwd: e.init?.cwd });
    if (e.argv[0] === "git") {
      cloned = true;
      return { value: { exitCode: 0, stdout: "", stderr: "Cloning into '/home/me/code/api'...\n" } };
    }
    return {
      value: { exitCode: 0, stdout: "cd '/home/me/code/api-run-r1' && claude --resume /x/s.jsonl\n", stderr: "" },
    };
  });

  await $.session.start({ cwd: "/home/me/code/wardby", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  await ui.press({ key: "continue-locally" });
  await clock.settle();
  await ui.press({ key: "clone-repo" });
  await clock.settle();
  expect(spawned.map((s) => s.argv)).toEqual([
    ["git", "clone", "--", "https://github.com/your-org/api.git", "/home/me/code/api"],
    ["npx", "-y", "@wardby/cli@latest", "resume", "-", "--print"],
  ]);
  expect(spawned[1].cwd).toBe("/home/me/code/api");
  expect(await ui.find({ type: "Text", text: /api-run-r1/ })).toBeDefined();
  await ui.unmount();
});

test("a failed clone shows git's error", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on, []);
  on("session.cwd", () => ({ value: "/home/me/code/wardby" }));
  resumeServer(on, []);
  on("fs.stat", () => ({ deny: "ENOENT" }));
  on("fs.list", () => ({ value: [] }));
  on("process.run", () => ({
    value: { exitCode: 128, stdout: "", stderr: "fatal: repository not found\n" },
  }));

  await $.session.start({ cwd: "/home/me/code/wardby", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await openRun(ui, "desktop", "r1");
  await clock.settle();
  await ui.press({ key: "continue-locally" });
  await clock.settle();
  await ui.press({ key: "clone-repo" });
  await clock.settle();
  expect(await ui.find({ type: "Text", text: /could not clone .*fatal: repository not found/ })).toBeDefined();
  await ui.unmount();
});
