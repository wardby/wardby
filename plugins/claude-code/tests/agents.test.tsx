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
 */
export function linksServer(
  on: On,
  opts: {
    hasTool?: boolean;
    data?: Links;
    runs?: unknown[];
    agent?: Record<string, unknown>;
    agentError?: string;
  } = {},
) {
  const data = opts.data ?? structuredClone(LINKS);
  const calls: string[] = [];
  on("mcp.call", (_, e) => {
    calls.push(e.tool);
    const reply = (value: unknown) => ({
      value: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
    });
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
export function engine(on: On) {
  on("command.register", () => ({ value: { command: "wardby-runs" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.toast", () => ({ value: {} }));
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
    expect(text).toContain("secret: GITHUB_TOKEN (name only)");
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
