/**
 * In-memory `resourceGrant` delegate for the MCP/runner suites built on
 * fake databases. Implements exactly the query shapes core/grants.ts and
 * the grant tools use: equality or `{ in: [...] }` on top-level fields,
 * upsert on the (resourceType, resourceId, granteeKey) unique key, and
 * deleteMany/findMany/findFirst/count over the same filters.
 */
export interface FakeGrantRow {
  id: string;
  resourceType: string;
  resourceId: string;
  granteeKind: string;
  granteePrincipalId: string | null;
  granteeKey: string;
  level: string;
  source: string;
  grantedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type FakeGrantSeed = Pick<FakeGrantRow, "resourceType" | "resourceId" | "level"> &
  Partial<Omit<FakeGrantRow, "resourceType" | "resourceId" | "level">> & { principalId?: string };

type Where = Record<string, unknown> | undefined;

function matches(row: FakeGrantRow, where: Where): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, condition]) => {
    if (field === "OR") return (condition as Where[]).some((w) => matches(row, w));
    const value = (row as unknown as Record<string, unknown>)[field];
    if (condition !== null && typeof condition === "object" && "in" in (condition)) {
      return ((condition as { in: unknown[] }).in ?? []).includes(value);
    }
    if (condition !== null && typeof condition === "object" && "not" in (condition)) {
      return value !== (condition).not;
    }
    return value === condition;
  });
}

function seedRow(seed: FakeGrantSeed, n: number): FakeGrantRow {
  const everyone = seed.granteeKind === "everyone" || (!seed.principalId && !seed.granteePrincipalId);
  const principalId = seed.principalId ?? seed.granteePrincipalId ?? null;
  const now = new Date();
  return {
    id: seed.id ?? `grant_${n}`,
    resourceType: seed.resourceType,
    resourceId: seed.resourceId,
    granteeKind: everyone ? "everyone" : "principal",
    granteePrincipalId: everyone ? null : principalId,
    granteeKey: everyone ? "everyone" : `principal:${principalId}`,
    level: seed.level,
    source: seed.source ?? "owner",
    grantedById: seed.grantedById ?? null,
    createdAt: seed.createdAt ?? now,
    updatedAt: seed.updatedAt ?? now,
  };
}

/** A fake `resourceGrant` delegate plus its backing rows (exposed for assertions). */
export function fakeResourceGrants(seed: FakeGrantSeed[] = []) {
  let counter = 0;
  const rows: FakeGrantRow[] = seed.map((s) => seedRow(s, ++counter));
  const delegate = {
    rows,
    findMany: async (args: { where?: Where } = {}) => rows.filter((r) => matches(r, args.where)).map((r) => ({ ...r })),
    findFirst: async (args: { where?: Where } = {}) => {
      const row = rows.find((r) => matches(r, args.where));
      return row ? { ...row } : null;
    },
    count: async (args: { where?: Where } = {}) => rows.filter((r) => matches(r, args.where)).length,
    upsert: async (args: {
      where: { resourceType_resourceId_granteeKey: { resourceType: string; resourceId: string; granteeKey: string } };
      create: Partial<FakeGrantRow>;
      update: Partial<FakeGrantRow>;
    }) => {
      const key = args.where.resourceType_resourceId_granteeKey;
      const existing = rows.find(
        (r) =>
          r.resourceType === key.resourceType && r.resourceId === key.resourceId && r.granteeKey === key.granteeKey,
      );
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: new Date() });
        return { ...existing };
      }
      const created = {
        id: `grant_${++counter}`,
        granteePrincipalId: null,
        source: "owner",
        grantedById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.create,
      } as FakeGrantRow;
      rows.push(created);
      return { ...created };
    },
    create: async (args: { data: Partial<FakeGrantRow> }) => {
      const created = {
        id: `grant_${++counter}`,
        granteePrincipalId: null,
        source: "owner",
        grantedById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.data,
      } as FakeGrantRow;
      rows.push(created);
      return { ...created };
    },
    deleteMany: async (args: { where?: Where } = {}) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], args.where)) {
          rows.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
  };
  return delegate;
}
