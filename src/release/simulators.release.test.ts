/**
 * Release invariant 6 for the WARDBY_TEST_SIMULATORS switch: it is a token-exfiltration path by
 * design, so its refusals and its start-up warning must never carry a credential. A base URL
 * with userinfo is refused, and neither the refusal nor any log line holds the userinfo; with
 * the switch on, the warning names the host only, never the App key or a token.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startupTestSimulators } from "../config/test-simulators.js";
import { baseSeed } from "./seeded.test-support.js";
import { secretSweep, type SecretSweep } from "./secret-sweep.test-support.js";

const SIM_KEY = readFileSync(
  join(import.meta.dirname, "../../tools/wardby-sim/fixtures/github-app-test-key.pem"),
  "utf8",
);
const flushLogs = () => new Promise((resolve) => setImmediate(resolve));

let sweep: SecretSweep | undefined;
afterEach(() => {
  sweep?.dispose();
  sweep = undefined;
});

describe("WARDBY_TEST_SIMULATORS keeps credentials out of every output", () => {
  for (const shape of ["password", "github-token", "opaque"] as const) {
    it(`refuses userinfo in WARDBY_SIM_BASE_URL and never logs it (${shape})`, async () => {
      sweep = secretSweep(baseSeed());
      const user = sweep.plant("user", "opaque");
      const password = sweep.plant("password", shape);
      const base = `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:8080`;
      let refused: unknown;
      try {
        startupTestSimulators("release-test", { WARDBY_TEST_SIMULATORS: "1", WARDBY_SIM_BASE_URL: base });
      } catch (error) {
        refused = error;
      }
      expect((refused as Error).message).toBe("test_simulators_refused:base_url_credentials");
      sweep.record("refusal", refused);
      await flushLogs();
      sweep.assertClean();
    });
  }

  it("with the switch on, warns once naming the host only", async () => {
    sweep = secretSweep(baseSeed());
    const slack = sweep.track("slack", `xoxb-sim-${sweep.plant("slack-tail", "opaque")}`);
    const jira = sweep.track("jira", `sim-${sweep.plant("jira-tail", "opaque")}`);
    const oauth = sweep.track("oauth", `sim-${sweep.plant("oauth-tail", "opaque")}`);
    // The private key's body, without its PEM armour, as one tracked value.
    sweep.track("app-key", SIM_KEY.split("\n").slice(1, 4).join(""));
    const simulators = startupTestSimulators("release-test", {
      WARDBY_TEST_SIMULATORS: "1",
      WARDBY_SIM_BASE_URL: "https://wardby-sim.wardby-sim.svc:8443",
      GITHUB_APP_PRIVATE_KEY: SIM_KEY,
      GITHUB_APP_CLIENT_SECRET: oauth,
      WARDBY_SLACK_BOT_TOKEN: slack,
      WARDBY_JIRA_API_TOKEN: jira,
    });
    expect(simulators?.host).toBe("wardby-sim.wardby-sim.svc:8443");
    sweep.record("simulators", { origin: simulators?.origin, base: simulators?.base("slack") });
    await flushLogs();
    sweep.assertClean();
  });
});
