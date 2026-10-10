/**
 * The `wardby merge order` check: pure state computation from a related
 * pull request set's declared merge order (CodingRun.mergeOrder, see
 * related-pull-requests.ts). See
 * docs/private/2026-10-10-delegated-merge-order-design.md Part 3.
 *
 * For a member with order *k*, its dependencies are the set's members with
 * a strictly lower, non-null order; equal-order peers are not dependencies,
 * and a null-order member is never a dependency (and has none of its own).
 * The check is posted only when the set has more than one distinct non-null
 * order; otherwise (or when `self` itself has no order) there is nothing to
 * gate and the verdict is "skip".
 */

export const MERGE_ORDER_CHECK_NAME = "wardby merge order";

export interface MergeOrderMember {
  repository: string;
  number: number;
  mergeOrder: number | null;
  state: "open" | "draft" | "merged" | "closed";
  url?: string;
}

export type MergeOrderVerdict =
  | { status: "skip" }
  | { status: "in_progress"; waitingFor: MergeOrderMember[] }
  | { status: "success"; dependencies: MergeOrderMember[] }
  | { status: "failure"; closedUnmerged: MergeOrderMember[] };

/**
 * `self` need not be the same object instance as its entry in `set`; only
 * `mergeOrder` is read from it (dependencies are read fresh from `set`).
 */
export function mergeOrderVerdict(self: MergeOrderMember, set: readonly MergeOrderMember[]): MergeOrderVerdict {
  const distinctOrders = new Set<number>();
  for (const m of set) if (m.mergeOrder !== null) distinctOrders.add(m.mergeOrder);
  if (distinctOrders.size < 2) return { status: "skip" };
  if (self.mergeOrder === null) return { status: "skip" };

  const selfOrder = self.mergeOrder;
  const dependencies = set.filter((m) => m.mergeOrder !== null && m.mergeOrder < selfOrder);

  const closedUnmerged = dependencies.filter((m) => m.state === "closed");
  if (closedUnmerged.length > 0) return { status: "failure", closedUnmerged };

  const waitingFor = dependencies.filter((m) => m.state !== "merged");
  if (waitingFor.length > 0) return { status: "in_progress", waitingFor };

  return { status: "success", dependencies };
}
