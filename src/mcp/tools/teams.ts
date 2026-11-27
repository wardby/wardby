/**
 * Team management over MCP. The managing tools carry the privileged scope
 * teams:manage (honoured only for a role that grants it: admin or
 * team-manager); set_team_roles is admin only. list_teams needs no privilege:
 * a caller sees their own teams, and a manager whose token holds teams:manage
 * sees every team with its members. The rules live in core/teams/teams.ts.
 */
import { z } from "zod";
import {
  addMember,
  createTeam,
  deleteTeam,
  listTeams,
  removeMember,
  renameTeam,
  setTeamRoles,
  TeamError,
  type TeamActor,
} from "../../core/teams/teams.js";
import { requireSubject } from "../../providers/auth/subject.js";
import type { McpRequestContext } from "../context.js";
import { resolvePrincipal } from "../auth/principal.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";
import { scopesCover } from "../../authz/index.js";

const id = z.string().min(1).max(128);
const name = z.string().max(200);
const subject = z.string().min(1).max(512);

const CreateSchema = z.object({ name }).strict();
const RenameSchema = z.object({ id, name }).strict();
const DeleteSchema = z.object({ id }).strict();
const MemberSchema = z.object({ teamId: id, subject }).strict();
const RolesSchema = z.object({ id, roles: z.array(z.string().min(1).max(64)).max(32) }).strict();
const ListSchema = z.object({}).strict();

const STATUS = { forbidden: 403, not_found: 404, conflict: 409, invalid: 400 } as const;

function parse<T>(schema: z.ZodType<T, unknown>, label: string, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw new McpError(400, `Invalid ${label}: ${details}`);
  }
  return result.data;
}

/** Roles only count as the caller's when the token also holds teams:manage: a role alone never delegates. */
function actorOf(ctx: McpRequestContext): TeamActor {
  return {
    principalId: ctx.principal.id,
    roles: new Set(scopesCover(ctx.scopes, "teams:manage") ? (ctx.roles ?? []) : []),
  };
}

async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof TeamError) throw new McpError(STATUS[err.code], err.message);
    throw err;
  }
}

/** A subject the tool was given, validated like any token subject (no reserved team: prefix). */
function validSubject(value: string): string {
  try {
    return requireSubject(value);
  } catch (err) {
    throw new McpError(400, err instanceof Error ? err.message : "Invalid subject.");
  }
}

function teamView(team: {
  id: string;
  name: string;
  personal: boolean;
  principalId: string;
  roles: string[];
  createdAt: Date;
  updatedAt: Date;
}) {
  const { id, name, personal, principalId, roles, createdAt, updatedAt } = team;
  return { id, name, personal, principalId, roles, createdAt, updatedAt };
}

export function registerTeamTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "create_team",
    permission: "teams:manage",
    description:
      "Admins and team-managers (teams:manage): create a team. A team owns resources, receives access grants and can carry wardby roles. The result's principalId is the team's owner id: pass it to make_owner to move an agent to the team. Names are unique, 1 to 64 characters, and cannot start with the reserved prefix personal: (every user already has a personal team of one).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(CreateSchema, "create_team arguments", rawArgs);
      return textResult(teamView(await mapped(() => createTeam(ctx.db, actorOf(ctx), args))));
    },
  });

  mcp.registerTool({
    name: "list_teams",
    permission: "agents:read",
    description:
      "List teams, each with its id and principalId (the owner id make_owner takes to move an agent to that team). You see the teams you belong to (including your personal team). A caller holding teams:manage as an admin or team-manager sees every team, each with its members' subjects.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    handler: async (rawArgs: unknown, ctx) => {
      parse(ListSchema, "list_teams arguments", rawArgs);
      const teams = await listTeams(ctx.db, actorOf(ctx));
      return textResult(
        teams.map((team) => ({ ...teamView(team), ...(team.members ? { members: team.members } : {}) })),
      );
    },
  });

  mcp.registerTool({
    name: "rename_team",
    permission: "teams:manage",
    description: "Admins and team-managers (teams:manage): rename a team. A personal team cannot be renamed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id", "name"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(RenameSchema, "rename_team arguments", rawArgs);
      return textResult(teamView(await mapped(() => renameTeam(ctx.db, actorOf(ctx), args.id, args.name))));
    },
  });

  mcp.registerTool({
    name: "delete_team",
    permission: "teams:manage",
    description:
      "Admins and team-managers (teams:manage): delete a team, its memberships and its grants. Refused (409) while the team still owns any resource: transfer those first. A personal team cannot be deleted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(DeleteSchema, "delete_team arguments", rawArgs);
      await mapped(() => deleteTeam(ctx.db, actorOf(ctx), args.id));
      return textResult({ deleted: args.id });
    },
  });

  mcp.registerTool({
    name: "add_team_member",
    permission: "teams:manage",
    description:
      "Admins and team-managers (teams:manage): add a user, named by their login subject, to a team. A user who has not signed in yet is created, so access can be arranged ahead of their first login. Adding someone already in the team does nothing. A personal team takes no other members.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { teamId: { type: "string" }, subject: { type: "string" } },
      required: ["teamId", "subject"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(MemberSchema, "add_team_member arguments", rawArgs);
      const actor = actorOf(ctx);
      const user = await resolvePrincipal(validSubject(args.subject), ctx.db);
      await mapped(() => addMember(ctx.db, actor, args.teamId, user.id));
      return textResult({ teamId: args.teamId, subject: args.subject, member: true });
    },
  });

  mcp.registerTool({
    name: "remove_team_member",
    permission: "teams:manage",
    description:
      "Admins and team-managers (teams:manage): remove a user, named by their login subject, from a team. Removing someone who is not a member does nothing. A personal team's only member cannot be removed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { teamId: { type: "string" }, subject: { type: "string" } },
      required: ["teamId", "subject"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(MemberSchema, "remove_team_member arguments", rawArgs);
      const actor = actorOf(ctx);
      const user = await ctx.db.principal.findUnique({ where: { subject: validSubject(args.subject) } });
      if (user) await mapped(() => removeMember(ctx.db, actor, args.teamId, user.id));
      return textResult({ teamId: args.teamId, subject: args.subject, member: false });
    },
  });

  mcp.registerTool({
    name: "set_team_roles",
    permission: "teams:manage",
    description:
      "Admins (teams:manage): replace the wardby roles a team carries; every member holds them in addition to their own. Admin only, so a team-manager cannot grant roles. Unknown role names are refused. A personal team carries no roles.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" }, roles: { type: "array", items: { type: "string" } } },
      required: ["id", "roles"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(RolesSchema, "set_team_roles arguments", rawArgs);
      return textResult(teamView(await mapped(() => setTeamRoles(ctx.db, actorOf(ctx), args.id, args.roles))));
    },
  });
}
