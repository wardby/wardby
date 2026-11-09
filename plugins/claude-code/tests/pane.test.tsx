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
  const spawned: { argv: readonly string[]; cwd?: string; stdin?: string }[] = [];
  on("process.run", (_, e) => {
    spawned.push({ argv: e.argv, cwd: e.init?.cwd, stdin: e.init?.stdin });
    return {
      value: {
        exitCode: 0,
        // A command that echoed the link would still not show it.
        stdout: `Imported run r1 from ${LINK}\ncd '/home/me/code/api-run-r1' && claude --resume /x/s.jsonl --append-system-prompt 'moved'\n`,
        stderr: "",
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
  expect((await ui.find({ type: "Text", text: /\(this run\)/ }))?.text).toContain("client-updater");
  await ui.press({ key: "tree-lead" });
  await clock.settle();
  expect((await ui.find({ type: "Text", text: /\(this run\)/ }))?.text).toContain("builder");
  await ui.unmount();
});

test("runs linked by a pull request sit under it in order, with the event that started each", async ($, on) => {
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
  // Newest first: the lone audit run, then the chain in the order it happened, the builder under its lead.
  expect(order).toEqual(["run-solo", "run-open1", "run-rev1", "run-fix1", "run-bld1"]);
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
  expect((await ui.findAll({ type: "Svg" })).map((el) => el.props.alt)).toEqual([
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
  expect(await ui.find({ type: "Svg" })).toBeUndefined();
  expect(await ui.find({ key: "toggle-your-org/api#160" })).toBeDefined();
  await ui.unmount();
});

test("the final text is drawn as markdown, cut at a line break until expanded", async ($, on) => {
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
  // It ends on a whole list item, then an ellipsis, not mid-word.
  expect(cut).toMatch(/updated the expected count\n\n…$/);
  await ui.press({ key: "expand" });
  expect((await ui.find({ key: "final-text" }))?.props.text).toBe(finalText);
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
  // In the ledger, the cost of a run at 85% of its budget is amber.
  // (the group's total, also $0.85, stays neutral)
  const costs = (await ui.findAll({ type: "Text", text: /^\$0\.85$/ })).map((el) => el.props.color);
  expect(costs).toContain("warning");
  await openRun(ui, "desktop", "h1");
  await clock.settle();
  // The detail: the status in its theme colour (no light fill, for dark mode), a plain sentence, the error first.
  const chip = await ui.find({ type: "Text", text: /^✗ failed$/ });
  expect(chip?.props.color).toBe("error");
  expect(chip?.props.backgroundColor).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^Started by hand\. Ran / })).toBeDefined();
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
        expect(el.props.backgroundColor, `${type} ${el.text}`).toBeUndefined();
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
  // Group boxes use the theme's prompt-box border, which stays visible in dark mode.
  const bordered = (await ui.findAll({ type: "Box" })).filter((el) => el.props.borderStyle === "round");
  expect(bordered.length).toBeGreaterThan(0);
  expect(bordered.every((el) => el.props.borderColor === "promptBorder" || el.props.borderColor === "error")).toBe(
    true,
  );
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
    expect(JSON.stringify(await ui.find({ key: "step-5" }))).toContain("Bash: step 5");
    expect(JSON.stringify(await ui.find({ key: "step-10" }))).toContain("Bash: step 10 (exit 1)");
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
  expect(JSON.stringify(row)).toContain("said: [click](https://example.invalid) **b**");
  expect(await ui.find({ type: "Link", text: /click/ })).toBeUndefined();
  expect((await ui.findAll({ type: "Markdown" })).some((el) => String(el.props.text).includes("example.invalid"))).toBe(
    false,
  );
  await ui.unmount();
});

test("a long step summary wraps: every stored character is drawn, on both surfaces", async ($, on) => {
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
    const row = JSON.stringify(await ui.find({ key: "step-1" }));
    expect(row).toContain(long);
    expect(row).toContain("END-OF-SUMMARY");
    expect(row).not.toContain("truncate");
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

function detailServer(on: Parameters<Parameters<typeof test>[1]>[1], withDetail: boolean) {
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
        steps: [step(1, "npm test\n\n--- output (end) ---\nall [link](https://evil.invalid) passed"), step(2, "ls")],
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
