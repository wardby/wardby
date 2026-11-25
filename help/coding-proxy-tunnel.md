---
id: coding-proxy-tunnel
title: CONNECT tunnel for coding runs
summary: Let a coding run reach a short allowlist of HTTPS hosts through the coding proxy's CONNECT tunnel, with per-agent hosts and *.domain or * patterns (codingProfile.tunnelHosts, CODING_TUNNEL_AGENT_HOSTS), per-run limits and an audit record, without opening direct network access.
audience: operator
tags:
  [
    coding-agents,
    proxy,
    tunnel,
    connect,
    https-proxy,
    allowlist,
    egress,
    docker-build,
    no-proxy,
    launcher,
    tunnelHosts,
    tunnel-hosts,
    per-agent,
    wildcard,
    pattern,
    CODING_TUNNEL_AGENT_HOSTS,
    playwright,
    browser,
  ]
appliesTo: ">=0.10.2"
---

# CONNECT tunnel for coding runs

The coding proxy can listen on a second port for `CONNECT` requests, so a run
can reach a few HTTPS hosts (a container build pulling a base image, a tool
downloading a database) when `HTTPS_PROXY` and `HTTP_PROXY` point at it. It is
off unless `CODING_TUNNEL_PORT` is set.

The tunnel is blind by default: TLS runs end to end, so the proxy sees no URL,
header or content and adds no credential. It checks the host and the limits, then
passes bytes. A host with an interception rule is the exception (see below). The registry checks (allowlist, release-age rule, advisory audit,
lockfile plan) do not apply to anything sent through it. Keep package installs
on the [registry routes](coding-packages.md).

## Settings on the coding proxy

- `CODING_TUNNEL_PORT`: the port. Unset is off. Not 8787 or 8788.
- `CODING_TUNNEL_ALLOWED_HOSTS`: comma-separated bare hostnames every run may
  reach (required while `CODING_TUNNEL_AGENT_HOSTS` is `off`, may be empty
  otherwise). No IP addresses, wildcards, ports or paths; names match exactly.
- `CODING_TUNNEL_AGENT_HOSTS`: the ceiling on per-agent hosts (below): `off`
  (default), `exact`, `pattern` or `any`.
- `CODING_TUNNEL_MAX_CONNECTIONS` (16), `CODING_TUNNEL_MAX_BYTES` (4 GiB),
  `CODING_TUNNEL_IDLE_MS` (120000), `CODING_TUNNEL_MAX_DURATION_MS` (1800000).

The proxy refuses to start on an invalid combination, and the error names the
setting, never its value. In the Helm chart these are `codingProxy.tunnel.*`.

## Per-agent tunnel hosts

An agent's owner can give that agent's runs alone more hosts, in
`codingProfile.tunnelHosts` (`create_agent` / `update_agent`, 1 to 50 entries,
`[]` removes them):

- `api.example.com`: that exact host;
- `*.example.com`: any subdomain at any depth, not `example.com` itself;
- `*`: any public host.

The operator's `CODING_TUNNEL_AGENT_HOSTS` sets the ceiling: `off` (none, the
default), `exact`, `pattern` (also `*.domain`) or `any` (also `*`). `*` also needs
an admin (`agents:admin` with the admin role, as for `repositoryAdminOverride`);
the profile records who approved it (`tunnelAnyHostAuthorizedById`, `...At`).
Saving refuses, with [tunnel_hosts_invalid](errors/tunnel-hosts-invalid.md), IP
addresses, ports, schemes, paths, `*` inside a label, a public suffix (`*.com`,
`*.co.uk`, `*.github.io`, from the public suffix list), anything above the
ceiling, and anything while it is `off`.

Dispatch pins the entries the ceiling allows then onto the run's proxy session: an
edit to the agent does not change a running run. Codex and Claude Code runs work
the same way. The proxy allows a host on the server list or matching one of the
run's entries (case-insensitive, on a label boundary), within its own
`CODING_TUNNEL_AGENT_HOSTS`, so set it on both. Port 443, the private and metadata
address block (`*` never reaches an internal network), the per-run limits and the
session checks apply as always, and interception rules stay exact and server-wide.

`get_agent` shows the entries (with a warning for any above a lowered ceiling),
`get_run` the entries a run was given (`tunnelHosts`), and `list_agent_links`
notes `tunnel:<entry>` (`tunnel:*`) on each agent that has them. `*` lets a run
send what it holds to any public host: allow it only where that is acceptable.
See the [guide](../docs/coding-proxy-tunnel.md#per-agent-tunnel-hosts).

## From a coding service

A service (a headless Chromium, say) shares the run's network but gets no
`HTTPS_PROXY` or token. The agent passes them at use time, for example with
Playwright over CDP:

```js
const tunnel = new URL(process.env.HTTPS_PROXY); // carries the token: never print it
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = await browser.newContext({
  proxy: {
    server: `${tunnel.protocol}//${tunnel.host}`,
    username: decodeURIComponent(tunnel.username),
    password: decodeURIComponent(tunnel.password),
  },
});
```

See [coding services](coding-services.md#services-that-reach-the-internet-a-headless-browser).

## TLS interception for a credentialed host

For a host that needs a credential the run must not hold, the proxy can decrypt
that host's traffic and attach the credential. Set all of these on the proxy only:
`CODING_TUNNEL_INTERCEPT_RULES` (a JSON array of `{host, scheme, credential}`,
with `username` or `usernameCredential` (an `env:NAME` reference) for `basic`;
`credential` is an `env:NAME` reference and each host must also be allowlisted;
or `{host, scheme: "gcp"}`, which sends an access token for the proxy's own Google
service account, fetched from the metadata server and refreshed before it expires), and the CA
certificate and key, each as PEM text (`CODING_TUNNEL_INTERCEPT_CA_CERT`,
`CODING_TUNNEL_INTERCEPT_CA_KEY`) or as a file path (`..._CERT_FILE`, `..._KEY_FILE`), one form each. Create the CA with
`wardby coding intercept-ca --host <host> --out <dir>`: it is limited to the hosts
you name and never overwrites a file. `--unconstrained` (instead of `--host`) makes a CA with no name
constraint, so one CA serves any host that has a rule; a leaked key could then sign for any host, so the
command warns and the proxy logs `intercept.ca_unconstrained`. The run's TLS server name must equal the
tunnelled host, its own `Authorization` is always replaced, and redirects are
relayed, never followed. To make runs trust the CA, set
`CODING_TUNNEL_TRUST_CA_CERT` on the control plane to the text of `ca.crt` (or
`CODING_TUNNEL_TRUST_CA_CERT_FILE` to its path; public only, never the key). Each run then gets it at
`.cache/tunnel/ca.crt` with `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` and `PIP_CERT` set to
it. `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE` are left unset because they replace the
roots: a client that reads none of the three needs `ca.crt` in its own trust store. The credential is read at
start-up and not refreshed, so use a long-lived one. A registry that redirects downloads
to signed object-store URLs needs that store's host allowed too, as a blind tunnel with no
rule (a shared host: it allows every tenant on it). In Helm:
`codingProxy.tunnel.intercept.rules`, with the CA in `codingProxy.extraEnv` and the certificate in `controlPlane.extraEnv`. See the
[guide](../docs/coding-proxy-tunnel.md) for the details.

## What the launcher does

With the Docker or Kubernetes launcher, set `CODING_TUNNEL_PORT`,
`CODING_TUNNEL_ALLOWED_HOSTS` and `CODING_TUNNEL_AGENT_HOSTS` on the control plane
as well as the proxy (the Helm chart does both from `codingProxy.tunnel.*`,
including `agentHosts`). Each run's commands then get
`HTTPS_PROXY` and `HTTP_PROXY` (both cases) pointing at the tunnel with a
tunnel-only token, and `NO_PROXY` for the proxy's own address. On Kubernetes the
run's NetworkPolicy also admits the tunnel port. The Substrate launcher does not
use the tunnel yet. The token is in the variable, so a command that prints its
environment prints it: it opens the allowlisted hosts and the run's own entries,
and nothing else.

## What a client has to do

- Send `CONNECT host:443` with the run's tunnel token as the password in
  `Proxy-Authorization` (Basic).
- Set both `HTTPS_PROXY` and `HTTP_PROXY` to the tunnel, so a plain `http://`
  request gets a clear refusal. Plain `http://` is never forwarded.
- Put the proxy's own address in `NO_PROXY`, or registry and model requests
  will try to go through the tunnel.

## Refusal codes

Every refusal is a JSON body `{"error": {"type": "<code>", "message": "<code>"}}`
and carries no host, token or header value.

- [tunnel_auth_required](errors/tunnel-auth-required.md) (407)
- [tunnel_session_ended](errors/tunnel-session-ended.md) (403)
- [tunnel_bad_target](errors/tunnel-bad-target.md) (400)
- [tunnel_host_not_allowed](errors/tunnel-host-not-allowed.md) (403)
- [tunnel_port_not_allowed](errors/tunnel-port-not-allowed.md) (403)
- [tunnel_limit](errors/tunnel-limit.md) (429)
- [tunnel_destination_blocked](errors/tunnel-destination-blocked.md) (403)
- [tunnel_upstream_failed](errors/tunnel-upstream-failed.md) (502)
- [tunnel_unavailable](errors/tunnel-unavailable.md) (503)
- [tunnel_connect_only](errors/tunnel-connect-only.md) (405)

Inside the run's TLS for an intercepted host:

- [intercept_bad_request](errors/intercept-bad-request.md) (400)
- [intercept_destination_blocked](errors/intercept-destination-blocked.md) (403)
- [intercept_upstream_failed](errors/intercept-upstream-failed.md) (502)

## Audit and metrics

Each tunnel that reaches an authenticated run writes one `audit.tunnel` log
record: run id, host, `matchedBy` (`server`, or the run's entry that allowed the
host), bytes each way, start, duration and how it ended
(`closed`, `idle_timeout`, `max_duration`, `session_ended`, `byte_cap`,
`client_error`, `upstream_error` or `shutdown`) or the refusal code. A decrypted
tunnel also records `intercepted.requests`. The host is left out when a
`*.domain` or `*` entry allowed it, or it was refused: that text is the run's own.
Requests
are counted under `protocol="tunnel"` in `wardby_proxy_http_requests_total`.
