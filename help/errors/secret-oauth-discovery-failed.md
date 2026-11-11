---
id: errors/secret-oauth-discovery-failed
title: The service has no usable OAuth metadata
summary: Connecting an OAuth secret failed because the resource does not publish the OAuth metadata Wardby needs.
audience: operator
tags: [error, secrets, oauth, secret_oauth_discovery_failed]
appliesTo: ">=0.9.10"
---

# The service has no usable OAuth metadata

## What happened

The message is `secret_oauth_discovery_failed: the resource has no usable OAuth metadata (it needs protected-resource and authorization-server metadata with PKCE S256)`. Wardby could not find OAuth discovery documents for the `resource` URL, or they do not support PKCE `S256`.

## What to do

1. Check that `oauth.resource` is the service's exact https URL (for an MCP server, its MCP endpoint, such as `https://mcp.example.com/mcp`).
2. Check with the service that it supports OAuth with protected-resource and authorization-server metadata.
3. If the service cannot be reached from Wardby's host, check the host's outbound network policy.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md#oauth-secrets).
