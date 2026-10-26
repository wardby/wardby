/**
 * Low-power mode over MCP: power_status reads the coding proxy's and native
 * gateway's state, power_sleep scales them to zero now instead of waiting out
 * the idle window. Both need power:manage, a privileged scope honoured only
 * for the admin role (resource-server.ts). power_sleep never stops a run: a
 * target with active or queued runs (or, for the gateway, an active gateway
 * session) is refused and its run ids returned. Each power_sleep is audited
 * (event power.sleep, outcome ok or error, naming the principal), including a
 * failed or refused call, since a failure can follow a target already slept.
 */
import { z } from "zod";
import { logger } from "../../core/logger.js";
import { DISABLED_POWER, LOW_POWER_DISABLED, type PowerTarget } from "../../core/power.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const powerToolLog = logger.child({ module: "mcp-power" });

const TARGETS = ["proxy", "gateway"] as const satisfies readonly PowerTarget[];
const SleepSchema = z.object({ target: z.enum(TARGETS).optional() }).strict();
const StatusSchema = z.object({}).strict();

function parse<T>(schema: z.ZodType<T, unknown>, label: string, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    throw new McpError(400, `Invalid ${label}: ${details}`);
  }
  return result.data;
}

export function registerPowerTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "power_status",
    scope: "power:manage",
    description:
      "Admins (power:manage): low-power mode state. For the coding proxy and the native gateway: replicas, whether a ready endpoint exists, when it last woke (wokeAt), and blockers (run ids keeping it busy). Returns { enabled: false } when low-power mode is off.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    handler: async (rawArgs: unknown, ctx) => {
      parse(StatusSchema, "power_status arguments", rawArgs);
      return textResult(await (ctx.providers.power ?? DISABLED_POWER).status());
    },
  });

  mcp.registerTool({
    name: "power_sleep",
    scope: "power:manage",
    description:
      "Admins (power:manage): scale the coding proxy and/or native gateway to zero now, skipping low-power mode's idle window. It never stops a run: a target is refused while it has active or queued runs (for the gateway, also an active gateway session), and those run ids are returned under blocked. Recently finished runs do not block it. The next run wakes the target again. Fails (409 low_power_disabled) when low-power mode is off.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "string",
          enum: [...TARGETS],
          description: "Sleep only this target. Omit to sleep both.",
        },
      },
    },
    handler: async (rawArgs: unknown, ctx) => {
      const { target } = parse(SleepSchema, "power_sleep arguments", rawArgs);
      const targets: PowerTarget[] = target ? [target] : [...TARGETS];
      const power = ctx.providers.power ?? DISABLED_POWER;
      const audit = { event: "power.sleep", principal: ctx.principal.id, targets };
      let result;
      try {
        result = await power.sleepNow(targets);
      } catch (err) {
        // Audited before rethrowing: sleepNow may already have slept an earlier target.
        const error = err instanceof Error ? err.message : String(err);
        powerToolLog.warn({ ...audit, outcome: "error", error }, "power_sleep");
        if (err instanceof Error && err.message.startsWith(`${LOW_POWER_DISABLED}:`))
          throw new McpError(409, err.message);
        throw err;
      }
      powerToolLog.info({ ...audit, outcome: "ok", slept: result.slept, blocked: result.blocked }, "power_sleep");
      return textResult(result);
    },
  });
}
