import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";

const db = createPrismaClient();
const name = `t-${randomUUID().slice(0, 12)}`;

afterAll(async () => {
  await db.hostProvider.deleteMany({ where: { name } });
  await db.secret.deleteMany({ where: { name } });
  await db.$disconnect();
});

describe("host provider tables", () => {
  it("cascades from the provider, and blocks deleting a secret in use", async () => {
    const secret = await db.secret.create({ data: { name, ciphertext: "x", keyId: "k" } });
    await db.hostProvider.create({
      data: {
        name,
        contractVersion: 1,
        gitHost: "git.example.com",
        apiHosts: ["api.example.com"],
        gitUsername: "x-token-auth",
        pullRequestUrlTemplate: "https://git.example.com/{repository}/pull/{number}",
        repositoryApiPath: "/2.0/repositories/{repository}",
        webhook: { header: "X-Sig", algorithm: "sha256", deliveryHeader: "X-Id", eventHeader: "X-Event" },
        webhookSecretId: secret.id,
        createdById: "p",
        credentials: { create: { repositoryPattern: "acme/*", secretId: secret.id } },
        operations: {
          create: { operation: "getDiff", code: "return {}", paramsZod: "z.object({})", approvedById: "p" },
        },
        trustedAccounts: { create: { accountId: "a", addedById: "p" } },
      },
    });
    await expect(db.secret.delete({ where: { id: secret.id } })).rejects.toThrow();
    const credential = await db.hostProviderCredential.findFirstOrThrow({ where: { provider: name } });
    expect(credential.credentialKind).toBe("static");
    await db.hostProvider.delete({ where: { name } });
    expect(await db.hostProviderOperation.count({ where: { provider: name } })).toBe(0);
    expect(await db.hostProviderCredential.count({ where: { provider: name } })).toBe(0);
    expect(await db.hostProviderTrustedAccount.count({ where: { provider: name } })).toBe(0);
  });
});
