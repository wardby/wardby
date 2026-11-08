// Shared by the run-steps boundary tests: does a NetworkPolicy rule admit `port`? A rule with no
// `ports`, a port entry with no `port`, the number, the named container port, or an endPort range
// that contains it all do. Per-run worker egress policies are pinned in
// src/providers/jobs/kubernetes-isolation.test.ts and src/native-worker/kubernetes-isolation.test.ts;
// the manifest tests cover the static policies.
export const RUN_STEPS_PORT = 8792;
export const RUN_STEPS_PORT_NAME = "run-steps";

export function admitsRunStepsPort(rule) {
  if (rule.ports === undefined) return true;
  return rule.ports.some((p) => {
    if (p.protocol === "UDP" || p.protocol === "SCTP") return false;
    if (p.port === undefined) return true;
    if (p.port === RUN_STEPS_PORT || p.port === RUN_STEPS_PORT_NAME) return true;
    return (
      typeof p.port === "number" && p.endPort !== undefined && p.port <= RUN_STEPS_PORT && RUN_STEPS_PORT <= p.endPort
    );
  });
}
