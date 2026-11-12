// WARDBY_LOW_POWER in deploy/gke/up.sh and deploy/kind-coding/up.sh: each script's own mode
// selection (the block between its "# low-power mode selection" markers) runs under bash, and
// its pre-apply block and off-mode undo run against a fake kubectl that records what it was
// asked to do.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const block = (script, marker) => {
  const start = script.indexOf(`# ${marker}\n`);
  const end = script.indexOf(`# end ${marker}\n`, start);
  return { start, text: start < 0 || end < 0 ? "" : script.slice(start, end) };
};

// `fake` is extra shell run by the fake kubectl after it records the call (its args are "$@").
function runBlock(text, env, prelude = "", fake = "") {
  const bin = mkdtempSync(join(tmpdir(), "fake-kubectl-"));
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh\necho "$*" >> '${log}'\n${fake}\n`);
  chmodSync(join(bin, "kubectl"), 0o755);
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${prelude}\n${text}\necho "overlay=$OVERLAY"`], {
    env: { PATH: `${bin}:${process.env.PATH}`, ...env },
    encoding: "utf8",
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  return { ...result, calls };
}

const scripts = [
  {
    name: "deploy/gke/up.sh",
    script: read("./up.sh"),
    overlays: { off: "overlays/gke-autopilot", on: "overlays/gke-autopilot-low-power" },
    undo: 'kubectl -n "$NAMESPACE" delete role/wardby-power rolebinding/wardby-power --ignore-not-found',
    undoCall: "-n wardby-coding delete role/wardby-power rolebinding/wardby-power --ignore-not-found",
    kubectlPrefix: "-n wardby-coding",
    // The Deployments the pre-apply block stamps; the renderer is GKE-only (an optional target, skipped when absent).
    stamped: ["wardby-coding-proxy", "wardby-native-gateway", "wardby-renderer"],
    // Off mode drops the control plane's HPA before the apply, so it cannot rescale what the apply sets.
    offPreApplyCalls: ["-n wardby-coding delete hpa/wardby-control-plane --ignore-not-found"],
    apply: 'echo "$OVERLAY_MANIFEST" | kubectl apply -f -',
    prelude: "NAMESPACE=wardby-coding",
    banner: /echo "==> 10\/\$\{TOTAL_STEPS\} render and apply the overlay \(low-power mode: \$\{LOW_POWER_LABEL\}\)"/,
    firstAction: "terraform -chdir",
  },
  {
    name: "deploy/kind-coding/up.sh",
    script: read("../kind-coding/up.sh"),
    overlays: { off: "overlays/kind", on: "overlays/kind-low-power" },
    undo: 'kubectl --context "$KUBE_CONTEXT" -n wardby-coding delete role/wardby-power rolebinding/wardby-power --ignore-not-found',
    undoCall:
      "--context kind-wardby -n wardby-coding delete role/wardby-power rolebinding/wardby-power --ignore-not-found",
    kubectlPrefix: "--context kind-wardby -n wardby-coding",
    stamped: ["wardby-coding-proxy", "wardby-native-gateway"],
    offPreApplyCalls: [],
    apply: 'kubectl kustomize "$OVERLAY" \\',
    prelude: 'KUBE_CONTEXT=kind-wardby\nMANIFEST_DIR="deploy/kind-coding"',
    banner: /echo "==> 8\/\$\{TOTAL_STEPS\} render and apply the manifests \(low-power mode: \$\{LOW_POWER_LABEL\}\)"/,
    firstAction: 'echo "==> 1/',
  },
];

describe.each(scripts)("$name WARDBY_LOW_POWER", (s) => {
  const selection = block(s.script, "low-power mode selection");
  const undo = block(s.script, "low-power undo");
  const preApply = block(s.script, "low-power pre-apply");
  const applyAt = s.script.indexOf(s.apply);
  const select = (env) => runBlock(selection.text, env, s.prelude);

  it("validates the mode before doing anything", () => {
    expect(selection.start).toBeGreaterThan(0);
    expect(selection.start).toBeLessThan(s.script.indexOf(s.firstAction));
  });

  it("selects the plain overlay when unset or 0", () => {
    expect(select({}).stdout).toContain(`overlay=deploy/kind-coding/manifests/${s.overlays.off}\n`);
    expect(select({ WARDBY_LOW_POWER: "0" }).stdout).toContain(
      `overlay=deploy/kind-coding/manifests/${s.overlays.off}\n`,
    );
  });

  it("selects the low-power overlay when 1", () => {
    expect(select({ WARDBY_LOW_POWER: "1" }).stdout).toContain(
      `overlay=deploy/kind-coding/manifests/${s.overlays.on}\n`,
    );
  });

  it.each(["2", "true", "yes", "on", " 1", "1 "])("refuses WARDBY_LOW_POWER=%j", (value) => {
    const result = select({ WARDBY_LOW_POWER: value });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("overlay=");
    expect(result.stderr).toMatch(/WARDBY_LOW_POWER must be 0 or 1/);
  });

  it("applies the selected overlay, and prints the mode in the apply step's banner", () => {
    expect(s.script).toMatch(s.banner);
    expect(s.script).toMatch(/kubectl kustomize "\$OVERLAY"/);
  });

  describe("before the apply", () => {
    const deployments = s.stamped;
    // `get ... -o name` prints the Deployment when it exists (exit 0, empty output when not).
    const existing = 'case "$*" in *" get deploy "*) echo "deployment.apps/x" ;; esac';
    const run = (mode, fake = existing) =>
      runBlock(preApply.text, {}, `${s.prelude}\nOVERLAY=unused\nLOW_POWER=${mode}`, fake);

    it("sits between the apply step's banner and the apply itself", () => {
      expect(applyAt).toBeGreaterThan(0);
      expect(preApply.start).toBeGreaterThan(s.script.search(s.banner));
      expect(preApply.start).toBeLessThan(applyAt);
    });

    // Both modes stamp: when switching low-power OFF, the control plane still
    // running is in low-power mode and would otherwise sleep the targets the
    // apply has just restored.
    describe.each([
      ["low-power mode", 1],
      ["off mode", 0],
    ])("in %s", (_label, mode) => {
      it("stamps both Deployments as just woken (a Date.parse-able UTC time)", () => {
        const before = Date.now() - 1000;
        const result = run(mode);
        expect(result.status).toBe(0);
        const calls = result.calls.trim().split("\n");
        expect(calls.slice(2 * deployments.length)).toEqual(mode === 0 ? s.offPreApplyCalls : []);
        deployments.forEach((name, i) => {
          expect(calls[2 * i]).toBe(`${s.kubectlPrefix} get deploy ${name} --ignore-not-found -o name`);
          const match = calls[2 * i + 1].match(
            new RegExp(`^${s.kubectlPrefix} annotate deploy/${name} wardby\\.io/power-woke-at=(\\S+) --overwrite$`),
          );
          expect(match).not.toBeNull();
          expect(match[1]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
          const stamped = Date.parse(match[1]);
          expect(stamped).toBeGreaterThanOrEqual(before);
          expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
        });
      });

      it("skips a Deployment that does not exist yet (first install)", () => {
        const result = run(mode, "");
        expect(result.status).toBe(0);
        expect(result.calls).not.toContain("annotate");
      });

      it("fails on any other error reading a Deployment", () => {
        const result = run(mode, 'case "$*" in *" get "*) echo "Error from server (Forbidden)" >&2; exit 1 ;; esac');
        expect(result.status).not.toBe(0);
        expect(result.calls).not.toContain("annotate");
      });

      it("fails when the annotate fails", () => {
        const result = run(mode, `${existing}\ncase "$*" in *" annotate "*) exit 1 ;; esac`);
        expect(result.status).not.toBe(0);
      });
    });
  });

  it("removes what only low-power mode applies, in off mode only, after the apply", () => {
    expect(undo.start).toBeGreaterThan(applyAt);
    expect(undo.text).toContain(s.undo);
    const prelude = `${s.prelude}\nOVERLAY=unused`;
    const off = runBlock(undo.text, { WARDBY_LOW_POWER: "0" }, `${prelude}\nLOW_POWER=0`);
    expect(off.status).toBe(0);
    expect(off.calls.trim()).toBe(s.undoCall);
    const on = runBlock(undo.text, { WARDBY_LOW_POWER: "1" }, `${prelude}\nLOW_POWER=1`);
    expect(on.status).toBe(0);
    expect(on.calls).toBe("");
  });
});

describe("deploy/kind-coding/up.sh control plane reminder", () => {
  it("tells the operator the host-run control plane needs WARDBY_LOW_POWER=1 itself", () => {
    expect(read("../kind-coding/up.sh")).toMatch(/WARDBY_LOW_POWER=1.*wardby serve/);
  });
});

describe("deploy/gke/up.sh failed always-on pods", () => {
  const script = read("./up.sh");
  const cleanup = block(script, "failed always-on pods");

  it("runs after the rollout waits and before the database checks", () => {
    expect(cleanup.start).toBeGreaterThan(script.indexOf("rollout status deploy/wardby-control-plane"));
    expect(cleanup.start).toBeLessThan(script.indexOf('echo "==> 12/'));
  });

  it("deletes only Failed pods of the three always-on Deployments, never run pods", () => {
    const result = runBlock(cleanup.text, {}, "NAMESPACE=wardby-coding\nOVERLAY=unused");
    expect(result.status).toBe(0);
    expect(result.calls.trim()).toBe(
      "-n wardby-coding delete pods --field-selector=status.phase=Failed --ignore-not-found " +
        "-l app.kubernetes.io/name in (wardby-control-plane,wardby-coding-proxy,wardby-native-gateway)",
    );
  });

  it("fails the deploy when the delete fails", () => {
    const result = runBlock(cleanup.text, {}, "NAMESPACE=wardby-coding\nOVERLAY=unused", "exit 1");
    expect(result.status).not.toBe(0);
  });
});
