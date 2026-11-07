// Runs up.sh's pin_kubeconfig section under bash with a fake kubectl that logs
// the KUBECONFIG each call sees: after step 2, later calls must read a private
// one-cluster copy of KUBE_CONTEXT (mode 0600), even when the shared config's
// current context changes mid-run, and the copy must be gone when up.sh exits.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(fileURLToPath(new URL("./up.sh", import.meta.url)), "utf8");
const start = "# --- pin_kubeconfig ---";
const end = "# --- end pin_kubeconfig ---";
const section = script.slice(script.indexOf(start), script.indexOf(end) + end.length);

const CONTEXT = "gke_example-project_us-central1_example-cluster";

/** A kubectl that logs "<KUBECONFIG> <args>" and prints a fake one-cluster config for `config view`. */
function fakeKubectl() {
  const dir = mkdtempSync(join(tmpdir(), "pin-kubeconfig-"));
  const log = join(dir, "calls.log");
  const kubectl = join(dir, "kubectl");
  writeFileSync(
    kubectl,
    [
      "#!/bin/sh",
      `printf '%s %s\\n' "\${KUBECONFIG:-unset}" "$*" >>'${log}'`,
      'if [ "$1 $2" = "config view" ]; then printf "current-context: %s\\n" "$6"; fi',
      "",
    ].join("\n"),
  );
  chmodSync(kubectl, 0o755);
  return { dir, log };
}

function run() {
  const { dir, log } = fakeKubectl();
  const shared = join(dir, "shared-config");
  writeFileSync(shared, "current-context: some-other-cluster\n");
  const body = [
    "set -euo pipefail",
    section,
    // What another terminal does mid-deploy: switch the shared config's context.
    `printf 'current-context: wrong-cluster\\n' >'${shared}'`,
    "kubectl -n wardby-coding get deploy",
    'printf "%s\\n" "$PINNED_KUBECONFIG"',
    'stat -f %Lp "$PINNED_KUBECONFIG" 2>/dev/null || stat -c %a "$PINNED_KUBECONFIG"',
    'cat "$PINNED_KUBECONFIG"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", body], {
    env: { PATH: `${dir}:${process.env.PATH}`, KUBECONFIG: shared, KUBE_CONTEXT: CONTEXT },
    encoding: "utf8",
  });
  return { result, calls: readFileSync(log, "utf8").trim().split("\n"), shared };
}

describe("deploy/gke/up.sh pin_kubeconfig", () => {
  it("sits in step 2, right after use-context and before any other kubectl call", () => {
    expect(section).toContain('export KUBECONFIG="$PINNED_KUBECONFIG"');
    const useContext = script.indexOf('kubectl config use-context "$KUBE_CONTEXT"');
    expect(useContext).toBeGreaterThan(-1);
    expect(script.indexOf(start)).toBeGreaterThan(useContext);
    const between = script.slice(useContext, script.indexOf(start));
    expect(between.trim().split("\n")).toHaveLength(1);
    const before = script.slice(0, useContext);
    expect(before).not.toMatch(/^\s*(kubectl|helm) (?!config use-context)/m);
  });

  it("points later kubectl calls at a private 0600 copy of KUBE_CONTEXT, then removes it", () => {
    const { result, calls, shared } = run();
    expect(result.status, result.stderr).toBe(0);
    const [pinned, mode, ...config] = result.stdout.trim().split("\n");

    // The copy is made from the shared config, for this context only.
    expect(calls[0]).toBe(`${shared} config view --minify --flatten --context ${CONTEXT}`);
    // The later call reads the copy, not the shared config whose context changed.
    expect(calls[1]).toBe(`${pinned} -n wardby-coding get deploy`);
    expect(pinned).not.toBe(shared);
    expect(mode).toBe("600");
    expect(config).toEqual([`current-context: ${CONTEXT}`]);
    // Removed on exit; the shared config is left as the other terminal set it.
    expect(existsSync(pinned)).toBe(false);
    expect(readFileSync(shared, "utf8")).toBe("current-context: wrong-cluster\n");
  });
});
