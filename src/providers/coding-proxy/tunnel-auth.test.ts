import { describe, expect, it } from "vitest";
import { mintMcpToken } from "../../coding/mcp-token.js";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import { deriveTunnelToken } from "../../coding/tunnel-token.js";
import { capabilityHash } from "./capability-hash.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { CodingProxy, type CreatedCodingProxySession } from "./proxy.js";
import { InMemoryTunnelAuthenticator } from "./tunnel-auth.test-support.js";
import { LedgerTunnelAuthenticator } from "./tunnel-auth.js";

async function setup(deadlineMs = 60_000) {
  const ledger = new MemoryProxyLedger();
  const proxy = new CodingProxy({
    ledger,
    credentials: { resolve: async () => "UNUSED" },
    pricing: () => ({ encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 }),
  });
  const session: CreatedCodingProxySession = await proxy.createSession({
    runId: "run-1",
    credentialRef: "openai/test",
    protocol: "openai-responses",
    allowedModels: ["test-model"],
    deadlineAt: new Date(Date.now() + deadlineMs),
    budgetUsd: 1,
  });
  return { ledger, proxy, session };
}

describe("LedgerTunnelAuthenticator", () => {
  it("accepts the tunnel token derived from the run's capability", async () => {
    const { ledger, session } = await setup();
    const result = await new LedgerTunnelAuthenticator(ledger).authenticate(deriveTunnelToken(session.capability));
    expect(result).toEqual({ ok: true, identity: { runId: "run-1", deadlineAt: session.deadlineAt } });
  });

  it("refuses every other credential of the same run", async () => {
    const { ledger, session } = await setup();
    const authenticator = new LedgerTunnelAuthenticator(ledger);
    for (const token of [
      session.capability,
      deriveRegistryToken(session.capability),
      mintMcpToken(),
      capabilityHash(deriveTunnelToken(session.capability)),
      "",
      "rtn_unknown",
    ]) {
      expect(await authenticator.authenticate(token)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("refuses a cancelled session and one past its deadline, as inactive", async () => {
    const { ledger, proxy, session } = await setup();
    const token = deriveTunnelToken(session.capability);
    const later = new LedgerTunnelAuthenticator(ledger, () => new Date(session.deadlineAt.getTime() + 1));
    expect(await later.authenticate(token)).toEqual({ ok: false, reason: "inactive" });

    await proxy.cancelSession(session.id);
    expect(await new LedgerTunnelAuthenticator(ledger).authenticate(token)).toEqual({ ok: false, reason: "inactive" });
  });

  it("reports a run active until its session is cancelled", async () => {
    const { ledger, proxy, session } = await setup();
    const authenticator = new LedgerTunnelAuthenticator(ledger);
    expect(await authenticator.isActive("run-1")).toBe(true);
    expect(await authenticator.isActive("unknown-run")).toBe(false);
    await proxy.cancelSession(session.id);
    expect(await authenticator.isActive("run-1")).toBe(false);
  });

  it("finds no tunnel token on a session created without one", async () => {
    const ledger = new MemoryProxyLedger();
    await ledger.createSession({
      id: "old",
      runId: "old-run",
      capabilityHash: "cap-hash",
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["m"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
      registryTokenHash: "registry-hash",
    });
    const authenticator = new LedgerTunnelAuthenticator(ledger);
    expect(await authenticator.authenticate("rtn_anything")).toEqual({ ok: false, reason: "invalid" });
    expect(await authenticator.isActive("old-run")).toBe(true);
  });
});

describe("InMemoryTunnelAuthenticator", () => {
  it("answers like the ledger authenticator: invalid, inactive, active", async () => {
    let now = 1_000_000;
    const fake = new InMemoryTunnelAuthenticator(() => now);
    fake.register("token", { runId: "r", deadlineAt: new Date(now + 1000) });
    expect(await fake.authenticate("token")).toMatchObject({ ok: true, identity: { runId: "r" } });
    expect(await fake.authenticate("other")).toEqual({ ok: false, reason: "invalid" });
    expect(await fake.isActive("r")).toBe(true);
    now += 2000;
    expect(await fake.authenticate("token")).toEqual({ ok: false, reason: "inactive" });
    expect(await fake.isActive("r")).toBe(false);
  });
});
