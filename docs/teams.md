# Teams

A team is a named set of equal members. Teams let you grant platform roles to a
group of people instead of one user at a time.

This guide covers creating and managing teams, their members, and the roles
they carry. For roles and scopes in general, see
[getting-started-identity-provider.md](getting-started-identity-provider.md).

## Personal teams

Every user has a **personal team**: a team of one, created together with the
user. It cannot be renamed, deleted, linked, given roles or given other
members, and it is always listed for its user. Upgrading an existing deployment
creates one for every existing user; nobody gains or loses access.

## Managing teams

These tools need the `teams:manage` scope on the token **and** a role that
grants it: `admin` or `team-manager`.

| Tool                                | Does                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| `create_team`                       | Create a team. Names are unique, 1 to 64 characters.            |
| `rename_team`                       | Rename a team.                                                  |
| `delete_team`                       | Delete a team with its memberships and grants.                  |
| `add_team_member`                   | Add a user, named by their login subject, to a team.            |
| `remove_team_member`                | Remove a user from a team.                                      |
| `set_team_roles` (`admin` only)     | Replace the Wardby roles the team carries.                      |
| `list_teams` (any signed-in caller) | List your teams; a manager with `teams:manage` sees every team. |

- The name prefix `personal:` is reserved.
- A user who has not signed in yet is created when you add them, so you can
  arrange membership ahead of their first login.
- Adding a member who is already in the team, or removing one who is not, does
  nothing.
- A team cannot be a member of another team.

## Agents and other resources a team owns

A team can own agents, budget groups, tools, MCP servers, documents, secrets, datastores and webhooks. Every
member acts as an owner of what their team owns: they can read and change it and
grant access to it, with no per-person grant. A grant made to a team reaches every member at the granted level.
Removing a member takes this away on their next request. The token's scope still
caps what a member can do, so a member whose token only carries a read scope
cannot change a team agent. Members bind the team's own secrets and datastores
to the team's agents and grant tool capabilities as the team (the runner honours
them while the team still owns the agent); a member's personal secret or datastore
cannot be bound to a team agent.

A team that owns an agent also stands in for its owner on repository access.
The team has no GitHub account, so wardby checks the linked GitHub account of
each member (the oldest 20; members without one are skipped) and the agent may
use a repository when at least one current member has the access it needs: write
for a write link, read for a read link. Removing a member takes effect on the
next check; losing GitHub access takes effect when the cached answer expires
(5 minutes). Moving an agent to a team with `make_owner` keeps its repository
links working with no re-linking. `make_owner` takes a principal id, not a team
id: read the team's `principalId` from `create_team` or `list_teams` and pass it
as `ownerId`. See
[code-review-agents.md](code-review-agents.md#who-may-give-an-agent-a-repository).

## Roles carried by a team

A team can carry any Wardby role. Every member holds the team's roles in
addition to the roles they have on their own, including roles mapped from your
identity provider (`AUTH_ROLE_CLAIM`). Roles only ever add up: nothing in a team
removes a role another source grants. Membership is read on every request, so
removing someone takes effect on their next call.

A role still needs its scope on the token. A team carrying `model-manager`
lets its members change the model catalog only when their token also has
`models:admin`.

Only an `admin` (or `wardby_owner`, which includes every `admin` permission) can
set a team's roles. Carrying `wardby_owner` gives every member access to every
owner's resources, so give it to people, not teams. A `team-manager` cannot escalate
anyone, including themselves. To create a team of administrators, create a team,
add the people, and give it the `admin` role.

## Deleting a team

`delete_team` removes the team, its memberships, and the access grants it
received. It is refused with a 409 while the team still owns a resource, and the
error says what it owns.

## Errors

| Status | Meaning                                                                               |
| ------ | ------------------------------------------------------------------------------------- |
| 400    | Invalid input: empty or over-long name, reserved prefix, unknown role, personal team. |
| 403    | The caller lacks the scope, the role, or (for `set_team_roles`) the `admin` role.     |
| 404    | The team does not exist.                                                              |
| 409    | The name is taken, or the team still owns resources.                                  |

## Upgrading

The release adds the `teams:manage` scope and the `team-manager` role. In
delegating mode, define `teams:manage` in your identity provider and map it like
`agents:admin`, or clients that request every advertised scope fail with
`invalid_scope`. The database migration is additive.
