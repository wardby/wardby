---
id: errors/secret-oauth-discovery-failed
title: The service has no usable OAuth metadata
summary: Connecting an OAuth secret failed because the resource does not publish the OAuth metadata Wardby needs.
audience: operator
tags:
  [
    error,
    secrets,
    oauth,
    secret_oauth_discovery_failed,
    oauth discovery,
    protected-resource metadata,
    authorization-server metadata,
  ]
appliesTo: ">=0.9.11"
---

# The service has no usable OAuth metadata

## What happened

The message is `secret_oauth_discovery_failed: the resource has no usable OAuth metadata (tried its protected-resource metadata, then, when it has none, authorization-server metadata at its origin; it needs authorization-server metadata with PKCE S256)`.

Wardby tried, in order:

1. The `resource_metadata` URL in the `WWW-Authenticate` header of the resource's `401` answer, if it names one.
2. Otherwise, protected-resource metadata (RFC 9728) at
   `/.well-known/oauth-protected-resource/<path>`, then
   `/.well-known/oauth-protected-resource`.
3. Only when step 2 found no document at all (every URL answered `4xx`): authorization-server metadata at the
   resource's **origin**, the older MCP authorization flow (spec version 2025-03-26).
4. Authorization-server metadata (RFC 8414, then OpenID discovery) for the authorization server that step 1, 2
   or 3 named.

Discovery then fails in one of two ways:

- **No metadata at all.** Nothing answered at any of those URLs, or a `resource_metadata` URL from the
  challenge did not answer. Wardby never guesses default `/authorize`, `/token` or `/register` endpoints.
- **Unsupported shape.** A document was found but cannot be used: protected-resource metadata for a different
  `resource`, an `issuer` that is not the authorization server (with the origin fallback: not exactly the
  resource's origin), no PKCE `S256`, `grant_types_supported` without `authorization_code`, or an endpoint that
  is not https or not allowed by the fetch policy.

## What to do

1. Check that `oauth.resource` is the service's exact https URL (for an MCP server, its MCP endpoint, such as `https://mcp.example.com/mcp`).
2. To tell the two cases apart, request the URLs above yourself, for example
   `curl -i https://mcp.example.com/.well-known/oauth-protected-resource` and
   `curl -i https://mcp.example.com/.well-known/oauth-authorization-server`. If every one answers `404`, the
   service publishes no metadata; ask it for OAuth discovery support. If one answers `200`, check its
   `issuer`, endpoints and `code_challenge_methods_supported` against the list above.
3. If the service cannot be reached from Wardby's host, check the host's outbound network policy.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md#oauth-secrets).
