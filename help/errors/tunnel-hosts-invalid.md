---
id: errors/tunnel-hosts-invalid
title: Tunnel hosts refused (tunnel_hosts_invalid)
summary: create_agent or update_agent refused codingProfile.tunnelHosts because an entry is malformed, a public suffix, above the operator's CODING_TUNNEL_AGENT_HOSTS ceiling, or per-agent hosts are off.
audience: operator
tags:
  [
    error,
    coding-agents,
    proxy,
    tunnel,
    tunnel_hosts_invalid,
    tunnelHosts,
    tunnel-hosts,
    CODING_TUNNEL_AGENT_HOSTS,
    wildcard,
    pattern,
    public-suffix,
  ]
appliesTo: ">=0.10.2"
---

# tunnel_hosts_invalid

`tunnel_hosts_invalid` is how `create_agent` and `update_agent` refuse
`codingProfile.tunnelHosts`, the hosts an agent's coding runs may reach through
the coding proxy's [CONNECT tunnel](../coding-proxy-tunnel.md) on top of the
server list. Nothing is saved. The message says which entry (counting from 0)
and why.

## Causes and fixes

- **Per-agent tunnel hosts are off.** The operator has not set
  `CODING_TUNNEL_AGENT_HOSTS` (it defaults to `off`), or the tunnel itself is off
  (`CODING_TUNNEL_PORT` unset). Only the server list,
  `CODING_TUNNEL_ALLOWED_HOSTS`, applies. Send `tunnelHosts: []`, or ask the
  operator to set the ceiling.
- **Above the ceiling.** `exact` allows exact hosts only; `pattern` also allows
  `*.example.com`; only `any` allows `*`. Use a narrower entry, or ask the
  operator.
- **Not a bare hostname.** IP addresses, ports (`:8443`), schemes
  (`https://`), paths, user names and queries are refused. Write
  `api.example.com`, not `https://api.example.com/v1`. Only port 443 is ever
  tunnelled.
- **`*` in the wrong place.** `*` may stand alone (any public host) or be the whole
  first label (`*.example.com`, any subdomain at any depth). `ex*.com`,
  `a.*.example.com` and `*example.com` are refused.
- **A public suffix.** A top-level domain or public suffix (`com`, `*.com`,
  `*.co.uk`), checked against the public suffix list, would cover unrelated sites.
  For patterns this includes shared-hosting suffixes such as `*.github.io` and
  `*.s3.amazonaws.com`, which cover every tenant on them. Name the registrable
  domain you mean (`*.example.co.uk`), or the exact hosts on the shared suffix.
- **More than 50 entries.** Prefer one `*.domain` pattern over many exact hosts.

`*` is not refused with this code when the caller lacks the right: it needs
`agents:admin` with the admin role, and a caller without them gets the usual
scope or role refusal. The admin's approval is recorded on the profile.

An entry that is saved can still be left out of a run later, if the operator
lowers the ceiling: `get_agent` then warns which entries runs no longer get, and
`get_run` shows what each run was given. See
[Per-agent tunnel hosts](../../docs/coding-proxy-tunnel.md#per-agent-tunnel-hosts).
