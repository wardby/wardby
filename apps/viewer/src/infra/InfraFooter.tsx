import type { InfraModel } from "./adapter";
import { formatCpu, formatMem } from "./format";
import { plural } from "../format/text";

/** Fills the BottomBar slot while the Infrastructure tab is active. */
export function InfraFooter({ totals }: { totals: InfraModel["totals"] | null }) {
  return (
    <footer className="bottombar">
      <span className="counts">
        {totals
          ? `${plural(totals.pods, "pod")} · ${plural(totals.codingRuns, "coding run")}${totals.agentSandboxes ? ` · ${totals.agentSandboxes} agent sandbox${totals.agentSandboxes === 1 ? "" : "es"}` : ""} · ${totals.readyContainers} containers ready · requests ${formatCpu(totals.cpuMillis)} CPU / ${formatMem(totals.memoryMiB)}`
          : "No cluster data"}
      </span>
    </footer>
  );
}
