import { expect, it } from "vitest";
import { startHttpServer } from "./streamable-http.js";
import { buildAuthProvider } from "../../providers/auth/index.js";
import type { PrismaClient } from "@prisma/client";

it("quarantines self-hosted startup before provider construction or socket binding", async () => {
  expect(() => buildAuthProvider("self-hosted", {}, {} as PrismaClient)).toThrow(/quarantined/);
  await expect(startHttpServer({ config: { authProviderKind: "self-hosted" } } as Parameters<typeof startHttpServer>[0])).rejects.toThrow(/quarantined/);
});
