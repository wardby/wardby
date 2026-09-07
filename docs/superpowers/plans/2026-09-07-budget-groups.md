# Daily/Weekly/Monthly Budget Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional daily/weekly/monthly spend caps across a *group* of agents, layered on top of the existing per-run `Agent.budgetUsd` cap (which stays required and unchanged), so a set of agents can share a recurring budget instead of only ever being bounded run-by-run.

**Architecture:** A new `BudgetGroup` model with a nullable `Agent.budgetGroupId` (an agent belongs to at most one group). A new pure-ish module, `src/core/budget-groups.ts`, computes calendar-aligned-UTC period windows and a group's live spend within them by summing `Run.costUsd`. The key design decision: enforcement is **not** a separate refuse-at-creation gate. Instead, `runner.ts`'s `executeRun` computes an *effective* per-run budget — the agent's own `budgetUsd`, tightened to whatever's left of its group's daily/weekly/monthly caps — and hands that to the engine in place of the raw `budgetUsd`. The engine's existing turn-by-turn machinery (pre-flight refuse, mid-stream cutoff, graceful wind-down in `src/core/engine-native.ts`) then enforces it with **zero changes of its own**: a group whose period budget is already exhausted simply produces an effective budget of `0`, which the engine's existing turn-1 refuse path already handles (`isOverBudget(0, 0)` is `true`, same as any other exhausted-budget agent). This also closes the "in-flight run invisible to the period check" gap that a create-time-only check would have: the tightened budget applies to the run *itself*, live, via the same mechanism that already protects any single run.

**Tech Stack:** TypeScript, Prisma 6 + PostgreSQL, Zod, Vitest.

**Spec:** No standalone spec doc — this plan implements the design worked out directly with the user in conversation (2026-09-07): budget groups are the chosen scope unit (not per-agent, not per-owner-across-everything); calendar-aligned UTC periods (not rolling windows); an agent belongs to at most one group; period caps live only on the group (not duplicated per-agent); enforcement warns at a per-group-configurable threshold and hard-blocks by tightening the run's own effective budget rather than a separate gate.

## Global Constraints

- **CLAUDE.md Prisma rules are strict:** the migration is hand-written and additive only. Run the drift check (`prisma migrate diff` against an empty shadow DB) after Task 1 and again at the end (Task 7) — it must come back as `-- This is an empty migration.`
- Follow this schema's existing `Decimal`-with-`@db.Decimal(p, s)` convention for money fields (see `Agent.budgetUsd @db.Decimal(10, 4)`), not floating point.
- Follow the existing ownership convention throughout (`src/mcp/auth/ownership.ts`): `ownerId: String?` nullable owner column, `null` = public/readable-by-anyone, mutation always requires real ownership. Do not invent a different pattern for `BudgetGroup`.
- Every new/changed file gets tests in the same task that changes it; no task is "done" until its own tests pass.
- Run `npm run typecheck && npm run lint && npm run format:check` before every commit in this plan — this repo has both wired into CI as of 2026-09-07 and a failing check blocks merge.

---

## Task 1: `BudgetGroup` schema + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260907020000_budget_groups/migration.sql`

**Interfaces:**
- Produces: Prisma Client types `BudgetGroup`, and `Agent.budgetGroupId: string | null`, `Agent.budgetGroup?: BudgetGroup | null`. Every later task depends on these existing on the generated client.

- [ ] **Step 1: Add the `BudgetGroup` model to `prisma/schema.prisma`, right after the `Agent` model's closing brace (before `enum AgentKind`)**

```prisma
/// Phase 7: an optional recurring spend cap across a group of agents,
/// layered on top of each agent's own per-run budgetUsd (which stays
/// required and unchanged). All three period caps are independently
/// optional -- unset means "no cap for that period." warnThresholdRatio
/// is per-group so different groups can choose their own early-warning
/// point; enforcement itself never lives here -- see
/// src/core/budget-groups.ts and runner.ts's executeRun, which turn a
/// group's remaining period budget into a tightened *effective* per-run
/// budget the existing engine budget machinery enforces unchanged.
model BudgetGroup {
  id                 String     @id @default(cuid())
  name               String
  ownerId            String?
  owner              Principal? @relation(fields: [ownerId], references: [id])
  dailyBudgetUsd     Decimal?   @db.Decimal(10, 4)
  weeklyBudgetUsd    Decimal?   @db.Decimal(10, 4)
  monthlyBudgetUsd   Decimal?   @db.Decimal(10, 4)
  warnThresholdRatio Decimal    @default(0.8) @db.Decimal(3, 2)
  createdAt          DateTime   @default(now())
  updatedAt          DateTime   @updatedAt
  agents             Agent[]

  @@unique([ownerId, name])
}
```

- [ ] **Step 2: Add the owning-Principal back-relation. In the `Principal` model, add a line after `webhooks  Webhook[]`**

```prisma
  budgetGroups BudgetGroup[]
```

- [ ] **Step 3: Add the FK + relation to `Agent`. In the `Agent` model, immediately after the existing ownership block (`owner    Principal?    @relation(fields: [ownerId], references: [id])` / `secrets  AgentSecret[]` / `webhooks Webhook[]`), add**

```prisma

  // Phase 7: at most one budget group. Null = uncapped beyond its own budgetUsd.
  budgetGroupId String?
  budgetGroup   BudgetGroup? @relation(fields: [budgetGroupId], references: [id])
```

- [ ] **Step 4: Hand-write the migration SQL at `prisma/migrations/20260907020000_budget_groups/migration.sql`**

```sql
-- Optional recurring (daily/weekly/monthly) spend caps across a group of
-- agents, layered on top of each agent's existing per-run budgetUsd.
-- Additive only: a new table plus one new nullable column on Agent.
CREATE TABLE "BudgetGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT,
    "dailyBudgetUsd" DECIMAL(10,4),
    "weeklyBudgetUsd" DECIMAL(10,4),
    "monthlyBudgetUsd" DECIMAL(10,4),
    "warnThresholdRatio" DECIMAL(3,2) NOT NULL DEFAULT 0.8,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BudgetGroup_ownerId_name_key" ON "BudgetGroup"("ownerId", "name");

ALTER TABLE "BudgetGroup" ADD CONSTRAINT "BudgetGroup_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Principal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Agent" ADD COLUMN "budgetGroupId" TEXT;

ALTER TABLE "Agent" ADD CONSTRAINT "Agent_budgetGroupId_fkey" FOREIGN KEY ("budgetGroupId") REFERENCES "BudgetGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 5: Apply locally and regenerate the client**

```bash
npm run db:up
docker exec -i local-postgres-1 psql -U reevo -d reevo < prisma/migrations/20260907020000_budget_groups/migration.sql
npx prisma migrate resolve --applied 20260907020000_budget_groups
npx prisma generate
```

- [ ] **Step 6: Run the required drift check (CLAUDE.md)**

```bash
docker exec local-postgres-1 psql -U reevo -d reevo -c "DROP DATABASE IF EXISTS reevo_shadow;" -c "CREATE DATABASE reevo_shadow;"
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://reevo:reevo@localhost:55432/reevo_shadow" \
  --script
docker exec local-postgres-1 psql -U reevo -d reevo -c "DROP DATABASE IF EXISTS reevo_shadow;"
```

Expected output: exactly `-- This is an empty migration.` If anything else prints, the schema and migration disagree — fix `schema.prisma` (usually a missing `@@unique`/relation annotation) before continuing, and re-run this step.

- [ ] **Step 7: `npx prisma validate`, then commit**

```bash
npx prisma validate
git add prisma/schema.prisma prisma/migrations/20260907020000_budget_groups
git commit -m "$(cat <<'EOF'
feat(db): add BudgetGroup model for daily/weekly/monthly spend caps

New table, one new nullable Agent.budgetGroupId column -- additive
only. An agent belongs to at most one group; all three period caps
and the warn threshold are independently optional/configurable per
group. No enforcement logic yet -- that's core/budget-groups.ts next.
EOF
)"
```

---

## Task 2: `src/core/budget-groups.ts` — period math + live spend

**Files:**
- Create: `src/core/budget-groups.ts`
- Create: `src/core/budget-groups.test.ts`

**Interfaces:**
- Consumes: Prisma Client types `Agent`, `BudgetGroup`, `PrismaClient` from `@prisma/client`; `logger` from `./logger.js` (existing, `logger.child({module})` convention — see `src/core/scheduler.ts`'s `schedulerLog`).
- Produces (used by Task 3's `runner.ts` and Task 5's `get_budget_group` tool):
  - `export type Period = "day" | "week" | "month"`
  - `export type BudgetGroupsDb = Pick<PrismaClient, "budgetGroup" | "run">`
  - `export function periodStart(period: Period, now: Date): Date`
  - `export interface PeriodSpend { period: Period; capUsd: number; spentUsd: number; remainingUsd: number }`
  - `export async function computeGroupSpend(db: BudgetGroupsDb, group: Pick<BudgetGroup, "dailyBudgetUsd" | "weeklyBudgetUsd" | "monthlyBudgetUsd">, memberAgentIds: string[], now?: Date): Promise<PeriodSpend[]>`
  - `export interface EffectiveBudgetResult { effectiveBudgetUsd: number; constrainedBy: Period[] }`
  - `export async function effectiveBudgetForRun(db: BudgetGroupsDb, agent: Pick<Agent, "id" | "budgetGroupId" | "budgetUsd">, now?: Date): Promise<EffectiveBudgetResult>` — also logs a `logger.warn` (never throws, never blocks) when a period's spend has crossed the group's `warnThresholdRatio`.

- [ ] **Step 1: Write the failing tests for pure period math**

Create `src/core/budget-groups.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { periodStart } from "./budget-groups.js";

describe("periodStart", () => {
  it("day: truncates to UTC midnight", () => {
    expect(periodStart("day", new Date("2026-09-07T15:42:31.123Z"))).toEqual(new Date("2026-09-07T00:00:00.000Z"));
  });

  it("month: truncates to the 1st of the UTC month", () => {
    expect(periodStart("month", new Date("2026-09-07T15:42:31.123Z"))).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });

  it("week: truncates to the most recent UTC Monday 00:00 (mid-week)", () => {
    // 2026-09-09 is a Wednesday.
    expect(periodStart("week", new Date("2026-09-09T15:42:31.123Z"))).toEqual(new Date("2026-09-07T00:00:00.000Z"));
  });

  it("week: a UTC Monday truncates to itself", () => {
    expect(periodStart("week", new Date("2026-09-07T00:00:00.001Z"))).toEqual(new Date("2026-09-07T00:00:00.000Z"));
  });

  it("week: a UTC Sunday truncates to the Monday before it", () => {
    // 2026-09-13 is a Sunday; the ISO week's Monday is 2026-09-07.
    expect(periodStart("week", new Date("2026-09-13T23:59:59.000Z"))).toEqual(new Date("2026-09-07T00:00:00.000Z"));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails (module doesn't exist yet)**

Run: `npx vitest run src/core/budget-groups.test.ts`
Expected: FAIL — `Cannot find module './budget-groups.js'`

- [ ] **Step 3: Write `src/core/budget-groups.ts` (period math + `computeGroupSpend` + `effectiveBudgetForRun`)**

```ts
/**
 * Daily/weekly/monthly spend caps for a *group* of agents (BudgetGroup),
 * layered on top of each agent's own per-run Agent.budgetUsd. Unlike
 * budget.ts (pure, no DB, no network), this module queries Postgres: it
 * computes how much of a group's remaining period budget a given agent
 * should be allowed to spend on its next run, and hands back an
 * *effective* per-run budget the caller uses in place of the agent's raw
 * budgetUsd. The engine's existing turn-by-turn machinery (pre-flight
 * refuse, mid-stream cutoff, wind-down — see engine-native.ts) then
 * enforces that tightened ceiling with no changes of its own: a group
 * whose period budget is already exhausted simply produces an effective
 * budget of 0, which the engine's turn-1 gate already refuses exactly
 * like any other zero/negative budget.
 */
import type { Agent, BudgetGroup, PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

const budgetGroupLog = logger.child({ module: "budget-groups" });

export type Period = "day" | "week" | "month";

export type BudgetGroupsDb = Pick<PrismaClient, "budgetGroup" | "run">;

/**
 * Calendar-aligned UTC period start. "week" is the ISO week: Monday 00:00
 * UTC. `now`'s own time-of-day/day-of-week is truncated away, never
 * rounded up -- a period start is always <= now.
 */
export function periodStart(period: Period, now: Date): Date {
  if (period === "day") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  if (period === "month") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  // getUTCDay(): Sunday=0 .. Saturday=6. Treat Sunday as 7 so "days since
  // Monday" is always 0-6.
  const daysSinceMonday = (now.getUTCDay() || 7) - 1;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export interface PeriodSpend {
  period: Period;
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
}

/**
 * Live per-period spend for whichever of a group's daily/weekly/monthly
 * caps are actually set -- unset periods are omitted from the result, not
 * returned with a null cap. One query at the widest configured window
 * (month contains week contains day), bucketed in JS, rather than a
 * separate DB round trip per period.
 */
export async function computeGroupSpend(
  db: BudgetGroupsDb,
  group: Pick<BudgetGroup, "dailyBudgetUsd" | "weeklyBudgetUsd" | "monthlyBudgetUsd">,
  memberAgentIds: string[],
  now: Date = new Date(),
): Promise<PeriodSpend[]> {
  const caps: { period: Period; capUsd: number | null }[] = [
    { period: "day", capUsd: toNullableNumber(group.dailyBudgetUsd) },
    { period: "week", capUsd: toNullableNumber(group.weeklyBudgetUsd) },
    { period: "month", capUsd: toNullableNumber(group.monthlyBudgetUsd) },
  ];
  const configured = caps.filter((c): c is { period: Period; capUsd: number } => c.capUsd !== null);
  if (configured.length === 0 || memberAgentIds.length === 0) return [];

  const widestStart = periodStart("month", now);
  const runs = await db.run.findMany({
    where: { agentId: { in: memberAgentIds }, startedAt: { gte: widestStart } },
    select: { costUsd: true, startedAt: true },
  });

  return configured.map(({ period, capUsd }) => {
    const start = periodStart(period, now);
    const spentUsd = runs
      .filter((r) => r.startedAt >= start)
      .reduce((sum, r) => sum + Number(r.costUsd), 0);
    return { period, capUsd, spentUsd, remainingUsd: Math.max(0, capUsd - spentUsd) };
  });
}

export interface EffectiveBudgetResult {
  effectiveBudgetUsd: number;
  /** Which period(s), if any, are tighter than the agent's own budgetUsd right now. */
  constrainedBy: Period[];
}

/**
 * The per-run budget ceiling to actually use for `agent`: its own
 * budgetUsd, tightened to whatever's left of its budget group's
 * daily/weekly/monthly caps (whichever are set). An ungrouped agent (no
 * budgetGroupId), or one whose group has no caps configured, is returned
 * unchanged. Also logs a warning (never blocks, never throws) once a
 * period's spend crosses the group's own warnThresholdRatio.
 */
export async function effectiveBudgetForRun(
  db: BudgetGroupsDb,
  agent: Pick<Agent, "id" | "budgetGroupId" | "budgetUsd">,
  now: Date = new Date(),
): Promise<EffectiveBudgetResult> {
  const ownBudgetUsd = Number(agent.budgetUsd);
  if (!agent.budgetGroupId) return { effectiveBudgetUsd: ownBudgetUsd, constrainedBy: [] };

  const group = await db.budgetGroup.findUnique({
    where: { id: agent.budgetGroupId },
    include: { agents: { select: { id: true } } },
  });
  if (!group) return { effectiveBudgetUsd: ownBudgetUsd, constrainedBy: [] };

  const spend = await computeGroupSpend(
    db,
    group,
    group.agents.map((a) => a.id),
    now,
  );
  const warnThresholdRatio = Number(group.warnThresholdRatio);

  for (const s of spend) {
    if (s.spentUsd >= s.capUsd * warnThresholdRatio) {
      budgetGroupLog.warn(
        { groupId: group.id, groupName: group.name, period: s.period, capUsd: s.capUsd, spentUsd: s.spentUsd },
        `budget group "${group.name}"'s ${s.period} spend ($${s.spentUsd.toFixed(4)}) has reached ` +
          `${(warnThresholdRatio * 100).toFixed(0)}% of its $${s.capUsd.toFixed(4)} cap`,
      );
    }
  }

  const constrainedBy = spend.filter((s) => s.remainingUsd < ownBudgetUsd).map((s) => s.period);
  const effectiveBudgetUsd = Math.min(ownBudgetUsd, ...spend.map((s) => s.remainingUsd));
  return { effectiveBudgetUsd, constrainedBy };
}
```

- [ ] **Step 4: Run the period-math tests to confirm they pass**

Run: `npx vitest run src/core/budget-groups.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Add DB-mocked tests for `computeGroupSpend` and `effectiveBudgetForRun` to the same file**

Append to `src/core/budget-groups.test.ts` (add the import and the new `describe` block):

```ts
import { computeGroupSpend, effectiveBudgetForRun, type BudgetGroupsDb } from "./budget-groups.js";

interface FakeRun {
  agentId: string;
  costUsd: number;
  startedAt: Date;
}
interface FakeGroup {
  id: string;
  name: string;
  dailyBudgetUsd: number | null;
  weeklyBudgetUsd: number | null;
  monthlyBudgetUsd: number | null;
  warnThresholdRatio: number;
  agentIds: string[];
}

function fakeDb(groups: FakeGroup[], runs: FakeRun[]): BudgetGroupsDb {
  const byId = new Map(groups.map((g) => [g.id, g]));
  return {
    budgetGroup: {
      findUnique: (async ({ where }: { where: { id: string } }) => {
        const g = byId.get(where.id);
        if (!g) return null;
        return { ...g, agents: g.agentIds.map((id) => ({ id })) };
      }) as never,
    },
    run: {
      findMany: (async ({ where }: { where: { agentId: { in: string[] }; startedAt: { gte: Date } } }) =>
        runs.filter((r) => where.agentId.in.includes(r.agentId) && r.startedAt >= where.startedAt.gte)) as never,
    },
  } as unknown as BudgetGroupsDb;
}

const NOW = new Date("2026-09-09T12:00:00.000Z"); // a Wednesday
const TODAY_START = new Date("2026-09-09T00:00:00.000Z");

describe("computeGroupSpend", () => {
  it("returns nothing when the group has no caps configured", async () => {
    const db = fakeDb(
      [{ id: "g1", name: "g", dailyBudgetUsd: null, weeklyBudgetUsd: null, monthlyBudgetUsd: null, warnThresholdRatio: 0.8, agentIds: ["a1"] }],
      [],
    );
    const spend = await computeGroupSpend(db, { dailyBudgetUsd: null, weeklyBudgetUsd: null, monthlyBudgetUsd: null } as never, ["a1"], NOW);
    expect(spend).toEqual([]);
  });

  it("sums only runs within each configured period's window, per agent in the group", async () => {
    const db = fakeDb([], [
      { agentId: "a1", costUsd: 1, startedAt: TODAY_START }, // in today
      { agentId: "a2", costUsd: 2, startedAt: TODAY_START }, // in today, other member
      { agentId: "a1", costUsd: 5, startedAt: new Date("2026-09-01T00:00:00.000Z") }, // this month, not today
      { agentId: "a1", costUsd: 100, startedAt: new Date("2026-08-01T00:00:00.000Z") }, // outside the month entirely
    ]);
    const spend = await computeGroupSpend(
      db,
      { dailyBudgetUsd: 10, weeklyBudgetUsd: null, monthlyBudgetUsd: 20 } as never,
      ["a1", "a2"],
      NOW,
    );
    const byPeriod = Object.fromEntries(spend.map((s) => [s.period, s]));
    expect(byPeriod.day).toEqual({ period: "day", capUsd: 10, spentUsd: 3, remainingUsd: 7 });
    expect(byPeriod.month).toEqual({ period: "month", capUsd: 20, spentUsd: 8, remainingUsd: 12 });
    expect(byPeriod.week).toBeUndefined();
  });

  it("clamps remainingUsd at 0 when spend has already exceeded the cap", async () => {
    const db = fakeDb([], [{ agentId: "a1", costUsd: 15, startedAt: TODAY_START }]);
    const spend = await computeGroupSpend(db, { dailyBudgetUsd: 10, weeklyBudgetUsd: null, monthlyBudgetUsd: null } as never, ["a1"], NOW);
    expect(spend[0]).toEqual({ period: "day", capUsd: 10, spentUsd: 15, remainingUsd: 0 });
  });
});

describe("effectiveBudgetForRun", () => {
  it("returns the agent's own budgetUsd unchanged when it has no budgetGroupId", async () => {
    const db = fakeDb([], []);
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: null, budgetUsd: 5 } as never, NOW);
    expect(result).toEqual({ effectiveBudgetUsd: 5, constrainedBy: [] });
  });

  it("returns the agent's own budgetUsd unchanged when its group has no caps set", async () => {
    const db = fakeDb(
      [{ id: "g1", name: "g", dailyBudgetUsd: null, weeklyBudgetUsd: null, monthlyBudgetUsd: null, warnThresholdRatio: 0.8, agentIds: ["a1"] }],
      [],
    );
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: "g1", budgetUsd: 5 } as never, NOW);
    expect(result).toEqual({ effectiveBudgetUsd: 5, constrainedBy: [] });
  });

  it("tightens the effective budget to the group's remaining daily cap when that's smaller than budgetUsd", async () => {
    const db = fakeDb(
      [{ id: "g1", name: "g", dailyBudgetUsd: 10, weeklyBudgetUsd: null, monthlyBudgetUsd: null, warnThresholdRatio: 0.8, agentIds: ["a1"] }],
      [{ agentId: "a1", costUsd: 8, startedAt: TODAY_START }],
    );
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: "g1", budgetUsd: 5 } as never, NOW);
    expect(result).toEqual({ effectiveBudgetUsd: 2, constrainedBy: ["day"] });
  });

  it("returns an effective budget of 0 once the group's period cap is fully spent — the engine's existing zero-budget refuse then applies", async () => {
    const db = fakeDb(
      [{ id: "g1", name: "g", dailyBudgetUsd: 10, weeklyBudgetUsd: null, monthlyBudgetUsd: null, warnThresholdRatio: 0.8, agentIds: ["a1"] }],
      [{ agentId: "a1", costUsd: 10, startedAt: TODAY_START }],
    );
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: "g1", budgetUsd: 5 } as never, NOW);
    expect(result.effectiveBudgetUsd).toBe(0);
  });

  it("uses the tightest of multiple configured periods, not just the first one checked", async () => {
    const db = fakeDb(
      [{ id: "g1", name: "g", dailyBudgetUsd: 10, weeklyBudgetUsd: 12, monthlyBudgetUsd: 100, warnThresholdRatio: 0.8, agentIds: ["a1"] }],
      [
        { agentId: "a1", costUsd: 2, startedAt: TODAY_START }, // daily remaining: 8
        { agentId: "a1", costUsd: 9, startedAt: new Date("2026-09-07T00:00:00.000Z") }, // this ISO week (Mon 09-07) too -> weekly spend 11, remaining 1
      ],
    );
    const result = await effectiveBudgetForRun(db, { id: "a1", budgetGroupId: "g1", budgetUsd: 5 } as never, NOW);
    expect(result.effectiveBudgetUsd).toBe(1);
    expect(result.constrainedBy).toContain("week");
  });
});
```

- [ ] **Step 6: Run the full file and confirm everything passes**

Run: `npx vitest run src/core/budget-groups.test.ts`
Expected: PASS (11 tests total)

- [ ] **Step 7: Typecheck, lint, format, commit**

```bash
npm run typecheck && npm run lint
npx prettier --write src/core/budget-groups.ts src/core/budget-groups.test.ts
git add src/core/budget-groups.ts src/core/budget-groups.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add budget-groups period math and live spend/effective-budget calc

Pure period-start math (calendar-aligned UTC day/ISO-week/month) plus
two DB-querying functions: computeGroupSpend (live per-period
spend/remaining for a group's configured caps) and
effectiveBudgetForRun (an agent's own budgetUsd, tightened to whatever
period budget its group has left). Not wired into the run path yet --
that's next.
EOF
)"
```

---

## Task 3: Wire `effectiveBudgetForRun` into `runner.ts`

**Files:**
- Modify: `src/core/runner.ts`
- Modify: `src/core/runner.test.ts`

**Interfaces:**
- Consumes: `effectiveBudgetForRun` from `./budget-groups.js` (Task 2).
- Produces: `RunnerDb` gains `"budgetGroup"` to its `Pick<PrismaClient, ...>` — Task 5's MCP tools and any future caller of `executeRun`/`runAgent` must pass a `db` whose type includes it (already true for the real `PrismaClient`; only test fakes need updating, done in this task).

- [ ] **Step 1: Write the failing test — a grouped agent's effective (tightened) budget reaches the engine**

Add to `src/core/runner.test.ts`, inside the existing `fakeDb` function: extend the returned object with a `budgetGroup` fake, and extend `FakeAgent` with an optional `budgetGroupId`. Replace the whole `fakeDb` function with:

```ts
interface FakeAgent {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  budgetUsd: number;
  maxTurns: number;
  kind?: "native" | "coding";
  budgetGroupId?: string | null;
}

interface FakeBudgetGroup {
  id: string;
  name: string;
  dailyBudgetUsd?: number | null;
  weeklyBudgetUsd?: number | null;
  monthlyBudgetUsd?: number | null;
  warnThresholdRatio?: number;
}

function fakeDb(
  agents: FakeAgent[],
  tools: FakeTool[] = [],
  attachments: FakeAttachment[] = [],
  secretsData: { agentId: string; name: string; value: string }[] = [],
  budgetGroups: FakeBudgetGroup[] = [],
  priorRuns: { agentId: string; costUsd: number; startedAt: Date }[] = [],
): RunnerDb {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const toolsById = new Map(tools.map((t) => [t.id, t]));
  const groupsById = new Map(budgetGroups.map((g) => [g.id, g]));
  const runs = new Map<string, any>();
  let counter = 0;

  return {
    agent: {
      findUnique: (async ({ where }: any) => (where.name ? byName.get(where.name) : byId.get(where.id)) ?? null) as any,
    },
    run: {
      create: (async ({ data }: any) => {
        const id = `run_${++counter}`;
        const record = {
          id,
          status: "pending",
          trigger: "manual",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
          heartbeatAt: null,
          ...data,
        };
        runs.set(id, record);
        return record;
      }) as any,
      findUnique: (async ({ where }: any) => runs.get(where.id) ?? null) as any,
      update: (async ({ where, data }: any) => {
        const record = { ...runs.get(where.id), ...data };
        runs.set(where.id, record);
        return record;
      }) as any,
      findMany: (async ({ where }: any) =>
        priorRuns.filter((r) => where.agentId.in.includes(r.agentId) && r.startedAt >= where.startedAt.gte)) as any,
    },
    agentTool: {
      findMany: (async ({ where }: any) =>
        attachments
          .filter((a) => a.agentId === where.agentId)
          .map((a) => ({ ...a, tool: toolsById.get(a.toolId) }))) as any,
    },
    agentSecret: {
      findFirst: (async ({ where }: any) => {
        const row = secretsData.find((s) => s.agentId === where.agentId && s.name === where.secret.name);
        return row ? { secret: { ciphertext: row.value } } : null;
      }) as any,
    },
    budgetGroup: {
      findUnique: (async ({ where }: any) => {
        const g = groupsById.get(where.id);
        if (!g) return null;
        return {
          dailyBudgetUsd: null,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          ...g,
          agents: agents.filter((a) => a.budgetGroupId === where.id).map((a) => ({ id: a.id })),
        };
      }) as any,
    },
  } as unknown as RunnerDb;
}
```

- [ ] **Step 2: Add the new test cases, in the `describe("runAgent", ...)` block, after the existing three tests**

```ts
  it("passes the agent's own budgetUsd unchanged to the engine when it has no budget group", async () => {
    const db = fakeDb([{ id: "a1", name: "solo", systemPrompt: "s", model: "m", budgetUsd: 5, maxTurns: 10 }]);
    let capturedBudget: number | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.01 } },
      (ctx) => {
        capturedBudget = ctx.agent.budgetUsd;
      },
    );
    await runAgent("solo", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher }, db);
    expect(capturedBudget).toBe(5);
  });

  it("tightens the budget handed to the engine when the agent's group has a smaller remaining daily cap", async () => {
    const db = fakeDb(
      [{ id: "a1", name: "grouped", systemPrompt: "s", model: "m", budgetUsd: 5, maxTurns: 10, budgetGroupId: "g1" }],
      [],
      [],
      [],
      [{ id: "g1", name: "team", dailyBudgetUsd: 10 }],
      [{ agentId: "a1", costUsd: 8, startedAt: new Date() }],
    );
    let capturedBudget: number | undefined;
    const engine = fakeEngine(
      { status: "succeeded", finalText: "ok", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.01 } },
      (ctx) => {
        capturedBudget = ctx.agent.budgetUsd;
      },
    );
    await runAgent("grouped", { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher }, db);
    expect(capturedBudget).toBe(2); // 10 cap - 8 already spent = 2 remaining, tighter than the agent's own 5
  });

  it("hands the engine a 0 budget once the group's daily cap is fully spent, regardless of the agent's own budgetUsd", async () => {
    const db = fakeDb(
      [{ id: "a1", name: "exhausted", systemPrompt: "s", model: "m", budgetUsd: 5, maxTurns: 10, budgetGroupId: "g1" }],
      [],
      [],
      [],
      [{ id: "g1", name: "team", dailyBudgetUsd: 10 }],
      [{ agentId: "a1", costUsd: 10, startedAt: new Date() }],
    );
    let capturedBudget: number | undefined;
    const engine = fakeEngine(
      {
        status: "refused",
        finalText: "",
        turns: 1,
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        error: "budget exhausted before any LLM call",
      },
      (ctx) => {
        capturedBudget = ctx.agent.budgetUsd;
      },
    );
    const run = await runAgent(
      "exhausted",
      { llm: noopLlm, engine, datastore: fakeDatastore(), secrets: noopSecretCipher },
      db,
    );
    expect(capturedBudget).toBe(0);
    // The engine result is a fake here (its own zero-budget refuse behavior
    // is engine-native.test.ts's job, not this file's) -- this test's job
    // is only to prove runner.ts computed and passed a 0, then persisted
    // whatever status the engine returned for it.
    expect(run.status).toBe("refused");
  });
```

- [ ] **Step 3: Run to confirm these fail (runner.ts doesn't call `effectiveBudgetForRun` yet, so the tightened-budget tests fail; the unchanged-budget test still passes)**

Run: `npx vitest run src/core/runner.test.ts`
Expected: 2 of the 3 new tests FAIL (budget still `5` instead of `2`/tightened)

- [ ] **Step 4: Modify `src/core/runner.ts`**

Change the `RunnerDb` type (around line 31):

```ts
export type RunnerDb = Pick<PrismaClient, "agent" | "run" | "agentTool" | "agentSecret" | "budgetGroup">;
```

Add the import (with the other local imports near the top):

```ts
import { effectiveBudgetForRun } from "./budget-groups.js";
```

In `executeRun`, replace this block:

```ts
    const engineResult = await providers.engine.run({
      agent: {
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        budgetUsd: Number(agent.budgetUsd),
        maxTurns: agent.maxTurns,
      },
```

with:

```ts
    const { effectiveBudgetUsd } = await effectiveBudgetForRun(db, agent);
    const engineResult = await providers.engine.run({
      agent: {
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        budgetUsd: effectiveBudgetUsd,
        maxTurns: agent.maxTurns,
      },
```

- [ ] **Step 5: Run to confirm all tests now pass**

Run: `npx vitest run src/core/runner.test.ts`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 6: Typecheck, lint, format, run the full suite, commit**

```bash
npm run typecheck && npm run lint && npm test
npx prettier --write src/core/runner.ts src/core/runner.test.ts
git add src/core/runner.ts src/core/runner.test.ts
git commit -m "$(cat <<'EOF'
feat(core): tighten a run's effective budget to its group's remaining period cap

executeRun now computes effectiveBudgetForRun before calling the
engine and passes that (not the agent's raw budgetUsd) as the
per-run ceiling. No changes to engine-native.ts: its existing
turn-by-turn budget machinery already handles a 0 (or tightened)
budget exactly like any other -- a run whose group's period cap is
already spent gets the same turn-1 refuse an agent with budgetUsd=0
always got.
EOF
)"
```

---

## Task 4: Ownership helpers + scope

**Files:**
- Modify: `src/mcp/auth/ownership.ts`
- Modify: `src/mcp/auth/ownership.test.ts`
- Modify: `src/mcp/auth/resource-server.ts`

**Interfaces:**
- Produces (used by Task 5's `budget-groups.ts` MCP tools and Task 6's `agents.ts` changes): `requireOwnedBudgetGroup(db: PrismaClient, id: string, principalId: string): Promise<BudgetGroup>`, `requireReadableBudgetGroup(db: PrismaClient, id: string, principalId: string): Promise<BudgetGroup>`.
- Produces: `"budget_groups:write"` added to `SCOPES_SUPPORTED`.

- [ ] **Step 1: Write the failing tests.** Add to `src/mcp/auth/ownership.test.ts` (follow the file's existing pattern for `requireOwnedAgent`/`requireReadableAgent` — a fake `db.budgetGroup.findUnique`):

```ts
import { requireOwnedBudgetGroup, requireReadableBudgetGroup } from "./ownership.js";

describe("requireOwnedBudgetGroup", () => {
  function fakeDb(groups: { id: string; ownerId: string | null }[]) {
    return {
      budgetGroup: {
        findUnique: async ({ where }: { where: { id: string } }) => groups.find((g) => g.id === where.id) ?? null,
      },
    } as unknown as import("@prisma/client").PrismaClient;
  }

  it("returns the group when the caller owns it", async () => {
    const db = fakeDb([{ id: "g1", ownerId: "p1" }]);
    await expect(requireOwnedBudgetGroup(db, "g1", "p1")).resolves.toMatchObject({ id: "g1" });
  });

  it("throws 404 when the group doesn't exist", async () => {
    const db = fakeDb([]);
    await expect(requireOwnedBudgetGroup(db, "missing", "p1")).rejects.toThrow(/not found/i);
  });

  it("throws 403 when the caller doesn't own a group someone else owns", async () => {
    const db = fakeDb([{ id: "g1", ownerId: "someone-else" }]);
    await expect(requireOwnedBudgetGroup(db, "g1", "p1")).rejects.toThrow(/not owned/i);
  });

  it("throws when a public (null-owner) group is targeted for mutation — public is readable, not mutable, by non-owners", async () => {
    const db = fakeDb([{ id: "g1", ownerId: null }]);
    await expect(requireOwnedBudgetGroup(db, "g1", "p1")).rejects.toThrow();
  });
});

describe("requireReadableBudgetGroup", () => {
  function fakeDb(groups: { id: string; ownerId: string | null }[]) {
    return {
      budgetGroup: {
        findUnique: async ({ where }: { where: { id: string } }) => groups.find((g) => g.id === where.id) ?? null,
      },
    } as unknown as import("@prisma/client").PrismaClient;
  }

  it("returns a public (null-owner) group for any caller", async () => {
    const db = fakeDb([{ id: "g1", ownerId: null }]);
    await expect(requireReadableBudgetGroup(db, "g1", "p1")).resolves.toMatchObject({ id: "g1" });
  });

  it("returns the group when the caller owns it", async () => {
    const db = fakeDb([{ id: "g1", ownerId: "p1" }]);
    await expect(requireReadableBudgetGroup(db, "g1", "p1")).resolves.toMatchObject({ id: "g1" });
  });

  it("throws 404 for a group owned by someone else", async () => {
    const db = fakeDb([{ id: "g1", ownerId: "someone-else" }]);
    await expect(requireReadableBudgetGroup(db, "g1", "p1")).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/mcp/auth/ownership.test.ts`
Expected: FAIL — `requireOwnedBudgetGroup`/`requireReadableBudgetGroup` are not exported

- [ ] **Step 3: Add the two functions to `src/mcp/auth/ownership.ts`**, after the existing `requireReadableAgent` function:

```ts
export async function requireOwnedBudgetGroup(db: PrismaClient, id: string, principalId: string) {
  const group = await db.budgetGroup.findUnique({ where: { id } });
  if (!group) throw new McpError(404, `Budget group "${id}" not found.`);
  assertCanMutate(group.ownerId, principalId, `Budget group "${id}" is not owned by the caller.`);
  return group;
}

export async function requireReadableBudgetGroup(db: PrismaClient, id: string, principalId: string) {
  const group = await db.budgetGroup.findUnique({ where: { id } });
  if (!group || !canRead(group.ownerId, principalId)) {
    throw new McpError(404, `Budget group "${id}" not found.`);
  }
  return group;
}
```

- [ ] **Step 4: Run to confirm the new tests pass, and the whole file still passes**

Run: `npx vitest run src/mcp/auth/ownership.test.ts`
Expected: PASS

- [ ] **Step 5: Add the new scope.** In `src/mcp/auth/resource-server.ts`, change:

```ts
export const SCOPES_SUPPORTED = [
  "agents:read",
  "agents:write",
  "tools:write",
  "runs:trigger",
  "datastore:write",
  "secrets:write",
  "webhooks:write",
];
```

to:

```ts
export const SCOPES_SUPPORTED = [
  "agents:read",
  "agents:write",
  "tools:write",
  "runs:trigger",
  "datastore:write",
  "secrets:write",
  "webhooks:write",
  "budget_groups:write",
];
```

- [ ] **Step 6: Typecheck, lint, format, full suite, commit**

```bash
npm run typecheck && npm run lint && npm test
npx prettier --write src/mcp/auth/ownership.ts src/mcp/auth/ownership.test.ts src/mcp/auth/resource-server.ts
git add src/mcp/auth/ownership.ts src/mcp/auth/ownership.test.ts src/mcp/auth/resource-server.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add BudgetGroup ownership helpers and budget_groups:write scope

requireOwnedBudgetGroup/requireReadableBudgetGroup mirror the existing
requireOwnedAgent/requireReadableAgent pattern exactly. Not used by
any tool yet -- the budget-groups MCP tools are next.
EOF
)"
```

---

## Task 5: MCP tools — `create_budget_group`, `update_budget_group`, `list_budget_groups`, `get_budget_group`, `delete_budget_group`

**Files:**
- Create: `src/mcp/tools/budget-groups.ts`
- Create: `src/mcp/tools/budget-groups.test.ts`
- Modify: `src/mcp/index.ts`

**Interfaces:**
- Consumes: `requireOwnedBudgetGroup`/`requireReadableBudgetGroup` (Task 4), `computeGroupSpend` (Task 2), `visibleToPrincipal`/`canRead` (existing, `src/mcp/auth/ownership.ts`), `textResult` (existing, `src/mcp/tools/text-result.ts`), `McpError` (existing, `src/mcp/errors.ts`).
- Produces: `export function registerBudgetGroupTools(mcp: ReevoMcpServer): void`, called from `registerAllTools` in `mcp/index.ts`.

- [ ] **Step 1: Write `src/mcp/tools/budget-groups.ts`**

```ts
/** BudgetGroup CRUD with scope checks in server.ts and ownership checks here. */
import { z } from "zod";
import { computeGroupSpend } from "../../core/budget-groups.js";
import { canRead, requireOwnedBudgetGroup, visibleToPrincipal } from "../auth/ownership.js";
import { McpError } from "../errors.js";
import type { ReevoMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const MAX_GROUP_NAME_CHARS = 200;
const MAX_BUDGET_USD = 1_000_000;

const capField = z.number().finite().positive().max(MAX_BUDGET_USD);

const CreateBudgetGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_GROUP_NAME_CHARS),
    dailyBudgetUsd: capField.optional(),
    weeklyBudgetUsd: capField.optional(),
    monthlyBudgetUsd: capField.optional(),
    warnThresholdRatio: z.number().finite().gt(0).lte(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dailyBudgetUsd === undefined && value.weeklyBudgetUsd === undefined && value.monthlyBudgetUsd === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dailyBudgetUsd"],
        message: "at least one of dailyBudgetUsd/weeklyBudgetUsd/monthlyBudgetUsd is required",
      });
    }
  });

const UpdateBudgetGroupSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(MAX_GROUP_NAME_CHARS).optional(),
    dailyBudgetUsd: capField.nullable().optional(),
    weeklyBudgetUsd: capField.nullable().optional(),
    monthlyBudgetUsd: capField.nullable().optional(),
    warnThresholdRatio: z.number().finite().gt(0).lte(1).optional(),
  })
  .strict();

function invalidArguments(label: string, error: z.ZodError): McpError {
  const details = error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
  return new McpError(400, `Invalid ${label}: ${details}`);
}

const capSchemaProps = {
  dailyBudgetUsd: { type: ["number", "null"] },
  weeklyBudgetUsd: { type: ["number", "null"] },
  monthlyBudgetUsd: { type: ["number", "null"] },
  warnThresholdRatio: { type: "number" },
};

export function registerBudgetGroupTools(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "create_budget_group",
    scope: "budget_groups:write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" }, ...capSchemaProps },
      required: ["name"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const result = CreateBudgetGroupSchema.safeParse(rawArgs);
      if (!result.success) throw invalidArguments("create_budget_group arguments", result.error);
      const group = await ctx.db.budgetGroup.create({
        data: { ...result.data, ownerId: ctx.principal.id },
      });
      return textResult(group);
    },
  });

  mcp.registerTool({
    name: "update_budget_group",
    scope: "budget_groups:write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" }, name: { type: "string" }, ...capSchemaProps },
      required: ["id"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const result = UpdateBudgetGroupSchema.safeParse(rawArgs);
      if (!result.success) throw invalidArguments("update_budget_group arguments", result.error);
      const { id, ...updates } = result.data;
      await requireOwnedBudgetGroup(ctx.db, id, ctx.principal.id);
      const group = await ctx.db.budgetGroup.update({ where: { id }, data: updates });
      return textResult(group);
    },
  });

  mcp.registerTool({
    name: "list_budget_groups",
    scope: "agents:read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args: Record<string, never>, ctx) => {
      const groups = await ctx.db.budgetGroup.findMany({ where: visibleToPrincipal(ctx.principal.id) });
      return textResult(groups);
    },
  });

  mcp.registerTool({
    name: "get_budget_group",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args: { id: string }, ctx) => {
      const group = await ctx.db.budgetGroup.findUnique({
        where: { id: args.id },
        include: { agents: { select: { id: true, name: true } } },
      });
      if (!group || !canRead(group.ownerId, ctx.principal.id)) {
        throw new McpError(404, `Budget group "${args.id}" not found.`);
      }
      const spend = await computeGroupSpend(
        ctx.db,
        group,
        group.agents.map((a) => a.id),
        new Date(),
      );
      return textResult({ ...group, spend });
    },
  });

  mcp.registerTool({
    name: "delete_budget_group",
    scope: "budget_groups:write",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args: { id: string }, ctx) => {
      await requireOwnedBudgetGroup(ctx.db, args.id, ctx.principal.id);
      // Agent.budgetGroupId -> BudgetGroup is ON DELETE SET NULL: member
      // agents are ungrouped automatically, never blocked or cascaded.
      await ctx.db.budgetGroup.delete({ where: { id: args.id } });
      return textResult({ deleted: args.id });
    },
  });
}
```

- [ ] **Step 2: Wire it into `src/mcp/index.ts`.** Add the import near the other tool-module imports:

```ts
import { registerBudgetGroupTools } from "./tools/budget-groups.js";
```

In `registerAllTools`, add the call (anywhere in the list, e.g. right after `registerAgentTools(mcp);`):

```ts
  registerAgentTools(mcp);
  registerBudgetGroupTools(mcp);
```

- [ ] **Step 3: Write `src/mcp/tools/budget-groups.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerBudgetGroupTools } from "./budget-groups.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeGroupRow {
  id: string;
  name: string;
  ownerId: string | null;
  dailyBudgetUsd: number | null;
  weeklyBudgetUsd: number | null;
  monthlyBudgetUsd: number | null;
  warnThresholdRatio: number;
}

function fakeDb(agentsByGroup: Record<string, { id: string; name: string }[]> = {}) {
  const groups = new Map<string, FakeGroupRow>();
  let counter = 0;

  return {
    budgetGroup: {
      create: async ({ data }: { data: Partial<FakeGroupRow> & { name: string; ownerId: string | null } }) => {
        const row: FakeGroupRow = {
          id: `bg_${++counter}`,
          dailyBudgetUsd: null,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          ...data,
        };
        groups.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeGroupRow> }) => {
        const row = groups.get(where.id);
        if (!row) throw new Error("not found");
        const updated = { ...row, ...data };
        groups.set(where.id, updated);
        return updated;
      },
      findMany: async ({ where }: { where?: { OR?: { ownerId: string | null }[] } } = {}) => {
        const all = [...groups.values()];
        if (!where?.OR) return all;
        return all.filter((g) => where.OR!.some((cond) => g.ownerId === cond.ownerId));
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = groups.get(where.id);
        if (!row) return null;
        return { ...row, agents: agentsByGroup[where.id] ?? [] };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = groups.get(where.id);
        groups.delete(where.id);
        return row;
      },
    },
    run: {
      findMany: async () => [],
    },
  } as unknown as import("@prisma/client").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, scopes: string[]): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    providers: fakeProviders,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

async function connectClient(mcp: ReturnType<typeof buildMcpServer>) {
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function parseText(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

describe("budget group tools", () => {
  it("create_budget_group requires at least one period cap", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["budget_groups:write"]));
    registerBudgetGroupTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "create_budget_group", arguments: { name: "team" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("creates a group owned by the caller, then lists and gets it back with live spend", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["budget_groups:write", "agents:read"]));
    registerBudgetGroupTools(mcp);
    const client = await connectClient(mcp);

    const created = await client.callTool({
      name: "create_budget_group",
      arguments: { name: "team", dailyBudgetUsd: 25 },
    });
    expect(created.isError).toBeFalsy();
    const group = parseText(created as never) as { id: string; ownerId: string };
    expect(group.ownerId).toBe("p1");

    const listed = await client.callTool({ name: "list_budget_groups", arguments: {} });
    expect((parseText(listed as never) as unknown[]).length).toBe(1);

    const got = await client.callTool({ name: "get_budget_group", arguments: { id: group.id } });
    const gotBody = parseText(got as never) as { spend: { period: string; capUsd: number }[] };
    expect(gotBody.spend).toEqual([{ period: "day", capUsd: 25, spentUsd: 0, remainingUsd: 25 }]);
    await client.close();
  });

  it("update_budget_group refuses a caller who doesn't own the group", async () => {
    // One shared db, two server instances with different fixed identities
    // — a real second caller talking to the same backing store, not a
    // separate fake with patched-in behavior.
    const db = fakeDb();
    const ownerMcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    ownerMcp.setFixedContext(fakeCtx(db, "owner", ["budget_groups:write"]));
    registerBudgetGroupTools(ownerMcp);
    const ownerClient = await connectClient(ownerMcp);
    const created = await ownerClient.callTool({
      name: "create_budget_group",
      arguments: { name: "team", dailyBudgetUsd: 25 },
    });
    const group = parseText(created as never) as { id: string };
    await ownerClient.close();

    const otherMcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    otherMcp.setFixedContext(fakeCtx(db, "not-the-owner", ["budget_groups:write"]));
    registerBudgetGroupTools(otherMcp);
    const otherClient = await connectClient(otherMcp);
    const updateResult = await otherClient.callTool({
      name: "update_budget_group",
      arguments: { id: group.id, dailyBudgetUsd: 999 },
    });
    expect(updateResult.isError).toBe(true);
    await otherClient.close();
  });

  it("delete_budget_group requires ownership and returns the deleted id", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["budget_groups:write"]));
    registerBudgetGroupTools(mcp);
    const client = await connectClient(mcp);
    const created = await client.callTool({
      name: "create_budget_group",
      arguments: { name: "team", weeklyBudgetUsd: 50 },
    });
    const group = parseText(created as never) as { id: string };

    const deleted = await client.callTool({ name: "delete_budget_group", arguments: { id: group.id } });
    expect(parseText(deleted as never)).toEqual({ deleted: group.id });
    await client.close();
  });
});
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/mcp/tools/budget-groups.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck, lint, format, full suite, commit**

```bash
npm run typecheck && npm run lint && npm test
npx prettier --write src/mcp/tools/budget-groups.ts src/mcp/tools/budget-groups.test.ts src/mcp/index.ts
git add src/mcp/tools/budget-groups.ts src/mcp/tools/budget-groups.test.ts src/mcp/index.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add create/update/list/get/delete_budget_group tools

get_budget_group reports live per-period spend (via
core/budget-groups.ts's computeGroupSpend), not just static config.
Ownership follows the existing Agent/Webhook pattern exactly: null
owner = public/readable-by-anyone, mutation requires real ownership.
Agents aren't attachable to a group yet -- that's agents.ts next.
EOF
)"
```

---

## Task 6: `budgetGroupId` on `create_agent`/`update_agent`

**Files:**
- Modify: `src/mcp/tools/agents.ts`
- Modify: `src/mcp/tools/agents.test.ts`

**Interfaces:**
- Consumes: `requireReadableBudgetGroup` from `../auth/ownership.js` (Task 4) — attaching an agent to a group requires the group be *readable* (owned, or public), matching how a public `Tool` can be attached to any agent without owning the `Tool` itself.

- [ ] **Step 1: Write the failing tests.** Add to `src/mcp/tools/agents.test.ts`:

First, extend the test file's own `FakeAgentRow` and `fakeDb` to support `budgetGroupId` and a `budgetGroup` fake collection. Change the `FakeAgentRow` interface to add one field:

```ts
interface FakeAgentRow {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  budgetUsd: number;
  maxTurns: number;
  schedule: string | null;
  timezone: string;
  scheduleEnabled: boolean;
  ownerId: string | null;
  tools: unknown[];
  kind: "native" | "coding";
  codingProfile: FakeCodingProfile | null;
  budgetGroupId: string | null;
}
```

Change the `create` default-fill object inside `fakeDb` to include `budgetGroupId: null,` alongside the other defaults (next to `codingProfile: codingProfile?.create ?? null,`).

Add a `budgetGroups` seed param and a `budgetGroup.findUnique` fake to `fakeDb`. Change the function signature and body:

```ts
function fakeDb(seed: FakeAgentSeed[] = [], budgetGroups: { id: string; ownerId: string | null }[] = []) {
  const rows = new Map(
    seed.map((r) => [
      r.id,
      {
        kind: "native" as const,
        codingProfile: null,
        scheduleEnabled: true,
        budgetGroupId: null,
        ...r,
      },
    ]),
  );
  const groupsById = new Map(budgetGroups.map((g) => [g.id, g]));
  let counter = rows.size;
  const transactionDb = {
    agent: {
      create: async ({
        data,
      }: {
        data: Partial<FakeAgentRow> & { name: string; codingProfile?: { create: FakeCodingProfile } };
      }) => {
        const { codingProfile, ...agentData } = data;
        const row: FakeAgentRow = {
          id: `agent_${++counter}`,
          systemPrompt: "",
          model: "",
          budgetUsd: 0,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          scheduleEnabled: true,
          ownerId: null,
          tools: [],
          kind: "native",
          codingProfile: codingProfile?.create ?? null,
          budgetGroupId: null,
          ...agentData,
        };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      findMany: async ({ where }: { where?: { OR?: { ownerId: string | null }[] } } = {}) => {
        const all = [...rows.values()];
        if (!where?.OR) return all;
        return all.filter((r) => where.OR!.some((cond) => r.ownerId === cond.ownerId));
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeAgentRow> & {
          codingProfile?: { create?: FakeCodingProfile; update?: FakeCodingProfile; delete?: boolean };
        };
      }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("not found");
        const { codingProfile, ...agentData } = data;
        const updated = {
          ...row,
          ...agentData,
          codingProfile: codingProfile?.delete
            ? null
            : (codingProfile?.create ?? codingProfile?.update ?? row.codingProfile),
        };
        rows.set(where.id, updated);
        return updated;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        rows.delete(where.id);
        return row;
      },
    },
    agentTool: {
      count: async ({ where }: { where: { agentId: string } }) => rows.get(where.agentId)?.tools.length ?? 0,
    },
    budgetGroup: {
      findUnique: async ({ where }: { where: { id: string } }) => groupsById.get(where.id) ?? null,
    },
  };
  const db = {
    ...transactionDb,
    $transaction: async <T>(callback: (tx: typeof transactionDb) => Promise<T>) => callback(transactionDb),
  };
  return db as unknown as import("@prisma/client").PrismaClient;
}
```

Then add the new test cases in the `describe` block, after the existing tests:

```ts
  it("create_agent accepts a budgetGroupId for a group the caller can read (public)", async () => {
    const db = fakeDb([], [{ id: "g1", ownerId: null }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "grouped", systemPrompt: "s", model: "m", budgetUsd: 1, budgetGroupId: "g1" },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { budgetGroupId: string };
    expect(body.budgetGroupId).toBe("g1");
    await client.close();
  });

  it("create_agent rejects a budgetGroupId for a group owned by someone else", async () => {
    const db = fakeDb([], [{ id: "g1", ownerId: "someone-else" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "grouped", systemPrompt: "s", model: "m", budgetUsd: 1, budgetGroupId: "g1" },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("update_agent can clear an agent's budgetGroupId back to null", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "grouped",
        systemPrompt: "s",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p1",
        tools: [],
        budgetGroupId: "g1",
      },
    ], [{ id: "g1", ownerId: null }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", budgetGroupId: null },
    });
    expect((parseText(result as never) as { budgetGroupId: string | null }).budgetGroupId).toBeNull();
    await client.close();
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/mcp/tools/agents.test.ts`
Expected: FAIL (schemas don't accept `budgetGroupId` yet — 400 invalid-arguments errors where the tests expect success)

- [ ] **Step 3: Modify `src/mcp/tools/agents.ts`**

Add the import:

```ts
import { assertCanMutate, canRead, requireOwnedAgent, requireReadableBudgetGroup, visibleToPrincipal } from "../auth/ownership.js";
```

Add a field to `agentFields` (after `kind`):

```ts
  budgetGroupId: z.string().min(1).max(128),
```

Add it to `CreateAgentSchema`'s object (after `budgetUsd: agentFields.budgetUsd,`):

```ts
    budgetGroupId: agentFields.budgetGroupId.optional(),
```

Add it to `UpdateAgentSchema`'s object (after `budgetUsd: agentFields.budgetUsd.optional(),`), as nullable so it can be cleared:

```ts
    budgetGroupId: agentFields.budgetGroupId.nullable().optional(),
```

Add it to both tools' JSON `inputSchema.properties` (`create_agent`'s, after `budgetUsd: { type: "number" },`):

```ts
        budgetGroupId: { type: "string" },
```

and `update_agent`'s (after its own `budgetUsd: { type: "number" },`):

```ts
        budgetGroupId: { type: ["string", "null"] },
```

In `create_agent`'s handler, validate the group before creating (right after `validateSchedule(args.schedule, args.timezone ?? "UTC");`):

```ts
      if (args.budgetGroupId) {
        await requireReadableBudgetGroup(ctx.db, args.budgetGroupId, ctx.principal.id);
      }
```

In `update_agent`'s handler, inside the `$transaction` callback, right after the existing `assertCanMutate(existing.ownerId, ctx.principal.id, ...)` line — a plain read via `ctx.db` (not `tx`) is fine here since it's validation-only, before any write in the transaction:

```ts
          if (args.budgetGroupId) {
            await requireReadableBudgetGroup(ctx.db, args.budgetGroupId, ctx.principal.id);
          }
```

- [ ] **Step 4: Run to confirm the new tests pass, and the whole file still passes**

Run: `npx vitest run src/mcp/tools/agents.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck, lint, format, full suite, commit**

```bash
npm run typecheck && npm run lint && npm test
npx prettier --write src/mcp/tools/agents.ts src/mcp/tools/agents.test.ts
git add src/mcp/tools/agents.ts src/mcp/tools/agents.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): let create_agent/update_agent attach an agent to a budget group

budgetGroupId must reference a group the caller can read (owned, or
public) -- same visibility rule as attaching a public Tool to an
agent, not full ownership. update_agent accepts null to ungroup.
EOF
)"
```

---

## Task 7: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Re-run the drift check** (schema/migrations must still agree after all six tasks)

```bash
docker exec local-postgres-1 psql -U reevo -d reevo -c "DROP DATABASE IF EXISTS reevo_shadow;" -c "CREATE DATABASE reevo_shadow;"
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://reevo:reevo@localhost:55432/reevo_shadow" \
  --script
docker exec local-postgres-1 psql -U reevo -d reevo -c "DROP DATABASE IF EXISTS reevo_shadow;"
```

Expected: `-- This is an empty migration.`

- [ ] **Step 2: Full verification chain**

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Expected: all clean/passing, matching this repo's `.github/workflows/test.yml` gate.

- [ ] **Step 3: Manual smoke test via the CLI or MCP tools (optional but recommended)** — create two agents in one budget group with a small `dailyBudgetUsd`, run both, and confirm the second run's engine call receives a visibly tightened `budgetUsd` (e.g. via `LOG_LEVEL=debug reevo run <agent-name>` and watching for the `budget-groups` warn log once past the group's `warnThresholdRatio`).

- [ ] **Step 4: Push**

```bash
git push origin main
```
