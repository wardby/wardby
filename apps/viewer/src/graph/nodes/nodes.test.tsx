import { render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { GraphRun, Outcome } from "../../api/types";
import { OutcomeNode } from "./OutcomeNode";
import { RunNode } from "./RunNode";
import { TriggerNode } from "./TriggerNode";
import { LINK_NODE_TITLE_MAX_CHARS } from "../sizes";

function makeRun(overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id: "run_abcdef123456",
    parentRunId: null,
    agentId: "a1",
    agentName: "builder",
    agentKind: "coding",
    model: "gpt-5.5-codex",
    codingProvider: "codex",
    nativeExecutionMode: null,
    warmWorkerName: null,
    declaredServices: [],
    status: "running",
    trigger: { kind: "manual" },
    turns: 6,
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0.414,
    budgetUsd: 2,
    startedAt: new Date(Date.now() - 134_000).toISOString(),
    finishedAt: null,
    heartbeatAt: null,
    outcomes: [],
    services: [],
    ...overrides,
  } as GraphRun;
}

// Only `data` matters to the custom nodes; the rest of NodeProps is React Flow plumbing.
const props = (data: unknown) => ({ data }) as unknown as NodeProps;
const wrap = (ui: React.ReactElement) => render(<ReactFlowProvider>{ui}</ReactFlowProvider>);

describe("RunNode", () => {
  it("shows glyph, agent, id, tokens, cost and a service tray for a coding run", () => {
    const run = makeRun({
      declaredServices: [
        { name: "postgres", version: "16" },
        { name: "redis", version: "7" },
      ],
      services: [
        {
          name: "postgres",
          state: "probing",
          attempts: 3,
          reason: null,
          readyAt: null,
          failedAt: null,
          createdAt: "x",
        },
        { name: "redis", state: "ready", attempts: null, reason: null, readyAt: "x", failedAt: null, createdAt: "x" },
        { name: "kafka", state: "failed", attempts: null, reason: "oom", readyAt: null, failedAt: "x", createdAt: "x" },
      ],
    });
    const { container } = wrap(<RunNode {...props({ kind: "run", run, selected: false })} />);
    expect(screen.getByText("builder")).toBeInTheDocument();
    expect(screen.getByText("◉")).toBeInTheDocument();
    expect(screen.getByText(/123456/)).toBeInTheDocument();
    // A coding run shows its token total, not turns.
    expect(screen.getByText(/2 tok · \$0\.41/)).toBeInTheDocument();
    expect(screen.getByText(/2m 1\ds/)).toBeInTheDocument();
    const tray = screen.getByRole("list", { name: "Services" });
    const pills = [...tray.querySelectorAll("li")].map((li) => [li.className, li.getAttribute("title")]);
    expect(pills).toEqual([
      ["pill probing", "postgres 16: probing · attempt 3"],
      ["pill ready", "redis 7: ready"],
      ["pill failed", "kafka: failed · oom"],
    ]);
    // Three services take two tray rows: 70 + 9 + 2 × 20.
    expect((container.querySelector(".flow-node") as HTMLElement).style.height).toBe("119px");
  });

  it("greys out a finished run's services that never recorded a state", () => {
    const run = makeRun({
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      declaredServices: [{ name: "postgres", version: "16" }],
      services: [],
    });
    wrap(<RunNode {...props({ kind: "run", run, selected: false })} />);
    const pill = screen.getByRole("list", { name: "Services" }).querySelector("li")!;
    expect(pill.className).toBe("pill unrecorded");
    expect(pill).toHaveAttribute("title", "postgres 16: status not recorded");
  });

  it("has no tray without services", () => {
    wrap(<RunNode {...props({ kind: "run", run: makeRun({ declaredServices: [] }), selected: false })} />);
    expect(screen.queryByRole("list", { name: "Services" })).toBeNull();
  });

  it("tags a coding run with its worker and shows its model", () => {
    wrap(<RunNode {...props({ kind: "run", run: makeRun(), selected: false })} />);
    const badge = screen.getByRole("img", { name: "Codex" });
    expect(badge).toHaveTextContent("CX");
    expect(screen.getByText("gpt-5.5-codex")).toHaveAttribute("title", "gpt-5.5-codex");
  });

  it("tags Claude Code runs and shortens Claude model ids", () => {
    const run = makeRun({ codingProvider: "claude-code", model: "claude-sonnet-4-6" });
    wrap(<RunNode {...props({ kind: "run", run, selected: false })} />);
    expect(screen.getByRole("img", { name: "Claude Code" })).toHaveTextContent("CC");
    expect(screen.getByText("sonnet-4-6")).toHaveAttribute("title", "claude-sonnet-4-6");
  });

  it("shows a native run's model without a badge", () => {
    const run = makeRun({ agentKind: "native", codingProvider: null, model: "claude-haiku-4-5-20251001" });
    wrap(<RunNode {...props({ kind: "run", run, selected: false })} />);
    expect(screen.getByText("haiku-4-5")).toBeInTheDocument();
    expect(screen.getByText(/turn 6 · \$0\.41/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Codex|Claude Code/ })).toBeNull();
  });

  it("marks a sandbox-mode native run, and only that one", () => {
    const native = { agentKind: "native" as const, codingProvider: null };
    const { unmount } = wrap(
      <RunNode
        {...props({ kind: "run", run: makeRun({ ...native, nativeExecutionMode: "sandbox" }), selected: false })}
      />,
    );
    expect(screen.getByRole("img", { name: /^Agent sandbox/ })).toHaveTextContent("SB");
    unmount();
    wrap(
      <RunNode
        {...props({ kind: "run", run: makeRun({ ...native, nativeExecutionMode: "control-plane" }), selected: false })}
      />,
    );
    expect(screen.queryByRole("img", { name: /^Agent sandbox/ })).toBeNull();
  });

  it("marks failed-family runs and selection", () => {
    const run = makeRun({ status: "budget_exhausted", finishedAt: new Date().toISOString() });
    const { container } = wrap(<RunNode {...props({ kind: "run", run, selected: true })} />);
    expect(screen.getByText("✗")).toBeInTheDocument();
    const node = container.querySelector(".flow-node.run") as HTMLElement;
    expect(node).toHaveClass("failed");
    expect(node).toHaveClass("selected");
  });
});

describe("TriggerNode / OutcomeNode", () => {
  it("renders the trigger label", () => {
    wrap(<TriggerNode {...props({ kind: "trigger", trigger: { kind: "manual" }, label: "⏰ 0 * * * *" })} />);
    expect(screen.getByText("⏰ 0 * * * *")).toBeInTheDocument();
  });

  it("renders a pull request outcome", () => {
    const outcome: Outcome = {
      kind: "pull_request",
      provider: "github",
      repository: "your-org/app",
      number: 212,
      url: "https://example.test/pr/212",
      state: "open",
      at: null,
    };
    wrap(<OutcomeNode {...props({ kind: "outcome", outcome })} />);
    expect(screen.getByText("⎇ app#212")).toHaveAttribute("title", "⎇ your-org/app#212");
    expect(screen.getByText("pull request · open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open ⎇ your-org/app#212" })).toHaveAttribute(
      "title",
      "Open https://example.test/pr/212",
    );
  });

  it("keeps a long repository's number visible and links a review trigger to its pull request", () => {
    const trigger = {
      kind: "code_host" as const,
      provider: "github",
      repository: "your-org/a-very-long-repository-name",
      number: 104,
      event: "review" as const,
    };
    wrap(
      <TriggerNode
        {...props({ kind: "trigger", trigger, label: "⎇ your-org/a-very-long-repository-name#104 review" })}
      />,
    );
    const title = screen.getByText(/#104$/);
    expect(title.textContent).toMatch(/^⎇ ….*-name#104$/);
    expect(title.textContent!.length).toBeLessThanOrEqual(LINK_NODE_TITLE_MAX_CHARS);
    expect(screen.getByRole("button", { name: /^Open / })).toHaveAttribute(
      "title",
      "Open https://github.com/your-org/a-very-long-repository-name/issues/104",
    );
  });

  it("shows when a trigger fired and when an outcome happened", () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
    wrap(<TriggerNode {...props({ kind: "trigger", trigger: { kind: "manual" }, label: "manual", at })} />);
    expect(screen.getByText(hhmm(at))).toHaveAttribute("datetime", at);
    const outcome: Outcome = { kind: "check", provider: "github", repository: "o/r", number: 1, completed: true, at };
    wrap(<OutcomeNode {...props({ kind: "outcome", outcome })} />);
    expect(screen.getByText(/check · completed ·/)).toHaveTextContent(`check · completed · ${hhmm(at)}`);
  });

  it("lets a chain edge leave an outcome box", () => {
    const outcome: Outcome = {
      kind: "check",
      provider: "github",
      repository: "o/r",
      number: 1,
      completed: true,
      at: null,
    };
    const { container } = wrap(<OutcomeNode {...props({ kind: "outcome", outcome })} />);
    expect(container.querySelector(".react-flow__handle.source")).not.toBeNull();
    expect(container.querySelector(".react-flow__handle.target")).not.toBeNull();
  });

  it("gives a check outcome its kind on the second line and no link off GitHub", () => {
    const outcome: Outcome = {
      kind: "check",
      provider: "gitlab",
      repository: "g/r",
      number: 3,
      completed: true,
      at: null,
    };
    wrap(<OutcomeNode {...props({ kind: "outcome", outcome })} />);
    expect(screen.getByText("✓ r#3")).toBeInTheDocument();
    expect(screen.getByText("check · completed")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
