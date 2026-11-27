import { describe, expect, it } from "vitest";
import { rankRouters } from "./request.js";

const router = (id: string, name: string, description: string | null) => ({ id, name, description, ownerName: null });

describe("rankRouters", () => {
  const mobile = router("m", "mobile", "mobile app screens, flows and design");
  const product = router("p", "product", "epics, concepts and go / no-go");

  it("ranks the router whose description fits the request first", () => {
    const ranked = rankRouters("mobile design for checkout", [product, mobile]);
    expect(ranked.map((r) => r.id)).toEqual(["m"]);
    expect(ranked[0].score).toBe(2);
  });

  it("returns nothing when no word matches", () => {
    expect(rankRouters("quarterly tax filing", [mobile, product])).toEqual([]);
  });

  it("scores distinct words once, ignoring short words and case", () => {
    const [hit] = rankRouters("DESIGN design an is of", [mobile]);
    expect(hit.score).toBe(1);
  });

  it("orders ties by name and returns at most the limit", () => {
    const many = Array.from({ length: 8 }, (_, i) => router(`r${i}`, `router-${7 - i}`, "checkout"));
    const ranked = rankRouters("checkout", many);
    expect(ranked).toHaveLength(5);
    expect(ranked.map((r) => r.name)).toEqual(["router-0", "router-1", "router-2", "router-3", "router-4"]);
    expect(rankRouters("checkout", many, 2)).toHaveLength(2);
  });
});
