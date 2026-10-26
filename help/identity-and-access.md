---
id: identity-and-access
title: Configure identity and privileged access
summary: Protect remote MCP access with an OAuth/OIDC provider and restrict sensitive operations with scopes and roles.
audience: operator
tags: [identity, oauth, oidc, access-control, mcp]
appliesTo: >=0.2.1
---

# Configure identity and privileged access

Local stdio MCP created by `wardby quickstart` trusts the local operator. A
shared HTTPS deployment needs an OAuth/OIDC identity provider. In delegating
mode, that provider authenticates the caller and issues a signed JWT access
token; Wardby verifies the token and enforces its scopes without administering
the provider's users or exchanging authorization codes.

Set the provider's resource audience, `MCP_CANONICAL_URI`, and `AUTH_AUDIENCE`
to the exact same public MCP URL. Tokens need a stable subject, expiry, issuer,
audience, and the granted Wardby scopes in `scope` or `scp`.

Scopes authorize normal operations such as managing agents, runs, tools,
datastores, secrets, webhooks, budgets, packages, services, memory, and
models. Six sensitive permissions have an additional role requirement:

- `agents:admin` requires the Wardby `admin` role.
- `packages:approve` requires the `admin` or `package-approver` role.
- `services:manage` requires the `admin` or `service-manager` role.
- `admin:view` requires the `admin` role. It opens the read-only, deployment-wide
  admin viewer API; see [Watch live runs with the admin viewer API](admin-viewer.md).
- `models:admin` requires the `admin` or `model-manager` role. It adds,
  overrides, disables, and resets model catalog entries; see
  [Models and pricing](models.md).
- `power:manage` requires the `admin` role. It reads low-power state and
  sleeps the coding proxy and native gateway now (`power_status`,
  `power_sleep`); see
  [Low-power mode](../docs/getting-started-gke.md#low-power-mode).

Map roles only from an IdP claim that users cannot self-assign. Removing a
role affects the next token the caller receives.

When you upgrade a delegating-mode deployment, define any newly advertised
scope, such as `admin:view`, in the provider before deploying. Clients
that request every advertised scope otherwise fail with `invalid_scope`.

Read [`docs/getting-started-identity-provider.md`](../docs/getting-started-identity-provider.md)
for the required claims, scope list, role mapping, provider examples, and
client registration.

To share an agent with one person or with everyone signed in, see [Share an agent, or make it public](sharing-agents.md).
