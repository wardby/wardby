// Runs up.sh's CODING_BASH_DEFAULT_TIMEOUT_MS / CODING_BASH_MAX_TIMEOUT_MS check and the
// control-plane env injection under bash: unset leaves the render alone, valid values add their env
// entries after WARDBY_MOBILE_ENABLED, anything else stops the deploy.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(fileURLToPath(new URL("./up.sh", import.meta.url)), "utf8");
const section = (name) => {
  const start = `# --- ${name} ---`;
  const end = `# --- end ${name} ---`;
  return script.slice(script.indexOf(start), script.indexOf(end) + end.length);
};
const check = section("CODING_BASH timeouts check");
const inject = section("CODING_BASH timeouts control-plane env");

const RENDERED = [
  "      containers:",
  "        - name: control-plane",
  "          env:",
  "            - name: WARDBY_MOBILE_ENABLED",
  "              value: wardby_mobile_enabled",
  "            - name: NODE_ENV",
  "              value: production",
  "",
].join("\n");

const render = (env) =>
  spawnSync(
    "bash",
    ["-c", `set -euo pipefail\n${check}\n${inject}\nprintf '%s' "$RENDERED" | inject_coding_bash_timeouts_env`],
    { env: { PATH: process.env.PATH, RENDERED, ...env }, encoding: "utf8" },
  );

describe("deploy/gke/up.sh CODING_BASH_DEFAULT_TIMEOUT_MS and CODING_BASH_MAX_TIMEOUT_MS", () => {
  it("has both sections and pipes the render through the injection", () => {
    expect(check).toContain("CODING_BASH_MAX_TIMEOUT_MS");
    expect(inject).toContain("inject_coding_bash_timeouts_env()");
    expect(script).toContain("| inject_coding_bash_timeouts_env \\");
  });

  it("leaves the render alone when both are unset or empty", () => {
    for (const env of [{}, { CODING_BASH_DEFAULT_TIMEOUT_MS: "", CODING_BASH_MAX_TIMEOUT_MS: "" }]) {
      const result = render(env);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(RENDERED);
    }
  });

  it("adds both entries after WARDBY_MOBILE_ENABLED, in its indentation", () => {
    const result = render({ CODING_BASH_DEFAULT_TIMEOUT_MS: "900000", CODING_BASH_MAX_TIMEOUT_MS: "1800000" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CODING_BASH_DEFAULT_TIMEOUT_MS is 900000 ms");
    expect(result.stdout).toContain(
      [
        "              value: wardby_mobile_enabled",
        "            - name: CODING_BASH_DEFAULT_TIMEOUT_MS",
        '              value: "900000"',
        "            - name: CODING_BASH_MAX_TIMEOUT_MS",
        '              value: "1800000"',
        "            - name: NODE_ENV",
      ].join("\n"),
    );
  });

  it("adds only the one that is set", () => {
    const result = render({ CODING_BASH_MAX_TIMEOUT_MS: "7200000" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('- name: CODING_BASH_MAX_TIMEOUT_MS\n              value: "7200000"');
    expect(result.stdout).not.toContain("CODING_BASH_DEFAULT_TIMEOUT_MS");
  });

  it("refuses a value that is not whole milliseconds between 1000 and 7200000, naming the variable", () => {
    for (const name of ["CODING_BASH_DEFAULT_TIMEOUT_MS", "CODING_BASH_MAX_TIMEOUT_MS"]) {
      for (const value of ["abc", "999", "7200001", "0600000", "1.5", "1e6", "-1000", "60s"]) {
        const result = render({ [name]: value });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${name} must be a whole number of milliseconds between 1000 and 7200000`);
      }
    }
  });
});
