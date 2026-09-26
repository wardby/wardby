/**
 * `wardby auth host-account list [--subject <s>] | unlink --subject <s> [--provider github]`:
 * the operator's view of principals' linked host identities. Keyed on
 * Principal.subject, so it works in both auth modes (self-hosted and
 * delegating). Unlinking frees a GitHub account to be linked by another
 * principal (link_host_account refuses one already linked elsewhere).
 */
import { parseArgs } from "node:util";
import type { PrismaClient } from "#prisma";
import { REVIEW_HOST_PROVIDERS } from "../../providers/review-host/types.js";

const USAGE = "Use auth host-account list [--subject <s>] | host-account unlink --subject <s> [--provider github].";

export async function hostAccountCommand(
  args: string[],
  db: PrismaClient,
  output: (value: string) => void = console.log,
): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "list" && action !== "unlink") throw new Error(USAGE);
  const { values } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: false,
    options: { subject: { type: "string" }, provider: { type: "string" } },
  });
  const provider = values.provider ?? "github";
  if (!(REVIEW_HOST_PROVIDERS as readonly string[]).includes(provider))
    throw new Error(`Unknown provider "${provider}".`);
  if (action === "list") {
    const rows = await db.hostIdentity.findMany({
      where: { provider, ...(values.subject ? { principal: { subject: values.subject } } : {}) },
      include: { principal: { select: { subject: true } } },
      orderBy: { linkedAt: "asc" },
    });
    output(
      JSON.stringify(
        rows.map((r) => ({
          subject: r.principal.subject,
          provider: r.provider,
          login: r.login,
          hostUserId: r.hostUserId,
          linkedAt: r.linkedAt,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (!values.subject) throw new Error("auth host-account unlink requires --subject.");
  const principal = await db.principal.findUnique({ where: { subject: values.subject } });
  if (!principal) throw new Error(`No principal with subject "${values.subject}".`);
  const { count } = await db.hostIdentity.deleteMany({ where: { principalId: principal.id, provider } });
  await db.hostIdentityLinkRequest.deleteMany({ where: { principalId: principal.id, provider } });
  output(count > 0 ? "Host account unlinked." : "No host account was linked.");
}
