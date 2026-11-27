import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { checkRouterSettings } from "./settings.js";

describe.skipIf(!process.env.DATABASE_URL)("router settings (database)", () => {
  const db = createPrismaClient();
  let ownerId: string;
  beforeAll(async () => {
    ownerId = (await db.principal.create({ data: { subject: `rs-${randomUUID()}` } })).id;
  });
  afterAll(() => db.$disconnect());
  const base = { agentId: null, kind: "native" as const, documentTools: { access: "read" }, reviewRouterId: null };

  it("a router needs a description", async () => {
    await expect(checkRouterSettings(db, { ...base, ownerId, description: null, router: true })).rejects.toMatchObject({
      message: "review_router_invalid",
      cause: "description",
    });
  });
  it("a router needs documentTools", async () => {
    await expect(
      checkRouterSettings(db, { ...base, ownerId, description: "mobile work", documentTools: null, router: true }),
    ).rejects.toMatchObject({ cause: "documents" });
  });
  it("a router is native", async () => {
    await expect(
      checkRouterSettings(db, { ...base, ownerId, description: "x", kind: "coding", router: true }),
    ).rejects.toMatchObject({ cause: "kind" });
  });
  it("reviewRouter must name a router the owner can execute", async () => {
    const notRouter = await db.agent.create({
      data: { name: `nr-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1, ownerId },
    });
    await expect(
      checkRouterSettings(db, { ...base, ownerId, description: null, router: false, reviewRouterId: notRouter.id }),
    ).rejects.toMatchObject({ cause: "review_router" });
    const router = await db.agent.create({
      data: {
        name: `r-${randomUUID()}`,
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        ownerId,
        router: true,
        description: "routes",
      },
    });
    await expect(
      checkRouterSettings(db, { ...base, ownerId, description: null, router: false, reviewRouterId: router.id }),
    ).resolves.toBeUndefined();
  });
});
