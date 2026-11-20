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
