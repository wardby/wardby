import { parseArgs } from "node:util";
import type { PrismaClient } from "#prisma";
import { IdentityService } from "./credentials.js";

const USAGE =
  "Use auth user create --subject <s> [--role <role>]... | user list | " +
  "user grant --subject <s> [--role <role>]... [--revoke-role <role>]... | user disable --subject <s> | " +
  "key create|list --subject <s> | key revoke <key-id>.";

type Flag = "subject" | "role" | "revoke-role";
/** The flags each command accepts. Anything else is rejected, never silently ignored. */
const COMMANDS: Record<string, readonly Flag[]> = {
  "user create": ["subject", "role"],
  "user list": [],
  "user grant": ["subject", "role", "revoke-role"],
  "user disable": ["subject"],
  "key create": ["subject"],
  "key list": ["subject"],
};
const FLAG_OPTIONS = {
  subject: { type: "string" },
  role: { type: "string", multiple: true },
  "revoke-role": { type: "string", multiple: true },
} as const;

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
  const command = `${kind} ${action}`;
  if (command === "key revoke") {
    if (rest.length !== 1 || rest[0].startsWith("-")) throw new Error("Use auth key revoke <key-id> (no flags).");
    await service.revokeKey(rest[0]);
    output("Key, sessions, and grants revoked.");
    return;
  }
  const allowed = COMMANDS[command];
  if (!allowed) throw new Error(USAGE);
  // strict parsing throws on any flag not declared for THIS command, so a
  // flag another command takes (e.g. `key create --role admin`) is an error.
  const { values } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: false,
    options: Object.fromEntries(allowed.map((flag) => [flag, FLAG_OPTIONS[flag]])),
  }) as { values: { subject?: string; role?: string[]; "revoke-role"?: string[] } };
  if (command === "user list") {
    output(JSON.stringify(await service.listUsers(), null, 2));
    return;
  }
  if (!values.subject) throw new Error(`auth ${command} requires --subject.`);
  if (command === "user create") {
    output(JSON.stringify(await service.createUser(values.subject, values.role ?? [])));
    return;
  }
  if (command === "user grant") {
    const add = values.role ?? [];
    const remove = values["revoke-role"] ?? [];
    if (add.length + remove.length === 0)
      throw new Error("auth user grant requires --role <role> and/or --revoke-role <role> (each repeatable).");
    output(JSON.stringify(await service.changeRoles(values.subject, add, remove)));
    return;
  }
  if (command === "user disable") {
    await service.disableUser(values.subject);
    output("User disabled; credentials, sessions, and grants revoked.");
    return;
  }
  if (command === "key create") {
    output(await service.createKey(values.subject));
    return;
  }
  output(JSON.stringify(await service.listKeys(values.subject), null, 2));
}
