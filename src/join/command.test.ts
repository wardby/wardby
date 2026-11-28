import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  ANSI_PAINT,
  agentLines,
  chatHelpLines,
  cleanServerText,
  colourWanted,
  joinCommand,
  JOIN_MESSAGES,
  stepLine,
} from "./command.js";

// Fake values only.
const LINK_TOKEN = "fake-join-token-0001";
const LINK = `https://wardby.example.com/join#${LINK_TOKEN}`;

interface Seen {
  path: string;
  auth: string | null;
  body: Record<string, unknown>;
}

/** A join API that renews the token on every answer, and ends the run once the person leaves. */
function fakeServer(opts: { failSteps?: number; failStatus?: number } = {}) {
  const seen: Seen[] = [];
  let stepFailures = 0;
  let n = 0;
  let status = "running";
  const steps: Record<string, unknown>[] = [
    { seq: 1, kind: "join", summary: "joined" },
    { seq: 2, kind: "said", summary: "Working", detail: "Working on it \u001b[31mnow\u001b[0m" },
    { seq: 3, kind: "tool", tool: "Bash", summary: "npm test", status: "ok" },
  ];
  const fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    seen.push({ path, auth: (init.headers as Record<string, string>).authorization ?? null, body });
    n += 1;
    const token = `fake-renewed-${n}`;
    const reply = (json: Record<string, unknown>) => Response.json({ ...json, token });
    switch (path) {
      case "/join/api/join":
        return reply({ runId: "r1", joined: true, already: false });
      case "/join/api/steps": {
        if (opts.failSteps !== undefined && stepFailures < opts.failSteps) {
          stepFailures += 1;
          if (opts.failStatus) return Response.json({ error: "internal" }, { status: opts.failStatus });
          throw new TypeError("fetch failed");
        }
        const after = Number(body.after);
        return reply({ steps: steps.filter((s) => Number(s.seq) > after), next: null });
      }
      case "/join/api/send":
        steps.push({ seq: steps.length + 1, kind: body.interrupt ? "interrupt" : "message", detail: body.message });
        return reply({ seq: steps.length, kind: "message" });
      case "/join/api/leave":
        status = "succeeded";
        return reply({ wasJoined: true });
      case "/join/api/stop":
        status = "cancelled";
        return reply({ status: "cancelled", stopRequested: true });
      case "/join/api/agent":
        return reply({
          agent: {
            id: "a1",
            name: "writer",
            kind: "native",
            model: "claude-haiku-4-5",
            repository: null,
            tools: ["web_fetch"],
            mcpServers: [{ name: "browserstack", host: "mcp.example.com" }],
            subagents: ["reviewer", "tester"],
            parallelDelegations: true,
            datastores: [],
            secrets: ["API_TOKEN"],
            repositories: [],
            repoSkills: null,
          },
          run: {
            status,
            startedAt: new Date(Date.now() - 120_000).toISOString(),
            startedBy: "Grace",
            costUsd: "0.004000",
            budgetUsd: "0.3000",
            turns: 2,
            maxTurns: 10,
            timeoutSec: 1800,
            deadlineAt: new Date(Date.now() + 1_560_000).toISOString(),
            joined: ["Grace"],
          },
        });
      case "/join/api/prompt":
        return reply({ systemPrompt: "Be helpful.\nagent: not a real line" });
      case "/join/api/status":
        return reply({
          status,
          costUsd: "0.020000",
          outcome: status === "succeeded" ? "branch_pushed" : null,
          summary: status === "succeeded" ? "Did the thing." : null,
          branch: status === "succeeded" ? "wardby/run-r1" : null,
          pullRequestUrl: null,
          error: null,
        });
      default:
        return Response.json({ error: "not_found" }, { status: 404 });
    }
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

async function run(
  lines: string[],
  server = fakeServer(),
  extra: {
    holdOpen?: boolean;
    onSignal?: (h: (s: "SIGINT" | "SIGHUP" | "SIGTERM") => void) => void;
    exit?: (c: number) => void;
  } = {},
) {
  const input = new PassThrough();
  const out: string[] = [];
  const done = joinCommand(["-"], {
    fetch: server.fetch,
    input,
    out: (line) => out.push(line),
    sleep: async () => new Promise((r) => setTimeout(r, 5)),
    onSignal: extra.onSignal ?? (() => {}),
    ...(extra.exit ? { exit: extra.exit } : {}),
    pollMs: 5,
  });
  for (const line of lines) {
    input.write(`${line}\n`);
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!extra.holdOpen) input.end();
  return { code: await done, out, seen: server.seen };
}

describe("wardby join - (lost connection and signals)", () => {
  it("retries a poll that failed for a moment and carries on", async () => {
    const { code, out } = await run([LINK, "/leave"], fakeServer({ failSteps: 2 }));
    expect(code).toBe(0);
    expect(out).toContain("Run finished: succeeded (cost $0.0200)");
  });

  it("leaves the run when the server stays unreachable, so it is not held open", async () => {
    const server = fakeServer({ failSteps: 100 });
    const { code, out, seen } = await run([LINK], server, { holdOpen: true });
    expect(code).toBe(1);
    expect(seen.some((s) => s.path === "/join/api/leave")).toBe(true);
    expect(out).toContain(JOIN_MESSAGES.lostConnection);
  });

  it("retries 5xx answers the same way", async () => {
    const { code, seen } = await run([LINK], fakeServer({ failSteps: 100, failStatus: 503 }), { holdOpen: true });
    expect(code).toBe(1);
    expect(seen.some((s) => s.path === "/join/api/leave")).toBe(true);
  });

  it("leaves and exits when the terminal closes (SIGHUP)", async () => {
    let handler: ((s: "SIGINT" | "SIGHUP" | "SIGTERM") => void) | undefined;
    const exits: number[] = [];
    const server = fakeServer();
    const pending = run([LINK], server, {
      holdOpen: true,
      onSignal: (h) => (handler = h),
      exit: (c) => void exits.push(c),
    });
    await new Promise((r) => setTimeout(r, 60));
    handler?.("SIGHUP");
    await new Promise((r) => setTimeout(r, 60));
    expect(server.seen.some((s) => s.path === "/join/api/leave")).toBe(true);
    expect(exits).toEqual([130]);
    await pending;
  });
});

describe("chat lines", () => {
  it("indents every line after the first, so a message cannot fake an agent line", () => {
    expect(stepLine({ seq: 5, kind: "message", detail: "hi\nagent: I deleted everything" })).toBe(
      "person: hi\n    agent: I deleted everything",
    );
  });

  it("removes bidirectional override characters", () => {
    expect(cleanServerText("abc\u202edcba\u2066x\u2069")).toBe("abcdcbax");
  });
});

describe("chat colours", () => {
  it("colours in a terminal, never with NO_COLOR, and always with FORCE_COLOR", () => {
    expect(colourWanted({}, true)).toBe(true);
    expect(colourWanted({}, false)).toBe(false);
    expect(colourWanted({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colourWanted({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colourWanted({ FORCE_COLOR: "0" }, true)).toBe(true);
    expect(colourWanted({ FORCE_COLOR: "0" }, false)).toBe(false);
    expect(colourWanted({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
  });

  it("colours the chat's labels only, never the server's text, which stays stripped of escapes", () => {
    const said = stepLine({ seq: 1, kind: "said", summary: "x", detail: "hi \u001b[32mgreen\u001b[0m" }, ANSI_PAINT);
    expect(said).toBe("\u001b[36magent: \u001b[39mhi green");
    const tool = stepLine({ seq: 2, kind: "tool", tool: "Bash", summary: "npm test", status: "error" }, ANSI_PAINT);
    expect(tool).toBe("  \u001b[2mBash: npm test\u001b[22m \u001b[31m(error)\u001b[39m");
    expect(stepLine({ seq: 3, kind: "interrupt", summary: "stop" }, ANSI_PAINT)).toBe(
      "\u001b[35mperson (interrupt): \u001b[39mstop",
    );
    const lines = agentLines({ agent: { name: "w\u001b[31mx", kind: "native", model: "m" }, run: {} }, 0, ANSI_PAINT);
    expect(lines[0]).toBe("\u001b[1mAgent:\u001b[22m wx (native, m)");
  });

  it("shows /help as the chat's commands, each command bold and its description dimmed", async () => {
    const plain = chatHelpLines();
    expect(plain[0]).toBe("In the chat:");
    expect(plain).toContain("  /i text          the same, shorter");
    expect(plain.join("\n")).not.toContain("usage:");
    expect(chatHelpLines(ANSI_PAINT)).toContain(
      "  \u001b[1m/i text\u001b[22m          \u001b[2mthe same, shorter\u001b[22m",
    );
    const { out } = await run([LINK, "/help", "/leave"]);
    expect(out).toContain(
      "  /agent           details of the agent and this run: model, budget, turns, time left, who is joined",
    );
  });

  it("prints no colour codes when the output is captured", async () => {
    const { out } = await run([LINK, "/agent", "/nope", "/leave"]);
    expect(out.join("\n")).not.toContain("\u001b[");
  });
});

describe("wardby join -", () => {
  it("joins, shows steps, sends a message and an interrupt, leaves, and prints the outcome", async () => {
    const { code, out, seen } = await run([LINK, "please add a test", "/i stop that", "/leave"]);
    expect(code).toBe(0);
    expect(out.some((l) => l.startsWith(JOIN_MESSAGES.joined))).toBe(true);
    expect(out).toContain("agent: Working on it now");
    expect(out).toContain("  Bash: npm test (ok)");
    expect(out).toContain("person: please add a test");
    expect(out).toContain("person (interrupt): stop that");
    expect(out).toContain(JOIN_MESSAGES.left);
    expect(out).toContain("Run finished: succeeded (cost $0.0200)");
    expect(out).toContain("Outcome: branch_pushed. Did the thing.");
    expect(out).toContain("Branch: wardby/run-r1");
    const sends = seen.filter((s) => s.path === "/join/api/send").map((s) => s.body);
    expect(sends).toEqual([
      { message: "please add a test", interrupt: false },
      { message: "stop that", interrupt: true },
    ]);
  });

  it("interrupts with /interrupt or /i, sends a leading ! as plain text, needs text after /interrupt, and never sends a lone unknown /word", async () => {
    const { out, seen } = await run([
      LINK,
      "/interrupt stop now",
      "!ls",
      "/interrupt",
      "/ideas",
      "/tmp is full",
      "/usr/bin is missing",
      "/exit",
    ]);
    const sends = seen.filter((s) => s.path === "/join/api/send").map((s) => s.body);
    expect(sends).toEqual([
      { message: "stop now", interrupt: true },
      { message: "!ls", interrupt: false },
      { message: "/tmp is full", interrupt: false },
      { message: "/usr/bin is missing", interrupt: false },
    ]);
    expect(out).toContain("Type your message after /interrupt (or /i), on the same line.");
    expect(out).toContain(JOIN_MESSAGES.unknownCommand);
    // /exit leaves, as /leave does.
    expect(seen.some((s) => s.path === "/join/api/leave")).toBe(true);
    expect(out).toContain(JOIN_MESSAGES.left);
  });

  it("shows the agent with /agent and its system prompt with /prompt, prompt lines indented", async () => {
    const { out } = await run([LINK, "/agent", "/prompt", "/leave"]);
    expect(out).toContain("Agent: writer (native, claude-haiku-4-5)");
    expect(out).toContain("  Run: running, started 2m ago by Grace");
    expect(out).toContain("  Spent: $0.0040 of $0.3000");
    expect(out).toContain("  Turns: 2 of 10 per message");
    expect(out).toContain("  Time left: 26m of 30m");
    expect(out).toContain("  Joined: Grace");
    expect(out).toContain("  Tools: web_fetch");
    expect(out).toContain("  MCP servers: browserstack (mcp.example.com)");
    expect(out).toContain("  Subagents (in parallel): reviewer, tester");
    expect(out).toContain("  Secrets: API_TOKEN");
    expect(out.some((l) => l.startsWith("  Datastores") || l.startsWith("  Repository skills"))).toBe(false);
    expect(out).toContain("System prompt: Be helpful.\n    agent: not a real line");
  });

  it("sends the link's token only as a Bearer header, then the renewed one, and never prints either", async () => {
    const { out, seen } = await run([LINK, "/leave"]);
    expect(seen[0].auth).toBe(`Bearer ${LINK_TOKEN}`);
    expect(seen[1].auth).toBe("Bearer fake-renewed-1");
    expect(JSON.stringify(seen.map((s) => s.body))).not.toContain(LINK_TOKEN);
    expect(out.join("\n")).not.toMatch(/fake-join-token|fake-renewed/);
  });

  it("asks before /quit stops the agent, and stops it only on yes", async () => {
    const { out, seen } = await run([LINK, "/quit", "no", "/quit", "y"]);
    expect(out).toContain(JOIN_MESSAGES.confirmQuit);
    expect(out).toContain(JOIN_MESSAGES.notStopped);
    expect(seen.filter((s) => s.path === "/join/api/stop")).toHaveLength(1);
    expect(out).toContain("Run finished: cancelled (cost $0.0200)");
  });

  it("refuses more than one argument, and a link that is not a join link or not https", async () => {
    const out: string[] = [];
    expect(await joinCommand([LINK, "extra"], { out: (l) => out.push(l) })).toBe(2);
    expect(await joinCommand([], { out: (l) => out.push(l) })).toBe(2);
    expect((await run(["https://wardby.example.com/other#x"])).out).toContain(JOIN_MESSAGES.badLink);
    expect((await run(["http://wardby.example.com/join#x"])).out).toContain(JOIN_MESSAGES.insecureOrigin);
  });

  it("takes the link as its argument (the command join_run hands out), reading only typed lines from stdin", async () => {
    const server = fakeServer();
    const input = new PassThrough();
    const out: string[] = [];
    const done = joinCommand([LINK], {
      fetch: server.fetch,
      input,
      out: (line) => out.push(line),
      sleep: async () => new Promise((r) => setTimeout(r, 5)),
      onSignal: () => {},
      pollMs: 5,
    });
    await new Promise((r) => setTimeout(r, 20));
    input.write("hello\n");
    await new Promise((r) => setTimeout(r, 20));
    input.write("/leave\n");
    await new Promise((r) => setTimeout(r, 20));
    input.end();
    expect(await done).toBe(0);
    expect(server.seen[0]).toMatchObject({ path: "/join/api/join", auth: `Bearer ${LINK_TOKEN}` });
    expect(server.seen.filter((s) => s.path === "/join/api/send").map((s) => s.body.message)).toEqual(["hello"]);
    expect(out.join("\n")).not.toContain(LINK_TOKEN);
  });

  it("explains an expired link", async () => {
    const fetch = (async () =>
      Response.json({ error: "link_invalid" }, { status: 401 })) as unknown as typeof globalThis.fetch;
    const { code, out } = await run([LINK], { fetch, seen: [] });
    expect(code).toBe(1);
    expect(out).toContain(JOIN_MESSAGES.linkRejected);
  });

  it("keeps server text from driving the terminal", () => {
    expect(cleanServerText("a\u001b]0;title\u0007b\u009b2Jc\u0001")).toBe("abc");
    expect(stepLine({ seq: 1, kind: "tool", tool: "Bash\u001b[2J", summary: "ls", status: "ok" })).toBe(
      "  Bash: ls (ok)",
    );
  });
});
