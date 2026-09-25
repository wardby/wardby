import { parseArgs } from "node:util";
import type { PrismaClient } from "#prisma";
import { IdentityService } from "./credentials.js";

export async function authCommand(
  args: string[],
  db: PrismaClient,
  hashKey: string,
  output: (value: string) => void = console.log,
) {
  const [kind, action, ...rest] = args;
  const service = new IdentityService(db, hashKey);
  if (
    hashKey.toLowerCase() === process.env.SECRET_APP_KEY?.toLowerCase() ||
    hashKey.toLowerCase() === process.env.AUTH_SIGNING_KEY?.toLowerCase()
  )
    throw new Error("Authentication keys must be independent.");
  if (kind === "key" && action === "revoke" && rest.length === 1) {
    await service.revokeKey(rest[0]);
    output("Key, sessions, and grants revoked.");
    return;
  }
  const { values } = parseArgs({ args: rest, options: { subject: { type: "string" } } });
  if (kind === "user" && action === "list") {
    output(JSON.stringify(await service.listUsers(), null, 2));
    return;
  }
  if (!values.subject) throw new Error("auth requires --subject (except user list and key revoke <key-id>).");
  if (kind === "user" && action === "create") {
    output(JSON.stringify(await service.createUser(values.subject)));
    return;
  }
  if (kind === "user" && action === "disable") {
    await service.disableUser(values.subject);
    output("User disabled; credentials, sessions, and grants revoked.");
    return;
  }
  if (kind === "key" && action === "create") {
    output(await service.createKey(values.subject));
    return;
  }
  if (kind === "key" && action === "list") {
    output(JSON.stringify(await service.listKeys(values.subject), null, 2));
    return;
  }
  throw new Error("Use auth user create|list|disable or auth key create|list|revoke.");
}
