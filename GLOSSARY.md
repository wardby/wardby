# wardby

Self-hosted control plane that runs budget-guarded agents. This glossary fixes
the words used for who owns and uses things.

## Language

**Principal**:
The identity that owns resources and holds grants, identified by a unique subject. A User, a shared Team and a Personal team each have one.
_Avoid_: Account, identity

**User**:
A person who signs in: a Principal that is not a shared Team's backing principal, usually with a profile (name, email).
_Avoid_: Member (that means a Team's member), AuthUser (a self-hosted sign-in record, absent when an external identity provider is used)

**Team**:
A named group of Users that owns resources and holds roles. Backed by its own Principal.
_Avoid_: Group (that means an identity-provider group)

**Personal team**:
The Team every User has, whose backing Principal is the User's own Principal.
_Avoid_: Default team

## Access

**Scope**:
A coarse, stable capability a client may ask for and a token carries. It is the ceiling on what a token can do, never the grant itself.
_Avoid_: Permission (a different thing), privilege

**Permission**:
A fine-grained action a Principal may perform, resolved inside wardby. New features add Permissions, never Scopes.
_Avoid_: Scope (a different thing), right, privilege

**Role**:
A named set of Permissions granted to a User directly (from the identity provider) or through a Team.
_Avoid_: Group (that means an identity-provider group)

**Grant**:
A level of access to one resource given to a Principal, a Team's Principal, or everyone. Ownership is separate and always the highest level.
_Avoid_: Share, ACL

**Wardby owner**:
A User with the `wardby_owner` Role and an owner-tier token, who bypasses per-resource ownership and Grants.
_Avoid_: Superuser, root, resource owner (that is the Principal a resource belongs to)
