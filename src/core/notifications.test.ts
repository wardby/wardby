import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import { FakeChatProvider } from "../providers/chat/fake.js";
import { installWorkflowEventRecorder, startNotifications } from "./notifications.js";
import { emitWorkflowEvent, setWorkflowEventSink } from "./workflow-events.js";

afterEach(() => {
  setWorkflowEventSink(null);
  vi.useRealTimers();
});

function fakeDb(): { db: PrismaClient; findUnique: ReturnType<typeof vi.fn> } {
  const findUnique = vi.fn(async () => null);
  const db = { workflowEvent: { findUnique } } as unknown as PrismaClient;
  return { db, findUnique };
}

describe("installWorkflowEventRecorder", () => {
  it("with no chat provider, skips an event that no run hook could take (no agent)", async () => {
    const { db, findUnique } = fakeDb();
    installWorkflowEventRecorder(db, {});
    await emitWorkflowEvent({
      dedupeKey: "test:2",
      payload: { kind: "issue_picked_up", agentName: "a", trigger: "t" },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("with no chat provider, still records for run hooks: an agent's event is looked up", async () => {
    const { db, findUnique } = fakeDb();
    installWorkflowEventRecorder(db, {});
    await emitWorkflowEvent({
      dedupeKey: "test:4",
      agentId: "a1",
      payload: { kind: "issue_picked_up", agentName: "a", trigger: "t" },
    });
    expect(findUnique).toHaveBeenCalled();
  });

  it("installs the recorder sink when a chat provider is configured", async () => {
    const { db, findUnique } = fakeDb();
    installWorkflowEventRecorder(db, { slack: new FakeChatProvider() });
    await emitWorkflowEvent({
      dedupeKey: "test:3",
      payload: { kind: "issue_picked_up", agentName: "a", trigger: "t" },
    });
    expect(findUnique).toHaveBeenCalled();
  });
});

describe("startNotifications", () => {
  it("with no chat provider configured: returns a handle and starts no dispatcher", async () => {
    const { db, findUnique } = fakeDb();

    const handle = await startNotifications({ db, chat: {} });
    expect(handle.stop).toBeTypeOf("function");
    handle.stop();

    await emitWorkflowEvent({
      dedupeKey: "test:1",
      payload: { kind: "issue_picked_up", agentName: "a", trigger: "t" },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("starts the dispatcher immediately, without waiting on the auth check, and stop() clears its interval", async () => {
    vi.useFakeTimers();
    const { db } = fakeDb();
    const slack = new FakeChatProvider();
    let resolveAuth!: (who: { team: string; botUserId: string }) => void;
    const authTestSpy = vi
      .spyOn(slack, "authTest")
      .mockImplementation(() => new Promise((resolve) => (resolveAuth = resolve)));

    const handle = await startNotifications({ db, chat: { slack }, holder: "test-holder" });

    // The dispatcher is already running even though authTest has not
    // resolved yet - a slow/unreachable Slack must never delay startup.
    expect(authTestSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    resolveAuth({ team: "fake", botUserId: "UFAKE" });
    await Promise.resolve();
    await Promise.resolve();
    expect(authTestSpy).toHaveResolved();

    handle.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs the auth check failure in the background but still starts the dispatcher (never fatal, never blocking)", async () => {
    vi.useFakeTimers();
    const { db } = fakeDb();
    const slack = new FakeChatProvider();
    const { ChatError } = await import("../providers/chat/types.js");
    slack.failNext("authTest", new ChatError("auth_failed", "invalid_auth"));

    const handle = await startNotifications({ db, chat: { slack } });
    expect(handle.stop).toBeTypeOf("function");
    // The dispatcher started without waiting for the (failed) auth check.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Let the background authTest rejection settle before the test ends.
    await Promise.resolve();
    await Promise.resolve();

    handle.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
