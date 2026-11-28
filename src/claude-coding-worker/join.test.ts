import { describe, expect, it, vi } from "vitest";
import {
  IDLE_POLL_MS,
  JOIN_POLL_ROUTE,
  ProxyJoinChannel,
  joinPollUrl,
  parseJoinPollAnswer,
  type JoinEvents,
} from "./join.js";

const events = () => {
  const log: Array<[string, unknown]> = [];
  const sink: JoinEvents = {
    message: (m) => void log.push(["message", m]),
    joinedChanged: (j) => void log.push(["joined", j]),
  };
  return { log, sink };
};

/** Runs the channel against scripted answers until the script ends, then stops it. */
async function drive(answers: Array<() => Response | Promise<Response>>, deadlineAt?: string) {
  const bodies: unknown[] = [];
  const sleeps: number[] = [];
  let channel: ProxyJoinChannel | undefined;
  const done = new Promise<void>((resolve) => {
    let call = 0;
    channel = new ProxyJoinChannel({
      // As every launcher sets WARDBY_PROXY_URL: no trailing slash.
      proxyBaseUrl: "http://wardby-proxy:8787",
      capability: "rrp_fake_capability",
      ...(deadlineAt ? { deadlineAt } : {}),
      fetchImpl: (async (url: string, init: RequestInit) => {
        expect(url).toBe(`http://wardby-proxy:8787/${JOIN_POLL_ROUTE}`);
        expect((init.headers as Record<string, string>)["x-api-key"]).toBe("rrp_fake_capability");
        bodies.push(JSON.parse(init.body as string));
        const next = answers[call++];
        if (!next) {
          resolve();
          return new Promise<Response>(() => undefined);
        }
        return next();
      }) as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
    });
  });
  const { log, sink } = events();
  channel?.start(sink);
  await done;
  channel?.stop();
  return { bodies, sleeps, log };
}

describe("joinPollUrl", () => {
  it("joins the route with exactly one slash, with or without a trailing slash on the base", () => {
    expect(joinPollUrl("http://wardby-proxy:8787")).toBe(`http://wardby-proxy:8787/${JOIN_POLL_ROUTE}`);
    expect(joinPollUrl("http://wardby-proxy:8787/")).toBe(`http://wardby-proxy:8787/${JOIN_POLL_ROUTE}`);
  });
});

describe("ProxyJoinChannel", () => {
  it("waits between polls while nobody is joined, and polls straight away while someone is", async () => {
    const { bodies, sleeps, log } = await drive([
      () => Response.json({ joined: false, messages: [] }),
      () => Response.json({ joined: true, messages: [] }),
      () => Response.json({ joined: true, messages: [{ seq: 4, text: "hi", interrupt: false }] }),
      () => Response.json({ joined: false, messages: [{ seq: 5, text: "stop", interrupt: true }] }),
    ]);
    expect(bodies).toEqual([
      { after: 0, joined: false },
      { after: 0, joined: false },
      { after: 0, joined: true },
      { after: 4, joined: true },
      { after: 5, joined: false },
    ]);
    expect(sleeps).toEqual([IDLE_POLL_MS]);
    expect(log).toEqual([
      ["joined", true],
      ["message", { text: "hi", interrupt: false, seq: 4 }],
      ["message", { text: "stop", interrupt: true, seq: 5 }],
      ["joined", false],
    ]);
  });

  it("backs off after a failed poll and keeps going", async () => {
    const { sleeps, log } = await drive([
      () => {
        throw new Error("network down");
      },
      () => new Response("nope", { status: 502 }),
      () => Response.json({ joined: "maybe", messages: [] }),
      () => Response.json({ joined: true, messages: [] }),
    ]);
    expect(sleeps).toEqual([2_000, 5_000, 5_000]);
    expect(log).toEqual([["joined", true]]);
  });

  it("stops for good when the proxy says join is unavailable", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "join_unavailable" }, { status: 404 }));
    const channel = new ProxyJoinChannel({
      proxyBaseUrl: "http://wardby-proxy:8787/",
      capability: "rrp_fake_capability",
      fetchImpl: fetchImpl,
      sleep: async () => undefined,
    });
    channel.start(events().sink);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not poll past the deadline margin", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ joined: false, messages: [] }));
    const channel = new ProxyJoinChannel({
      proxyBaseUrl: "http://wardby-proxy:8787/",
      capability: "rrp_fake_capability",
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
      fetchImpl: fetchImpl,
    });
    channel.start(events().sink);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("parseJoinPollAnswer", () => {
  it("accepts only the expected shape", () => {
    expect(parseJoinPollAnswer({ joined: true, messages: [] })).toEqual({ joined: true, messages: [] });
    for (const bad of [
      null,
      { joined: 1, messages: [] },
      { joined: true },
      { joined: true, messages: [{ seq: 0, text: "x", interrupt: false }] },
      { joined: true, messages: [{ seq: 1, text: 2, interrupt: false }] },
    ]) {
      expect(parseJoinPollAnswer(bad)).toBeNull();
    }
  });
});
