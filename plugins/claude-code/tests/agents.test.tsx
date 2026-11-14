import { expect, mock, test } from "claude-code/testing";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const PANE = {
  plugin: "wardby-runs",
  component: "Pane",
  requestId: "wardby-runs",
  props: {
    title: "wardby runs",
    isFocused: false,
    bodyColumns: 80,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;
const SURFACES = ["terminal", "desktop"] as const;
const FLOWS_NOTICE = "Drawing flows needs wardby 0.9.14 or later.";

type On = Parameters<Parameters<typeof test>[1]>[1];

const R = "github:your-org/mobile";
export const LINKS = {
  agents: [
    {
      id: "d",
      name: "delivery",
      kind: "native",
      codingProvider: null,
      model: "claude-sonnet-5-5",
      budgetUsd: 21,
      access: "owner",
      budgetGroup: null,
      promptFirstLine: "Routes requests to the right coding sub-agent.",
      entry: [`mention:${R}`],
      repositories: [
        {
          provider: "github",
          repository: "your-org/mobile",
          access: "read",
          triggers: ["mention", "review_fix"],
          reviewFixMaxRounds: null,
          waitForCi: false,
          markReadyWhenPassing: false,
        },
      ],
      notes: [],
    },
    {
      id: "b",
      name: "builder",
      kind: "coding",
      codingProvider: "claude-code",
      model: "claude-opus-5-5",
      budgetUsd: 20,
      access: "owner",
      budgetGroup: null,
      promptFirstLine: "Build what the lead asks.",
      entry: [],
      repositories: [] as {
        provider: string;
        repository: string;
        access: string;
        triggers: string[];
        reviewFixMaxRounds: number | null;
        waitForCi: boolean;
        markReadyWhenPassing: boolean;
      }[],
      notes: [],
    },
    {
      id: "v",
      name: "reviewer",
      kind: "native",
      codingProvider: null,
      model: "claude-sonnet-5-5",
      budgetUsd: 1.5,
      access: "owner",
      budgetGroup: null,
      promptFirstLine: "Review one pull request.",
      entry: [],
      repositories: [
        {
          provider: "github",
          repository: "your-org/mobile",
          access: "read",
          triggers: ["pull_request"],
          reviewFixMaxRounds: null,
          waitForCi: true,
          markReadyWhenPassing: false,
        },
      ],
      notes: [],
    },
    {
      id: "s",
      name: "solo",
      kind: "native",
      codingProvider: null,
      model: "claude-haiku-4-5",
      budgetUsd: 1,
      access: "read",
      budgetGroup: null,
      promptFirstLine: "Weekly digest.",
      entry: ["schedule"],
      repositories: [],
      notes: [],
    },
  ],
  edges: [
    { from: "d", to: "b", kind: "delegates", repository: null, label: "build" },
    { from: "v", to: "d", kind: "fixes", repository: R, label: "fix ≤2" },
    { from: "b", to: "v", kind: "reviews", repository: R, label: "PR opened" },
  ],
  flows: [
    {
      key: "d",
      name: "your-org/mobile",
      agentIds: ["b", "d", "v"],
      entryAgentIds: ["d"],
      repositories: [R],
      related: [],
    },
  ],
  unlinked: ["s"],
  hidden: { agents: 0, edges: 0 },
};
export type Links = typeof LINKS;

/**
 * A fake wardby server with list_agent_links (or, with hasTool false, an older one without it, answered
 * from per-agent calls). `data` defaults to a copy of LINKS, so a test can change its own copy; `runs` is
 * what list_runs answers (none by default). `agent` is merged over get_agent's reply (its shape: the agent row,
 * access, mcpServers, and tools as attachments with allowedSecrets names); `agentError` makes get_agent fail.
 * `fail` makes one per-agent call (list_subagents or list_repositories, for one agent id) answer with an
 * error; `seen` gets every call's tool and arguments.
 */
export function linksServer(
  on: On,
  opts: {
    hasTool?: boolean;
    data?: Links;
    runs?: unknown[];
    agent?: Record<string, unknown>;
    agentError?: string;
    fail?: { tool: string; agentId: string; text: string };
    seen?: { tool: string; args: Record<string, unknown> }[];
  } = {},
) {
  const data = opts.data ?? structuredClone(LINKS);
  const calls: string[] = [];
  on("mcp.call", (_, e) => {
    calls.push(e.tool);
    opts.seen?.push({ tool: e.tool, args: { ...e.args } });
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
    if (opts.fail && e.tool === opts.fail.tool && e.args.agentId === opts.fail.agentId)
      return { value: { content: [{ type: "text", text: opts.fail.text }], isError: true } };
    if (e.tool === "list_agent_links") {
      if (opts.hasTool === false)
        return { value: { content: [{ type: "text", text: "Tool list_agent_links not found" }], isError: true } };
      return reply(data);
    }
    if (e.tool === "list_agents")
      return reply(
        data.agents.map(({ id, name, kind, model, budgetUsd, access }) => ({
          id,
          name,
          kind,
          model,
          budgetUsd,
          access,
        })),
      );
    if (e.tool === "list_subagents")
      return reply({
        children: e.args.agentId === "d" ? [{ boundName: "build", agentId: "b", agentName: "builder" }] : [],
        parents: [],
      });
    if (e.tool === "list_repositories")
      return reply({ repositories: data.agents.find((a) => a.id === e.args.agentId)?.repositories ?? [] });
    if (e.tool === "list_runs") return reply(e.args.query === undefined ? (opts.runs ?? []) : []);
    if (e.tool === "get_agent") {
      if (opts.agentError) return { value: { content: [{ type: "text", text: opts.agentError }], isError: true } };
      return reply({
        id: e.args.id,
        name: "delivery",
        systemPrompt: "Routes requests to the right coding sub-agent.\nMore.",
        model: "claude-sonnet-5-5",
        budgetUsd: "21",
        allowedOverrunPercent: 0,
        kind: "native",
        codingProfile: null,
        access: "owner",
        mcpServers: [],
        tools: [],
        repositories: [],
        ...opts.agent,
      });
    }
    return reply(null);
  });
  return calls;
}

/** The engine calls the pane makes. */
export function engine(on: On, toasts: string[] = []) {
  on("command.register", () => ({ value: { command: "wardby-runs" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.toast", (_, e) => {
    toasts.push(String(e.text));
    return { value: {} };
  });
  on("ui.status", () => ({ value: {} }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.version", () => ({ value: { version: "2.1.322", base: "2.1.322" } }));
}

export const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: "Text" })).map((el) => el.text).join("\n");

/** Starts a session and opens the pane, as /wardby-runs does. */
export async function openPane($: Parameters<Parameters<typeof test>[1]>[0], clock: { settle: () => Promise<void> }) {
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
}

test("the Agents tab fetches list_agent_links once and lists flows, on every surface", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const calls = linksServer(on);
  await openPane($, clock);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.press({ key: "tab-agents" });
    await clock.settle();
    const text = await texts(ui);
    expect(calls.filter((c) => c === "list_agent_links")).toHaveLength(1);
    expect(text).toContain("your-org/mobile");
    expect(text).toContain("delivery");
    expect(text).toContain("Unlinked agents (1)");
    expect(text).not.toMatch(/workflow/i);
    // Back to Runs, so the next surface starts on the Runs tab.
    await ui.press({ key: "tab-runs" });
    await clock.settle();
    await ui.unmount();
  }
});

test("the tab buttons: hotkeys 1 and 2 in the terminal, the current tab primary on the desktop", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on);
  await openPane($, clock);

  const term = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await term.find({ key: "tab-runs" }))?.props.hotkey).toBe("1");
  expect((await term.find({ key: "tab-agents" }))?.props.hotkey).toBe("2");
  await term.unmount();

  const desk = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect((await desk.find({ key: "tab-runs" }))?.props.variant).toBe("primary");
  expect((await desk.find({ key: "tab-agents" }))?.props.variant).toBe("secondary");
  // The Runs tab keeps its View bar.
  expect(await desk.find({ key: "view-ledger" })).toBeDefined();
  await desk.press({ key: "tab-agents" });
  await clock.settle();
  expect((await desk.find({ key: "tab-agents" }))?.props.variant).toBe("primary");
  expect(await desk.find({ key: "view-ledger" })).toBeUndefined();
  await desk.unmount();
});

test("Refresh on the Agents tab asks list_agent_links again", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const calls = linksServer(on);
  await openPane($, clock);

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  // Switching away and back within LINKS_REFRESH_MS uses what the pane holds.
  await ui.press({ key: "tab-runs" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  expect(calls.filter((c) => c === "list_agent_links")).toHaveLength(1);
  await ui.press({ key: "refresh" });
  await clock.settle();
  expect(calls.filter((c) => c === "list_agent_links")).toHaveLength(2);
  await ui.unmount();
});

test("an older server falls back to per-agent calls and says flows are approximate, on every surface", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const calls = linksServer(on, { hasTool: false });
  await openPane($, clock);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.press({ key: "tab-agents" });
    await clock.settle();
    expect(calls).toContain("list_subagents");
    expect(calls).toContain("list_repositories");
    const text = await texts(ui);
    expect(text).toContain("flows are approximate");
    // The fallback builds the same flow: delivery delegates to builder, reviewer reviews and fixes.
    expect(text).toContain("your-org/mobile");
    expect(text).toContain("builder");
    expect(text).toContain("reviewer");
    expect(text).toContain("Unlinked agents (1)");
    expect(text).not.toMatch(/workflow/i);
    await ui.press({ key: "tab-runs" });
    await ui.unmount();
  }
});

test("an older server with more than 30 agents says flows need a newer wardby, without per-agent calls", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const data = structuredClone(LINKS);
  data.agents = Array.from({ length: 31 }, (_, i) => ({
    ...structuredClone(LINKS.agents[3]),
    id: `a${i}`,
    name: `agent-${i}`,
  }));
  const calls = linksServer(on, { hasTool: false, data });
  await openPane($, clock);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.press({ key: "tab-agents" });
    await clock.settle();
    expect(await texts(ui)).toContain(FLOWS_NOTICE);
    expect(calls).toContain("list_agents");
    expect(calls).not.toContain("list_subagents");
    expect(calls).not.toContain("list_repositories");
    await ui.press({ key: "tab-runs" });
    await ui.unmount();
  }
});

test("auto mode refusing list_agent_links names the tools to allow", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  on("mcp.call", (_, e) => {
    if (e.tool === "list_agent_links")
      return {
        value: {
          content: [{ type: "text", text: "Permission for this tool was denied by auto mode." }],
          isError: true,
        },
      };
    return { value: { content: [{ type: "text", text: "[]" }], isError: false } };
  });
  await openPane($, clock);

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  const text = await texts(ui);
  expect(text).toContain("mcp__wardby__list_agent_links");
  expect(text).toContain("mcp__wardby__get_agent");
  await ui.unmount();
});

test("nothing is fetched for the Agents tab until it is opened", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const calls = linksServer(on);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await clock.advance(60_000);
  expect(calls).not.toContain("list_agent_links");

  await $.command.run({ command: "wardby-runs", args: "" });
  await clock.settle();
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await clock.advance(10 * 60_000);
    await ui.unmount();
  }
  expect(calls).not.toContain("list_agent_links");
});

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
/** A finished or running run of one agent, as list_runs sends it. */
const run = (id: string, agentId: string, agentName: string, status: string, costUsd: string, msAgo: number) => ({
  id,
  agentId,
  agentName,
  agentBudgetUsd: 21,
  status,
  trigger: "webhook",
  costUsd,
  startedAt: iso(msAgo),
  finishedAt: status === "running" ? null : iso(msAgo - 60_000),
  heartbeatAt: iso(8_000),
  turns: 3,
});

test("a flow shows its strip, cards and sub-agents, on every surface", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on, {
    runs: [
      run("r1", "d", "delivery", "succeeded", "0.250000", 3_600_000),
      run("r2", "d", "delivery", "running", "0.250000", 120_000),
    ],
  });
  await openPane($, clock);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.press({ key: "tab-agents" });
    await clock.settle();
    const text = await texts(ui);
    expect(text).toContain("@mention → delivery ⇢ builder → PR → reviewer ↺ fix ≤2");
    expect(text).toContain("Routes requests to the right coding sub-agent.");
    expect(text).toMatch(/builder/);
    expect(text).toContain("waits for CI");
    expect(text).toContain("Unlinked agents (1)");
    expect(text).not.toMatch(/workflow/i);
    // Every agent opens from the list.
    for (const id of ["d", "b", "v"]) expect(await ui.find({ key: `agent-${id}` })).toBeDefined();
    if (surface === "desktop") {
      // The flow's totals, the agent's kind and chips, and the sub-agent as a line under its lead.
      expect(text).toContain("3 agents · 2 runs · $0.50");
      expect(text).toContain("Claude Code");
      expect(text).toContain("sonnet-5-5");
      expect(text).toContain("$21.00 / run");
      expect(text).toContain("⚡ mention");
      expect(text).toContain("⚡ PR opened");
      expect(text).toContain("sub-agent");
    } else {
      // A row per agent: the role bar, the name, the entry, the sub-agent under its lead.
      expect(text).toContain("▎");
      expect(text).toContain("⇢");
      expect(text).toContain("$21.00");
      // The terminal takes theme colour names, never a hex colour, a tint or an SVG.
      expect(await ui.findAll({ type: "Svg" })).toHaveLength(0);
      for (const el of await ui.findAll({ type: "Text" })) {
        expect(el.props.backgroundColor).toBeUndefined();
        if (typeof el.props.color === "string") expect(el.props.color.startsWith("#"), el.props.color).toBe(false);
      }
    }
    await ui.press({ key: "tab-runs" });
    await clock.settle();
    await ui.unmount();
  }
});

test("a narrow terminal drops the model and cost columns", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on);
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 50 }, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  const text = await texts(ui);
  expect(text).toContain("delivery");
  expect(text).not.toContain("$21.00");
  expect(text).not.toContain("sonnet-5-5");
  await ui.unmount();
});

test("a sub-agent with another lead says so, and hidden agents are counted", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const data = structuredClone(LINKS);
  data.agents.push({ ...structuredClone(LINKS.agents[0]), id: "l2", name: "planner", entry: ["manual"] });
  data.edges.push({ from: "l2", to: "b", kind: "delegates", repository: null, label: "plan" });
  data.flows[0].agentIds.push("l2");
  data.hidden = { agents: 2, edges: 1 };
  linksServer(on, { data });
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  const text = await texts(ui);
  expect(text).toContain("also used by planner");
  expect(text).toContain("2 linked agents you can't see");
  await ui.unmount();
});

test("pressing an agent opens its Detail; collapsing a flow hides its rows in the terminal", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on);
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: "flow-d" });
  expect(await texts(ui)).not.toContain("Routes requests");
  await ui.press({ key: "flow-d" });
  expect(await texts(ui)).toContain("Routes requests");
  await ui.press({ key: "agent-v" });
  expect(await texts(ui)).toContain("Agents › your-org/mobile › reviewer");
  expect(await ui.find({ key: "agent-tab-detail" })).toBeDefined();
  expect(await ui.find({ key: "agent-tab-flow" })).toBeDefined();
  // The breadcrumb's Agents goes back to the list.
  await ui.press({ key: "crumb-agents" });
  expect(await texts(ui)).toContain("@mention → delivery");
  // An agent in no flow has no Flow tab.
  await ui.press({ key: "unlinked" });
  await ui.press({ key: "agent-s" });
  expect(await texts(ui)).toContain("Agents › Unlinked › solo");
  expect(await ui.find({ key: "agent-tab-flow" })).toBeUndefined();
  await ui.press({ key: "crumb-agents" });
  await ui.unmount();
});

test("pressing a flow title on the desktop opens its key agent on Flow", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on);
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: "flow-d" });
  expect(await texts(ui)).toContain("Agents › your-org/mobile › delivery");
  expect((await ui.find({ key: "agent-tab-flow" }))?.props.variant).toBe("primary");
  expect((await ui.find({ key: "agent-tab-detail" }))?.props.variant).toBe("secondary");
  await ui.unmount();
});

test("the text filter narrows agents and drops empty flows", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on);
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.input({ key: "filter-text", text: "solo", kind: "change" });
  await clock.settle();
  let text = await texts(ui);
  expect(text).not.toContain("your-org/mobile");
  expect(text).toContain("solo");
  expect(await ui.find({ key: "agent-s" })).toBeDefined();
  // A model matches too, and a flow keeps only its matching agents.
  await ui.input({ key: "filter-text", text: "opus", kind: "change" });
  await clock.settle();
  text = await texts(ui);
  expect(text).toContain("your-org/mobile");
  expect(await ui.find({ key: "agent-b" })).toBeDefined();
  // The strip still names the whole flow; only the matching agents get a row.
  expect(await ui.find({ key: "agent-d" })).toBeUndefined();
  expect(await ui.find({ key: "agent-v" })).toBeUndefined();
  expect(text).not.toContain("solo");
  await ui.unmount();
});

/** get_agent's reply for delivery with an MCP server, a tool and the secret name that tool may use. */
const DELIVERY_AGENT = {
  allowedOverrunPercent: 10,
  mcpServers: [{ serverId: "m1", serverName: "github", allowedTools: ["search"], exposedNames: [] }],
  tools: [
    {
      agentId: "d",
      toolId: "t1",
      allowedSecrets: ["GITHUB_TOKEN"],
      allowedHosts: [],
      tool: { id: "t1", name: "fetch_page" },
    },
  ],
};

test("Detail shows the prompt, entry, budget and tools from get_agent, on every surface", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const calls = linksServer(on, {
    agent: DELIVERY_AGENT,
    runs: [
      run("r1", "d", "delivery", "succeeded", "0.250000", 3_600_000),
      run("r2", "d", "delivery", "failed", "0.750000", 7_200_000),
      run("r3", "v", "reviewer", "succeeded", "0.100000", 600_000),
    ],
  });
  await openPane($, clock);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.press({ key: "tab-agents" });
    await clock.settle();
    await ui.press({ key: "agent-d" });
    await clock.settle();
    const text = await texts(ui);
    // Fetched once for the session: the second surface uses what the pane holds.
    expect(calls.filter((c) => c === "get_agent")).toHaveLength(1);
    expect(text).toContain("you: owner");
    expect(text).toMatch(/SYSTEM PROMPT/i);
    expect(text).toContain("Routes requests to the right coding sub-agent.");
    expect(text).toMatch(/RUNS WHEN/i);
    expect(text).toContain("mention");
    expect(text).toMatch(/MODEL & BUDGET/i);
    expect(text).toContain("$21.00 per run · +10% overrun");
    expect(text).toContain("Typical: $0.50 median · 1 of 2 succeeded");
    expect(text).toMatch(/TOOLS & CONNECTIONS/i);
    expect(text).toContain("MCP: github");
    expect(text).toContain("tool: fetch_page");
    expect(text).toContain("tool secret: GITHUB_TOKEN (name only)");
    expect(text).toMatch(/LAST RUNS/i);
    expect(await ui.find({ key: "agent-run-r1" })).toBeDefined();
    expect(await ui.find({ key: "agent-run-r2" })).toBeDefined();
    // Another agent's run is not this agent's.
    expect(await ui.find({ key: "agent-run-r3" })).toBeUndefined();
    expect(await ui.find({ key: "agent-runs" })).toBeDefined();
    expect(await ui.find({ key: "copy-config" })).toBeDefined();
    expect(text).not.toMatch(/workflow/i);
    if (surface === "terminal") {
      for (const el of await ui.findAll({ type: "Text" })) {
        expect(el.props.backgroundColor).toBeUndefined();
        if (typeof el.props.color === "string") expect(el.props.color.startsWith("#"), el.props.color).toBe(false);
      }
    }
    await ui.press({ key: "crumb-agents" });
    await ui.press({ key: "tab-runs" });
    await clock.settle();
    await ui.unmount();
  }
});

test("the budget line names the budget group and leaves out a zero overrun and an empty window", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const data = structuredClone(LINKS);
  (data.agents[0] as { budgetGroup: unknown }).budgetGroup = { id: "g1", name: "WMD Shop" };
  linksServer(on, { data });
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: "agent-d" });
  await clock.settle();
  const text = await texts(ui);
  expect(text).toContain('$21.00 per run · group "WMD Shop"');
  expect(text).not.toContain("overrun");
  expect(text).not.toContain("Typical");
  await ui.unmount();
});

test("a Claude Code agent shows repo skills and sessionResume", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on, {
    agent: {
      name: "builder",
      kind: "coding",
      codingProfile: { provider: "claude-code", repoSkills: true, sessionResume: false },
    },
  });
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: "agent-b" });
  await clock.settle();
  const text = await texts(ui);
  expect(text).toContain("repo skills: on");
  expect(text).toContain("sessionResume: off");
  await ui.unmount();
});

test("a long prompt is collapsed until Show all", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const prompt = Array.from({ length: 12 }, (_, i) => `Prompt line ${i + 1}.`).join("\n");
  linksServer(on, { agent: { systemPrompt: prompt } });
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: "agent-d" });
  await clock.settle();
  expect(await texts(ui)).toContain("Prompt line 1.");
  expect(await texts(ui)).not.toContain("Prompt line 12.");
  await ui.press({ key: "prompt-all" });
  expect(await texts(ui)).toContain("Prompt line 12.");
  await ui.unmount();
});

test("the Flow tab is hidden for an agent in no flow", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on);
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: "unlinked" });
  await ui.press({ key: "agent-s" });
  await clock.settle();
  expect(await texts(ui)).not.toContain("Flow");
  expect(await ui.find({ key: "agent-tab-flow" })).toBeUndefined();
  await ui.unmount();
});

test("Runs → filters the Runs tab to the agent", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on);
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: "agent-v" });
  await clock.settle();
  await ui.press({ key: "agent-runs" });
  await clock.settle();
  // The filter box shows the agent name, on the Runs tab.
  expect((await ui.find({ key: "filter-text" }))?.props.value).toBe("reviewer");
  expect(await texts(ui)).toContain("[Runs]");
  await ui.unmount();
});

test("a last run opens in the Runs tab", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const calls = linksServer(on, { runs: [run("r1", "d", "delivery", "succeeded", "0.250000", 3_600_000)] });
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: "agent-d" });
  await clock.settle();
  await ui.press({ key: "agent-run-r1" });
  await clock.settle();
  // The Runs tab's run detail: its back button and the run's spend.
  expect(calls).toContain("get_run");
  expect(await ui.find({ key: "back" })).toBeDefined();
  expect(await texts(ui)).toContain("$0.25 of $21.00 budget");
  await ui.unmount();
});

test("Copy config copies get_agent's JSON, system prompt included", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const copies: string[] = [];
  on("ui.copy", (_, e) => {
    copies.push(String(e.text));
    return { value: { isCopied: true } };
  });
  linksServer(on, { agent: DELIVERY_AGENT });
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: "agent-d" });
  await clock.settle();
  await ui.press({ key: "copy-config" });
  await clock.settle();
  expect(copies).toHaveLength(1);
  const copied = JSON.parse(copies[0]) as Record<string, unknown>;
  expect(copied.systemPrompt).toBe("Routes requests to the right coding sub-agent.\nMore.");
  expect(copied.allowedOverrunPercent).toBe(10);
  // The desktop's prompt card has its own Copy: the prompt alone.
  await ui.press({ key: "copy-prompt" });
  await clock.settle();
  expect(copies[1]).toBe("Routes requests to the right coding sub-agent.\nMore.");
  await ui.unmount();
});

test("get_agent failing shows the error; r reads it again", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const calls = linksServer(on, { agentError: "MCP error: agent not found" });
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: "agent-d" });
  await clock.settle();
  expect(await texts(ui)).toContain("agent not found");
  // Back to the list and in again uses what the pane holds; Refresh asks again.
  await ui.press({ key: "crumb-agents" });
  await ui.press({ key: "agent-d" });
  await clock.settle();
  expect(calls.filter((c) => c === "get_agent")).toHaveLength(1);
  await ui.press({ key: "refresh" });
  await clock.settle();
  expect(calls.filter((c) => c === "get_agent")).toHaveLength(2);
  await ui.unmount();
});

/** Opens an agent's Flow tab on a surface, from the Agents list. */
async function openFlow(
  $: Parameters<Parameters<typeof test>[1]>[0],
  clock: { settle: () => Promise<void> },
  surface: "terminal" | "desktop",
  agentKey: string,
) {
  const ui = await $.ui.mount({ ...PANE, surface });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: agentKey });
  await clock.settle();
  await ui.press({ key: "agent-tab-flow" });
  await clock.settle();
  return ui;
}

test("the terminal Flow tab draws a tree with the fix loop as a back reference", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on, { runs: [run("r1", "d", "delivery", "succeeded", "0.250000", 3_600_000)] });
  await openPane($, clock);
  const ui = await openFlow($, clock, "terminal", "agent-d");
  const lines = (await texts(ui)).split("\n").map((l) => l.trimEnd());
  const i = lines.findIndex((l) => l.includes("@mention your-org/mobile"));
  expect(i).toBeGreaterThanOrEqual(0);
  const after = lines.slice(i).join("\n");
  expect(after).toMatch(
    /delivery[\s\S]*⇢ build builder[\s\S]*\(PR opened\)[\s\S]*reviewer[\s\S]*↺ fix ≤2 → back to delivery/,
  );
  // Dim stats from the runs window beside each agent.
  expect(after).toContain("sonnet-5-5 · 1 runs · $0.25");
  const text = await texts(ui);
  expect(text).not.toMatch(/#[0-9a-f]{6}/i);
  expect(text).not.toMatch(/workflow/i);
  expect(await ui.findAll({ type: "Svg" })).toHaveLength(0);
  await ui.unmount();
});

test("an agent with two leads is drawn once and referenced", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const data = structuredClone(LINKS);
  data.agents.push({
    ...structuredClone(LINKS.agents[0]),
    id: "dl",
    name: "device-lead",
    entry: ["manual"],
    repositories: [],
    promptFirstLine: "Device check.",
  });
  data.edges.push({ from: "dl", to: "b", kind: "delegates", repository: null, label: "build" });
  data.flows[0].agentIds.push("dl");
  data.flows[0].entryAgentIds.push("dl");
  linksServer(on, { data });
  await openPane($, clock);
  const ui = await openFlow($, clock, "terminal", "agent-d");
  const text = await texts(ui);
  expect(text).toContain("▶ manual");
  expect(text).toContain("builder  (shared, shown above)");
  // The builder is drawn in full once.
  expect(text.match(/⇢ build builder$/gm)).toHaveLength(1);
  // The desktop map draws builder once, with two incoming delegate edges.
  await ui.press({ key: "crumb-agents" });
  await ui.unmount();
  const desk = await openFlow($, clock, "desktop", "agent-d");
  const svg = (await desk.findAll({ type: "Svg" })).find((el) => String(el.props.alt).startsWith("Flow map"));
  const source = String(svg?.props.source);
  expect(source.match(/>builder</g)).toHaveLength(1);
  expect(source.match(/stroke-dasharray="5 4"/g)?.length).toBeGreaterThanOrEqual(2);
  await desk.unmount();
});

test("the desktop Flow tab draws an SVG map with node buttons", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on);
  await openPane($, clock);
  const ui = await openFlow($, clock, "desktop", "agent-v");
  const svg = (await ui.findAll({ type: "Svg" })).find((el) => String(el.props.alt).startsWith("Flow map"));
  expect(svg).toBeDefined();
  const source = String(svg?.props.source);
  expect(source).toContain("<svg");
  // The selected agent (reviewer, mint) has a heavy stroke; the others are dimmed.
  expect(source).toMatch(/stroke="#15b982" stroke-width="2"/);
  expect(source).toContain('opacity=".55"');
  // The event pill and the fix loop.
  expect(source).toContain("PR opened");
  expect(source).toContain('stroke="#a8a29e"');
  expect(source).toContain("fix ≤2");
  expect(source).toContain("@mention your-org/mobile");
  expect(source).not.toMatch(/workflow/i);
  for (const id of ["d", "b", "v"]) expect(await ui.find({ key: `node-${id}` })).toBeDefined();
  await ui.press({ key: "node-b" });
  await clock.settle();
  expect(await texts(ui)).toContain("› builder");
  // Still on the Flow tab.
  expect((await ui.find({ key: "agent-tab-flow" }))?.props.variant).toBe("primary");
  await ui.unmount();
});

test("the terminal Flow tab moves a cursor over agents with j and k and opens one with o", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on);
  await openPane($, clock);
  const ui = await openFlow($, clock, "terminal", "agent-d");
  expect((await ui.find({ key: "flow-next" }))?.props.hotkey).toBe("j");
  expect((await ui.find({ key: "flow-prev" }))?.props.hotkey).toBe("k");
  expect((await ui.find({ key: "flow-open" }))?.props.hotkey).toBe("o");
  // No hotkey is used twice on the screen.
  const hotkeys = (await ui.findAll({ type: "Button" }))
    .map((el) => el.props.hotkey)
    .filter((k): k is string => typeof k === "string");
  expect(new Set(hotkeys).size).toBe(hotkeys.length);
  // The cursor starts on the open agent.
  expect(await texts(ui)).toMatch(/› delivery/);
  await ui.press({ key: "flow-next" });
  await clock.settle();
  expect(await texts(ui)).toMatch(/› ⇢ build builder/);
  await ui.press({ key: "flow-next" });
  await ui.press({ key: "flow-prev" });
  await clock.settle();
  expect(await texts(ui)).toMatch(/› ⇢ build builder/);
  await ui.press({ key: "flow-open" });
  await clock.settle();
  const text = await texts(ui);
  expect(text).toContain("Agents › your-org/mobile › builder");
  expect(text).toContain("[Flow]");
  await ui.unmount();
});

test("recent runs in a flow, and Open in Runs filters the Runs tab to the flow's agents", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on, {
    runs: [
      run("r1", "d", "delivery", "succeeded", "0.250000", 3_600_000),
      run("r2", "v", "reviewer", "failed", "0.100000", 1_800_000),
      run("r3", "s", "solo", "succeeded", "0.050000", 600_000),
    ],
  });
  await openPane($, clock);
  for (const surface of SURFACES) {
    const ui = await openFlow($, clock, surface, "agent-d");
    const text = await texts(ui);
    expect(text).toContain("Recent runs in this flow");
    const recent = text.slice(text.indexOf("Recent runs in this flow"));
    expect(recent).toContain("delivery");
    expect(recent).toContain("reviewer");
    expect(recent).not.toContain("solo");
    await ui.press({ key: "flow-runs" });
    await clock.settle();
    expect((await ui.find({ key: "filter-text" }))?.props.value).toBe("builder, delivery, reviewer");
    // delivery's and reviewer's runs, not solo's.
    const runsText = await texts(ui);
    expect(runsText).toContain("2 of 3 shown");
    expect(runsText).not.toContain("solo");
    // Back to a clean pane for the next surface.
    await ui.press({ key: "clear-filter" });
    await ui.press({ key: "tab-agents" });
    await clock.settle();
    await ui.press({ key: "crumb-agents" });
    await ui.press({ key: "tab-runs" });
    await clock.settle();
    await ui.unmount();
  }
});

test("the Flow tab lists agents that look related but are not linked", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const data = structuredClone(LINKS);
  data.flows[0].related = ["s"];
  data.unlinked = [];
  linksServer(on, { data });
  await openPane($, clock);
  for (const surface of SURFACES) {
    const ui = await openFlow($, clock, surface, "agent-d");
    const text = await texts(ui);
    const related = text.slice(text.indexOf("Not linked, but looks related"));
    expect(text).toContain("Not linked, but looks related");
    expect(related).toContain("solo");
    expect(related).toContain("⏱ schedule");
    expect(related).toContain("no repository, no sub-agent edge");
    await ui.press({ key: "crumb-agents" });
    await ui.press({ key: "tab-runs" });
    await clock.settle();
    await ui.unmount();
  }
});

test("a pull_request or push entry reads as PR opened or merged, with the short repository, on every surface", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const data = structuredClone(LINKS);
  data.agents[3].entry = [`pull_request:${R}`, "push:local:app"];
  data.agents[0].entry = [`mention:${R}`, `push:${R}`];
  linksServer(on, { data });
  await openPane($, clock);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.press({ key: "tab-agents" });
    await clock.settle();
    await ui.press({ key: "unlinked" });
    let text = await texts(ui);
    expect(text).toContain("⚡ PR opened · your-org/mobile");
    expect(text).not.toContain("pull_request:");
    // Detail's Runs when lists every entry; a local: repository keeps its prefix.
    await ui.press({ key: "agent-s" });
    await clock.settle();
    text = await texts(ui);
    expect(text).toContain("⚡ PR opened · your-org/mobile");
    expect(text).toContain("⚡ merged · local:app");
    expect(text).not.toContain("github:");
    await ui.press({ key: "crumb-agents" });
    await ui.press({ key: "unlinked" });
    await ui.press({ key: "tab-runs" });
    await clock.settle();
    await ui.unmount();
  }
  // The Flow tab's tree and map write the entry line the same way.
  const term = await openFlow($, clock, "terminal", "agent-d");
  expect(await texts(term)).toContain("@mention your-org/mobile · ⚡ merged · your-org/mobile");
  await term.press({ key: "crumb-agents" });
  await term.press({ key: "tab-runs" });
  await clock.settle();
  await term.unmount();
  const desk = await openFlow($, clock, "desktop", "agent-d");
  const svg = (await desk.findAll({ type: "Svg" })).find((el) => String(el.props.alt).startsWith("Flow map"));
  expect(String(svg?.props.source)).toContain("merged · your-org/mobile");
  expect(String(svg?.props.source)).not.toContain("push:");
  await desk.unmount();
});

test("Tools & connections lists tool secrets alone, and says when nothing is attached", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  // A tool attachment whose tool name the reply left out: only its secret name is listed.
  linksServer(on, { agent: { tools: [{ agentId: "d", toolId: "t1", allowedSecrets: ["FAKE_ONLY_SECRET"] }] } });
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.press({ key: "agent-d" });
  await clock.settle();
  const text = await texts(ui);
  expect(text).toContain("tool secret: FAKE_ONLY_SECRET (name only)");
  expect(text).not.toContain("No tools or connections attached.");
  expect(text).not.toContain("Nothing attached.");
  await ui.unmount();
});

test("an agent with no tools or connections says so", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on);
  await openPane($, clock);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.press({ key: "tab-agents" });
    await clock.settle();
    await ui.press({ key: "agent-d" });
    await clock.settle();
    expect(await texts(ui)).toContain("No tools or connections attached.");
    await ui.press({ key: "crumb-agents" });
    await ui.press({ key: "tab-runs" });
    await clock.settle();
    await ui.unmount();
  }
});

test("an older server: one agent's failing per-agent call leaves it without links, not the whole tab", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on, {
    hasTool: false,
    fail: { tool: "list_subagents", agentId: "d", text: "MCP error: agent not found" },
  });
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  const text = await texts(ui);
  expect(text).not.toContain("agent not found");
  expect(text).toContain("flows are approximate");
  // Without delivery's sub-agent, the fix loop still links delivery and reviewer; builder joins solo unlinked.
  expect(text).toContain("delivery");
  expect(text).toContain("reviewer");
  expect(text).toContain("Unlinked agents (2)");
  await ui.unmount();
});

test("an older server: auto mode refusing a per-agent call names the fallback's tools", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  linksServer(on, {
    hasTool: false,
    fail: { tool: "list_repositories", agentId: "v", text: "Permission for this tool was denied by auto mode." },
  });
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  const text = await texts(ui);
  expect(text).toContain("auto mode refused the call");
  expect(text).toContain("mcp__wardby__list_subagents");
  expect(text).toContain("mcp__wardby__list_repositories");
  await ui.unmount();
});

test("typing in the filter on the Agents tab searches no runs until Runs is shown", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  linksServer(on, { seen });
  await openPane($, clock);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "tab-agents" });
  await clock.settle();
  await ui.input({ key: "filter-text", text: "deliv", kind: "change" });
  await clock.advance(5_000);
  await clock.settle();
  const searches = () => seen.filter((c) => c.tool === "list_runs" && c.args.query !== undefined);
  expect(searches()).toHaveLength(0);
  expect(await texts(ui)).toContain("delivery");
  // Back on Runs, the filter's text is searched.
  await ui.press({ key: "tab-runs" });
  await clock.advance(5_000);
  await clock.settle();
  expect(searches().map((c) => c.args.query)).toContain("deliv");
  await ui.unmount();
});

test("the list shows a prompt's first line as plain text", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const data = structuredClone(LINKS);
  data.agents[0].promptFirstLine = "\u001b[31mRoutes\u001b[0m requests\u0007 onward.";
  linksServer(on, { data });
  await openPane($, clock);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.press({ key: "tab-agents" });
    await clock.settle();
    const text = await texts(ui);
    expect(text).toContain("Routes requests onward.");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    await ui.press({ key: "tab-runs" });
    await clock.settle();
    await ui.unmount();
  }
});

test("an agent name with markup is escaped in the desktop map", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const data = structuredClone(LINKS);
  data.agents[1].name = "a<b&c";
  linksServer(on, { data });
  await openPane($, clock);
  const ui = await openFlow($, clock, "desktop", "agent-d");
  const svg = (await ui.findAll({ type: "Svg" })).find((el) => String(el.props.alt).startsWith("Flow map"));
  const source = String(svg?.props.source);
  expect(source).toContain("a&lt;b&amp;c");
  expect(source).not.toContain("<b");
  expect(source).not.toContain("b&c");
  await ui.unmount();
});

/** Fakes the engine's file write and commands for Open larger; `uname` answers `system`. */
function browserHost(on: On, opts: { system?: string; openExit?: number } = {}) {
  const writes: { path: string; text: string }[] = [];
  const runs: (readonly string[])[] = [];
  on("env.get", (_, e) => ({ value: e.name === "TMPDIR" ? "/var/tmp/me/" : undefined }));
  on("fs.write", (_, e) => {
    writes.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  on("process.run", (_, e) => {
    runs.push(e.argv);
    if (e.argv[0] === "uname") return { value: { exitCode: 0, stdout: `${opts.system ?? "Darwin"}\n`, stderr: "" } };
    return { value: { exitCode: opts.openExit ?? 0, stdout: "", stderr: "" } };
  });
  return { writes, runs };
}

for (const surface of SURFACES)
  test(`${surface}: Open larger writes the flow as a page and opens it in the browser`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW });
    const toasts: string[] = [];
    engine(on, toasts);
    linksServer(on, { runs: [run("r1", "d", "delivery", "succeeded", "0.250000", 3_600_000)] });
    const host = browserHost(on);
    await openPane($, clock);
    const ui = await openFlow($, clock, surface, "agent-v");
    const button = await ui.find({ key: "flow-open-larger" });
    expect(button?.props.hotkey).toBe(surface === "terminal" ? "w" : undefined);
    await ui.press({ key: "flow-open-larger" });
    await clock.settle();
    expect(host.writes).toHaveLength(1);
    const { path, text } = host.writes[0];
    expect(path).toBe("/var/tmp/me/wardby-flows/flow-d.html");
    expect(host.runs).toContainEqual(["open", path]);
    expect(text.startsWith("<!doctype html>")).toBe(true);
    expect(text).toContain("<title>your-org/mobile · wardby flow</title>");
    expect(text).toContain("<svg");
    expect(text).toContain("fix ≤2");
    // Every agent at full strength, the open one still ringed.
    expect(text).not.toContain('opacity=".55"');
    expect(text).toMatch(/stroke="#15b982" stroke-width="2"/);
    for (const name of ["delivery", "builder", "reviewer"]) expect(text).toContain(name);
    expect(text).toContain("Review one pull request.");
    expect(text).toContain("$0.25");
    expect(text).not.toMatch(/workflow/i);
    expect(toasts).toContain("Opened the flow map in your browser");
    await ui.unmount();
  });

test("Open larger uses xdg-open off macOS and says where the page is when no browser starts", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  const toasts: string[] = [];
  engine(on, toasts);
  linksServer(on);
  const host = browserHost(on, { system: "Linux", openExit: 3 });
  await openPane($, clock);
  const ui = await openFlow($, clock, "terminal", "agent-d");
  await ui.press({ key: "flow-open-larger" });
  await clock.settle();
  const path = host.writes[0]?.path;
  expect(host.runs).toContainEqual(["xdg-open", path]);
  expect(toasts).toContain(`Couldn't open a browser. The page is at ${path}`);
  await ui.unmount();
});

test("the larger flow page escapes agent names and prompt lines", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  engine(on);
  const data = structuredClone(LINKS);
  data.agents[1].name = "a<b&c";
  data.agents[1].promptFirstLine = '<script>alert("x")</script>';
  linksServer(on, { data });
  const host = browserHost(on);
  await openPane($, clock);
  const ui = await openFlow($, clock, "desktop", "agent-d");
  await ui.press({ key: "flow-open-larger" });
  await clock.settle();
  const text = host.writes[0]?.text ?? "";
  expect(text).toContain("a&lt;b&amp;c");
  expect(text).toContain("&lt;script&gt;");
  expect(text).not.toContain("<script>");
  expect(text).not.toContain("<b&");
  await ui.unmount();
});
