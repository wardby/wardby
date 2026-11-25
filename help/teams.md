---
id: teams
title: Manage teams and their roles
summary: Create teams, add members, and give a team Wardby roles, using the team tools and the teams:manage scope.
audience: operator
tags:
  [
    teams,
    members,
    roles,
    access-control,
    admin,
    team-manager,
    personal team,
    make_owner,
    move agent to team,
    principalId,
  ]
appliesTo: ">=0.10.2"
---

# Manage teams and their roles

A team is a named set of equal members. Every user also has a personal team of
one, which cannot be renamed, deleted or given members.

## Create and populate a team

1. `create_team` with a `name`.
2. `add_team_member` with the team's `teamId` and the person's login `subject`.
   A user who has not signed in yet is created, so you can add them early.
3. `list_teams` shows your teams. An admin or team-manager whose token has
   `teams:manage` sees every team and its members.

`rename_team`, `delete_team` and `remove_team_member` do the obvious. Deleting
a team is refused (409) while it owns a resource.

## Teams and what they own

A team can own agents, budget groups, tools, MCP servers, documents, secrets, datastores and webhooks. Every
member acts as an owner of what their team owns: they can read and change it, and
grant access to it, with no per-person grant. A grant made to a team reaches every member at the granted level. Removing
a member takes this away on their next request. A token's scope still caps what a
member can do, so a member holding only a read scope cannot change a team agent.
Members bind the team's own secrets and datastores to the team's agents and
grant tool capabilities as the team; a member's personal secret or datastore
cannot be bound to a team agent. A stranger can bind nothing. See `sharing-agents`.

A team that owns an agent also stands in for its owner on repository access:
Wardby checks each member's linked GitHub account (the oldest 20; members
without one are skipped) and the agent may use a repository when at least one
current member has the access it needs (write for a write link, read for a read
link). Moving an agent to a team with `make_owner` keeps its repository links
working. `make_owner` takes the team's `principalId` (shown by `create_team` and
`list_teams`) as `ownerId`, not the team id, so to move an agent to a team, read
that id and pass it. See `errors/repo-access` if a check fails.

## Give a team roles

`set_team_roles` replaces the Wardby roles a team carries. Members hold them in
addition to their own, and a privileged role still needs its scope on the token.
Only an `admin` (or `wardby_owner`) can do this; a `team-manager` cannot.
Do not give a team `wardby_owner` unless every member should reach every owner's
resources; see [Configure identity and privileged access](identity-and-access.md).

To make a team of administrators: create the team, add the people, then
`set_team_roles` with `["admin"]`.

## Who can do what

The managing tools need the `teams:manage` scope and the `admin` or
`team-manager` role. See
[Configure identity and privileged access](identity-and-access.md) and the
[teams guide](../docs/teams.md).

## If a call fails

- **403**: the token lacks `teams:manage`, you lack the role, or you called
  `set_team_roles` without the `admin` role.
- **409**: the name is already taken, or the team still owns resources.
- **400**: the name is empty, too long or starts with `personal:`, or a role
  name is unknown.
