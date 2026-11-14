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
 * from per-agent calls). `data` defaults to a copy of LINKS, so a test can change its own copy.
 */
export function linksServer(on: On, opts: { hasTool?: boolean; data?: Links } = {}) {
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
    if (e.tool === "list_runs") return reply([]);
    if (e.tool === "get_agent")
      return reply({
        id: e.args.id,
        name: "delivery",
        systemPrompt: "Routes requests to the right coding sub-agent.\nMore.",
        model: "claude-sonnet-5-5",
        budgetUsd: "21",
        tools: [],
        repositories: [],
      });
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
