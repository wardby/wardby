// Runs up.sh's WARDBY_RUN_STEPS / RUN_STEP_RETENTION_DAYS check and env injection under bash,
// and against the real rendered overlays: unset changes nothing, a set variable lands in exactly
// the containers that read it.
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
const check = section("WARDBY_RUN_STEPS and RUN_STEP_RETENTION_DAYS check");
const inject = section("WARDBY_RUN_STEPS and RUN_STEP_RETENTION_DAYS env");
const overlayDir = (name) => fileURLToPath(new URL(`../kind-coding/manifests/overlays/${name}`, import.meta.url));

const run = (input, env) =>
  spawnSync("bash", ["-c", `set -euo pipefail\n${check}\n${inject}\nprintf '%s' "$RENDERED" | inject_run_steps_env`], {
    env: { PATH: process.env.PATH, RENDERED: input, ...env },
    encoding: "utf8",
  });

const render = (name) => {
  const result = spawnSync("kubectl", ["kustomize", overlayDir(name)], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(`kubectl kustomize failed: ${result.stderr}`);
  return result.stdout;
};

// The env names in each Deployment's container, split on the Deployment documents.
const envOf = (manifest, deployment) => {
  const doc = manifest
    .split(/^---$/m)
    .find((d) => /^kind: Deployment$/m.test(d) && new RegExp(`^  name: ${deployment}$`, "m").test(d));
  return [...doc.matchAll(/- name: (\S+)\n\s+value: (.*)/g)].map((m) => [m[1], m[2]]);
};
const entries = (manifest, deployment, name) => envOf(manifest, deployment).filter(([n]) => n === name);

const hasKubectl = spawnSync("kubectl", ["version", "--client"]).status === 0;

describe("deploy/gke/up.sh run-steps settings", () => {
  it("has both sections and pipes the render through the injection", () => {
    expect(check).toContain("WARDBY_RUN_STEPS");
    expect(inject).toContain("inject_run_steps_env()");
    expect(script).toContain("| inject_run_steps_env \\");
  });

  it("refuses a bad WARDBY_RUN_STEPS", () => {
    for (const value of ["on", "DETAIL", "full", "1"]) {
      const result = run("", { WARDBY_RUN_STEPS: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`up.sh: WARDBY_RUN_STEPS must be off, summary or detail (got "${value}").`);
    }
  });

  it("refuses a bad RUN_STEP_RETENTION_DAYS", () => {
    for (const value of ["0", "3651", "-1", "1.5", "ten", "07", "10000"]) {
      const result = run("", { RUN_STEP_RETENTION_DAYS: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `up.sh: RUN_STEP_RETENTION_DAYS must be a whole number of days between 1 and 3650 (got "${value}").`,
      );
    }
  });

  it("accepts the edges and says what it will do", () => {
    for (const value of ["1", "3650"]) {
      expect(run("", { RUN_STEP_RETENTION_DAYS: value }).status).toBe(0);
    }
    for (const value of ["off", "summary", "detail"]) {
      const result = run("", { WARDBY_RUN_STEPS: value });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`up.sh: run steps are recorded at most at ${value}.`);
    }
  });

  it.skipIf(!hasKubectl).each(["gke-autopilot", "gke-autopilot-low-power"])(
    "%s: unset or empty leaves the manifest byte-identical",
    (overlay) => {
      const manifest = render(overlay);
      for (const env of [{}, { WARDBY_RUN_STEPS: "", RUN_STEP_RETENTION_DAYS: "" }]) {
        const result = run(manifest, env);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(manifest);
      }
    },
  );

  it.skipIf(!hasKubectl).each(["gke-autopilot", "gke-autopilot-low-power"])(
    "%s: the ceiling lands once in the control plane, proxy and gateway",
    (overlay) => {
      const manifest = render(overlay);
      const out = run(manifest, { WARDBY_RUN_STEPS: "detail" }).stdout;
      for (const deployment of ["wardby-control-plane", "wardby-coding-proxy", "wardby-native-gateway"]) {
        expect(entries(out, deployment, "WARDBY_RUN_STEPS")).toEqual([["WARDBY_RUN_STEPS", '"detail"']]);
      }
      expect(out.match(/name: WARDBY_RUN_STEPS$/gm)).toHaveLength(3);
      expect(out).not.toContain("RUN_STEP_RETENTION_DAYS");
    },
  );

  it.skipIf(!hasKubectl).each(["gke-autopilot", "gke-autopilot-low-power"])(
    "%s: retention lands only in the control plane and gateway",
    (overlay) => {
      const manifest = render(overlay);
      const out = run(manifest, { RUN_STEP_RETENTION_DAYS: "14" }).stdout;
      for (const deployment of ["wardby-control-plane", "wardby-native-gateway"]) {
        expect(entries(out, deployment, "RUN_STEP_RETENTION_DAYS")).toEqual([["RUN_STEP_RETENTION_DAYS", '"14"']]);
      }
      expect(entries(out, "wardby-coding-proxy", "RUN_STEP_RETENTION_DAYS")).toEqual([]);
      expect(out.match(/name: RUN_STEP_RETENTION_DAYS$/gm)).toHaveLength(2);
      expect(out).not.toMatch(/name: WARDBY_RUN_STEPS$/m);
    },
  );
});
