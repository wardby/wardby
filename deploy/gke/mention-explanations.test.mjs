// Runs up.sh's WARDBY_MENTION_EXPLANATIONS check and the control-plane env
// injection under bash: unset or true leaves the render alone, false adds one
// env entry after WARDBY_MOBILE_ENABLED, anything else stops the deploy.
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
const check = section("WARDBY_MENTION_EXPLANATIONS check");
const inject = section("WARDBY_MENTION_EXPLANATIONS control-plane env");

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
    ["-c", `set -euo pipefail\n${check}\n${inject}\nprintf '%s' "$RENDERED" | inject_mention_explanations_env`],
    { env: { PATH: process.env.PATH, RENDERED, ...env }, encoding: "utf8" },
  );

describe("deploy/gke/up.sh WARDBY_MENTION_EXPLANATIONS", () => {
  it("has both sections and pipes the render through the injection", () => {
    expect(check).toContain("WARDBY_MENTION_EXPLANATIONS");
    expect(inject).toContain("inject_mention_explanations_env()");
    expect(script).toContain("| inject_mention_explanations_env \\");
  });

  it("leaves the render alone when unset, empty or true", () => {
    for (const env of [{}, { WARDBY_MENTION_EXPLANATIONS: "" }, { WARDBY_MENTION_EXPLANATIONS: "true" }]) {
      const result = render(env);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(RENDERED);
    }
  });

  it("adds the env entry after WARDBY_MOBILE_ENABLED, in its indentation, when false", () => {
    const result = render({ WARDBY_MENTION_EXPLANATIONS: "false" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mentions that start nothing get no explanation");
    expect(result.stdout).toContain(
      [
        "              value: wardby_mobile_enabled",
        "            - name: WARDBY_MENTION_EXPLANATIONS",
        '              value: "false"',
        "            - name: NODE_ENV",
      ].join("\n"),
    );
  });

  it("refuses a value that is not true or false", () => {
    for (const value of ["no", "0", "FALSE"]) {
      const result = render({ WARDBY_MENTION_EXPLANATIONS: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("WARDBY_MENTION_EXPLANATIONS must be true or false");
    }
  });
});
