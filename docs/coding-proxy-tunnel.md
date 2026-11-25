# CONNECT tunnel for coding runs

The coding proxy can offer a second listener, a `CONNECT` tunnel, to runs that
need to reach a short list of HTTPS hosts directly: a container build pulling a
base image, a tool that downloads a database. The run sets `HTTPS_PROXY` and
`HTTP_PROXY` to the tunnel, and the proxy opens the connection for it. It is off
unless you set `CODING_TUNNEL_PORT`.

The tunnel is **blind** by default. TLS runs end to end between the run and the
host, so the proxy never sees a URL, a header or a byte of content, and it adds no
credential. It decides only whether the host may be reached, and how much. For the
few hosts that need a credential the run must not hold, you can turn on
[TLS interception](#tls-interception-for-a-credentialed-host) for those hosts
alone; every other host stays blind.

## What it is not

- It does not replace the [registry proxy](coding-packages.md). A run's own npm
  and PyPI installs keep using the registry routes, with the allowlist, the
  release-age rule, the advisory audit and the lockfile checks.
- None of those package checks apply to traffic through the tunnel. Whatever a
  tunnelled host serves reaches the run as it is. Keep the allowlist short, and
  prefer hosts you control or mirror.
- It is not a general internet proxy: allowlisted hostnames, port 443 only. An
  agent can be given more hosts, or patterns, only if you allow it (see
  [Per-agent tunnel hosts](#per-agent-tunnel-hosts)).
- Shared hosts widen the allowlist more than they look. Allowing a host that
  serves many unrelated tenants (an object store, a CDN) allows all of them.

## Settings

Set these on the coding proxy. Set `CODING_TUNNEL_PORT`,
`CODING_TUNNEL_ALLOWED_HOSTS` and `CODING_TUNNEL_AGENT_HOSTS` on the control plane
too, to the same values: the Docker and Kubernetes launchers read them to point
each run at the tunnel (see [Configuring a run](#configuring-a-run)), and the
control plane checks agents' tunnel hosts against the ceiling. The limits matter
only to the proxy.

- `CODING_TUNNEL_PORT`: the port the tunnel listens on. Unset turns the tunnel
  off. It must differ from the proxy's own port (8787) and its deny port (8788).
- `CODING_TUNNEL_ALLOWED_HOSTS`: comma-separated hostnames every run may tunnel
  to. Required when the tunnel is on and `CODING_TUNNEL_AGENT_HOSTS` is `off`;
  may be empty otherwise. Bare hostnames only: no IP addresses, wildcards, ports,
  schemes or paths. A name matches exactly, so allowing `example.com` does not
  allow `sub.example.com`.
- `CODING_TUNNEL_AGENT_HOSTS`: the ceiling on hosts an agent's owner may add for
  that agent's runs alone (`codingProfile.tunnelHosts`): `off` (the default: only
  the server list applies), `exact` (exact hosts), `pattern` (also `*.domain`) or
  `any` (also `*`, any public host). See
  [Per-agent tunnel hosts](#per-agent-tunnel-hosts).
- `CODING_TUNNEL_MAX_CONNECTIONS`: open tunnels per run. Default 16.
- `CODING_TUNNEL_MAX_BYTES`: bytes per run, both directions together, across all
  its tunnels. Default 4 GiB.
- `CODING_TUNNEL_IDLE_MS`: how long a tunnel may carry no data before it is
  closed. Default 120000.
- `CODING_TUNNEL_MAX_DURATION_MS`: how long one tunnel may stay open. Default 1800000. The idle time may not exceed it.

To intercept TLS for a credentialed host (see
[TLS interception](#tls-interception-for-a-credentialed-host)), set these on the
coding proxy only, all three together:

- `CODING_TUNNEL_INTERCEPT_RULES`: a JSON array with one object per intercepted
  host: `host`, `scheme` (`bearer` or `basic`), `credential` (an `env:NAME`
  reference to a variable on the proxy, holding the token or password), and for
  `basic` exactly one of `username` (written out) or `usernameCredential` (an
  `env:NAME` reference to a variable holding the user name). `bearer` sends
  `Authorization: Bearer <credential>`; `basic` sends the user name and credential as
  HTTP Basic, which is what an Artifactory user and token pair needs. Each host
  must also be in `CODING_TUNNEL_ALLOWED_HOSTS`, and may appear once.
  `scheme: "gcp"` takes no `credential` or user name: the proxy sends
  `Authorization: Bearer <access token>` for its own Google service account
  (its Workload Identity on GKE), so a Google Artifact Registry host such as
  `us-docker.pkg.dev` gets exactly the access that service account has been
  granted. See [A Google service account's token](#a-google-service-accounts-token).
- The CA certificate and its private key, each in one of two forms: `CODING_TUNNEL_INTERCEPT_CA_CERT`
  and `CODING_TUNNEL_INTERCEPT_CA_KEY` hold the PEM text itself (a multi-line value, as a Kubernetes
  `secretKeyRef` delivers it), or `CODING_TUNNEL_INTERCEPT_CA_CERT_FILE` and
  `CODING_TUNNEL_INTERCEPT_CA_KEY_FILE` hold absolute paths to the files. Set one form for each; setting both
  forms for the same item, or only one of the pair, is refused. A key in an environment variable is readable by
  anything that can read the proxy's environment, so scope the Secret to the proxy.

To have runs trust that CA, set this on the control plane (the Docker and
Kubernetes launchers read it):

- `CODING_TUNNEL_TRUST_CA_CERT` or `CODING_TUNNEL_TRUST_CA_CERT_FILE`: the CA certificate
  (`ca.crt`, public) as PEM text, or the absolute path of its file; not both. Never the
  key. The control plane reads it once at start-up and refuses to start when the file is
  missing or the value holds anything but certificate blocks.

The proxy, and the control plane when it launches coding runs, refuse to start on an invalid combination: a bad port or limit, an
empty allowlist while `CODING_TUNNEL_AGENT_HOSTS` is `off`, a malformed allowlist,
a `CODING_TUNNEL_AGENT_HOSTS` other than the four levels, or any `CODING_TUNNEL_*`
setting without the port.
The error names the setting and never repeats its value.

## Per-agent tunnel hosts

The server list applies to every run. When one agent needs more, for example an
agent that drives a headless browser through a web app's screens and needs the
app's whole domain, its owner can list hosts for that agent's runs alone, in
`codingProfile.tunnelHosts` (`create_agent` or `update_agent`). No other agent's
runs get them.

Each entry is one of:

- `api.example.com`: that exact host;
- `*.example.com`: any subdomain of `example.com`, at any depth
  (`a.example.com`, `a.b.example.com`), but not `example.com` itself. List it too
  if the run needs it;
- `*`: any public host.

An agent may list 1 to 50 entries; `[]` removes them. Entries are matched
case-insensitively, after a trailing dot is dropped and an international name is
converted to its ASCII form. The match is on a label boundary, so
`*.example.com` does not match `evilexample.com`.

The entries an agent may hold depend on `CODING_TUNNEL_AGENT_HOSTS`:

| `CODING_TUNNEL_AGENT_HOSTS` | Exact hosts | `*.domain` | `*`               |
| --------------------------- | ----------- | ---------- | ----------------- |
| `off` (default)             | no          | no         | no                |
| `exact`                     | yes         | no         | no                |
| `pattern`                   | yes         | yes        | no                |
| `any`                       | yes         | yes        | with admin review |

Saving the agent refuses, with `tunnel_hosts_invalid`:

- any entry while the ceiling is `off` (or the tunnel itself is off), and an
  entry above the ceiling;
- IP addresses, ports, schemes, paths, user names and queries;
- `*` anywhere but alone or as the whole first label (`ex*.com`, `a.*.example.com`);
- a top-level domain or public suffix, checked against the public suffix list:
  `com`, `*.com`, `*.co.uk`, and, for patterns, the list's shared-hosting
  suffixes too (`*.github.io`, `*.s3.amazonaws.com`), which would cover every
  tenant on them. An exact host on such a suffix (`s3.amazonaws.com`) is
  accepted.

Patterns at or below the ceiling need only ownership of the agent. `*` also needs
an admin: the caller needs `agents:admin` with the admin role, as for
`repositoryAdminOverride`. The profile records who approved it and when
(`tunnelAnyHostAuthorizedById`, `tunnelAnyHostAuthorizedAt`). The approval stays
while `*` stays on the list, and is cleared when `*` is removed; adding it again
needs an admin again.

### How a run gets them

1. When a run is dispatched, the control plane reads the agent's hosts, keeps
   those the ceiling allows at that moment (and `*` only with its recorded
   approval), and pins them on the run's proxy session, next to its tunnel token.
   An edit to the agent after that does not change the running run; the next run
   gets the new list. Codex and Claude Code runs are handled the same way.
2. The tunnel allows a target that is on the server list, or that matches one of
   the run's pinned entries. The proxy applies its own `CODING_TUNNEL_AGENT_HOSTS`
   too, so set it on both: an entry above the proxy's ceiling is ignored.
3. Everything else is unchanged and applies to every tunnel, whatever allowed the
   host: port 443 only, the public-address check (`tunnel_destination_blocked` for
   private, loopback, link-local and metadata addresses, so `*` never reaches an
   internal network, even through a name that resolves to one), the per-run
   connection, byte and duration limits, and the session checks.
4. TLS interception rules stay exact and server-wide. A host allowed only by an
   agent's entry is always a blind tunnel.

If you lower the ceiling later, agents keep their stored entries, and edits that
leave `tunnelHosts` alone still save. Runs are given only what the new ceiling
allows, and `get_agent` warns which entries runs no longer get.

### Seeing who has what

- `get_agent` shows `codingProfile.tunnelHosts` and the approval of `*`.
- `get_run` shows `tunnelHosts`, the entries the run was given at dispatch.
- `list_agent_links` notes `tunnel:<entry>` on every agent that has entries
  (`tunnel:*` for any public host), so a reviewer can see which agents can reach
  the internet.
- Each `audit.tunnel` record says what allowed the host (`matchedBy`, below).

### Security

`*` adds one risk: exfiltration. A run holds repository code and acts on content it
reads, and `*` lets it send that anywhere public. That is why `*` is off unless you
choose `any`, needs an admin on each agent, and is listed per agent. Exact hosts
and `*.domain` patterns keep the server list's posture, per agent instead of per
server. Patterns are matched on the `CONNECT` target's name before any DNS lookup;
a name that resolves, or later rebinds, to a private address is refused by the
address check. Tunnel tokens, logging and redaction are unchanged.

## How a request is handled

A client with `HTTPS_PROXY` set sends `CONNECT host:443` to the tunnel port,
with the run's tunnel token as the password in `Proxy-Authorization` (Basic; the
user name is ignored). The checks run in this order, and the first failure
answers with a fixed JSON error and closes the connection:

1. The token is present and belongs to a session: otherwise `407`
   (`tunnel_auth_required`), with a `Proxy-Authenticate` challenge.
2. The session is still active, and its deadline has not passed: otherwise `403`
   (`tunnel_session_ended`).
3. The target reads as `host:port`: otherwise `400` (`tunnel_bad_target`).
4. The host is not an IP address, and is on the allowlist or matches one of the
   run's [own entries](#per-agent-tunnel-hosts): otherwise `403`
   (`tunnel_host_not_allowed`).
5. The port is 443: otherwise `403` (`tunnel_port_not_allowed`).
6. The run is under its connection and byte limits: otherwise `429`
   (`tunnel_limit`).
7. The host resolves only to public addresses: otherwise `403`
   (`tunnel_destination_blocked`). Private, loopback, link-local and cloud
   metadata addresses are refused, and the connection goes to the address that
   was checked, not to a second lookup.
8. The connection succeeds: otherwise `502` (`tunnel_upstream_failed`).

Then the proxy answers `200 Connection Established`. For an ordinary host it
passes bytes both ways; a host with an interception rule is handled as described
under [TLS interception](#tls-interception-for-a-credentialed-host). A tunnel ends
when either side closes, when it is idle or open too long, when
the run passes its byte limit, when its session ends or is cancelled, or when
the proxy shuts down.

Authentication comes first, so a caller without a valid token learns nothing
about the allowlist.

Anything that is not `CONNECT`, including a plain `http://` request sent to the
proxy, is answered `405` (`tunnel_connect_only`) and never forwarded: a
credential is never attached to a plaintext request. Each error code has an
article in the help index.

## TLS interception for a credentialed host

Some hosts need a credential, such as a private registry that wants a token, and
you do not want the run to hold it. For those hosts only, the proxy can decrypt the
run's traffic and attach the credential itself. The run never sees it.

For a host with a rule, the proxy answers `200` as usual and then terminates the
run's TLS with a certificate it signs for that host. The run's TLS server name must
be exactly the host it asked to tunnel to, or the handshake is refused. Each
request is then sent to the real host over a new TLS connection, to the address the
public-address check approved and with the host's certificate verified normally. The
run's own `Authorization` header is always dropped and replaced with the rule's
credential, and the `Host` header must name the tunnelled host. A redirect is passed
back to the run and never followed, so the credential is never sent to a redirect
target: the run's follow-up goes through its own tunnel, which is blind unless that
host has a rule of its own.

### Setting it up

1. Create the CA once per deployment. It is limited to the hosts you name (a
   critical name constraint, path length 0), so even a leaked key could not sign for
   any other host:

   ```bash
   wardby coding intercept-ca --host registry.example.com --out ./intercept-ca
   ```

   This writes `ca.crt` (public) and `ca.key` (private) and never overwrites an
   existing file. Keep the key in a Secret that only the proxy can read.

   To serve every host that has a rule with one CA, so adding a host needs no new CA,
   pass `--unconstrained` instead of `--host` (the two cannot be combined). That CA has
   no name constraint: a leaked key could sign for any host, to every client that trusts
   the certificate. The command prints a warning, and the proxy logs
   `intercept.ca_unconstrained` at start-up and after each reload that loads such a CA.
   Name the hosts with `--host` whenever you know them up front.

   Or let cert-manager issue and renew it (see [Rotating the CA](#rotating-the-ca)).

2. Put the credential in a variable on the proxy, for example in the secret its
   environment already comes from, and name it in the rule as `env:NAME`.
3. Set the rules and the CA (certificate and key) settings (in Helm,
   `codingProxy.tunnel.intercept.rules`, with the CA in `codingProxy.extraEnv` or
   `codingProxy.tunnel.intercept.caSecret`). The proxy checks the CA at start-up and refuses to
   listen when the certificate is not a CA, has a path length above 0, has a name constraint
   that is not critical or does not permit the rule hosts, is expired, or does not match the
   key. A CA with no name constraint is accepted, with the warning described above. It also
   refuses a credential variable that is unset or is not one line of printable characters.
4. Make runs trust `ca.crt`. Set `CODING_TUNNEL_TRUST_CA_CERT` (or
   `CODING_TUNNEL_TRUST_CA_CERT_FILE`) on the control plane; in Helm, put it in
   `controlPlane.extraEnv`. The launcher
   then places the certificate in each run at `.cache/tunnel/ca.crt` in the workspace
   and sets `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` and `PIP_CERT` to it, so pip, Node
   and tools that read `SSL_CERT_FILE` trust it. All three add to the system roots.
   `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE` are not set: most clients treat them as a
   replacement for the roots, and a file holding only this CA would break TLS to
   every other tunnelled host. A client that reads none of these still needs the
   certificate added to its own trust store. Without the setting, a run is given no
   certificate.

### Things to know

- The credential is read once, when the proxy starts. To rotate it, change the
  variable and restart the proxy. A short-lived token (a cloud access token that
  expires within the hour, for example) is not refreshed, so a rule suits a
  long-lived credential.
- A registry that keeps its files in an object store often answers a download with a
  redirect to a signed URL on that store. The run's follow-up goes through its own
  tunnel, which must also be allowed, as a blind tunnel with no rule. An object store
  is a shared host: allowing it allows every tenant on it (see
  [What it is not](#what-it-is-not)). If the registry can serve downloads itself
  instead of redirecting, every request stays on the intercepted host and nothing
  else needs allowing.
- A CA given as PEM text in the environment is read once. Rotating it means
  updating the Secret and restarting the proxy and the control plane. A CA given as
  files is followed instead (see [Rotating the CA](#rotating-the-ca)).
- Only HTTP/1.1 is served, and a request to upgrade the connection is refused.
- Request and response bodies count toward the run's byte limit and the tunnel's idle
  and maximum durations, like any tunnel. Each request opens its own connection to the
  host, which costs some time on a pull with many layers.
- Whatever an intercepted host answers reaches the run, redirects included. The package
  checks of the registry proxy still do not apply.
- A refusal inside the run's TLS is fixed JSON with one of `intercept_bad_request`
  (400, a `Host` that is not the tunnelled host, a request target that is not a path,
  or an upgrade), `intercept_destination_blocked` (403, the host no longer resolves to
  a public address) or `intercept_upstream_failed` (502, the host could not be
  reached). Each has an article in the help index.

### Rotating the CA

Give the CA as files (`CODING_TUNNEL_INTERCEPT_CA_CERT_FILE` and `_KEY_FILE` on the
proxy, `CODING_TUNNEL_TRUST_CA_CERT_FILE` on the control plane) from a Secret mounted
as a directory. Don't use `subPath`, because the kubelet never updates a `subPath`
mount. A renewed Secret then takes effect without a restart:

- The proxy reads the files again at most once a minute, on the next intercepted
  connection. If the certificate or key changed, it loads the new pair with the same
  checks as at start-up and mints new leaves from it. If the pair can't be read or
  fails a check, the proxy keeps the current CA, logs
  `intercept.ca_reload_failed` with the fixed reason, and tries again a minute
  later. One example is a read that catches the files mid-update.
- The control plane reads the certificate file at each run launch, so the next run
  trusts the new CA. If the read fails, the control plane keeps the last good
  certificate and logs `tunnel_ca.reload_failed`.

With cert-manager, a self-signed `Certificate` with `isCA: true`, critical
`nameConstraints` that permit the rule hosts, and `privateKey.encoding: PKCS8` gives
a CA the proxy accepts. Its Secret goes in `codingProxy.tunnel.intercept.caSecret`.
cert-manager can't set a path length, so the CA has none. The proxy accepts that
because the name constraint also binds any CA signed beneath it. Without
`nameConstraints` the proxy still accepts the CA, with the `intercept.ca_unconstrained`
warning, and nothing limits what a leaked key, or a CA signed beneath it, can sign for.

cert-manager does not reissue a `Certificate` whose `nameConstraints` changed: until the
next renewal its Secret keeps the old constraint, and the proxy refuses to start once a
rule names a host that constraint does not permit. After changing the hosts of a
Certificate you manage yourself, force a new one with `cmctl renew`. The Helm chart can
issue the CA itself and avoid this (`codingProxy.tunnel.intercept.certManager`, see
"Helm" below).

When the key rotates (`privateKey.rotationPolicy: Always`, cert-manager's default),
a run already going loses its intercepted connections once the proxy switches,
because that run trusts only the old certificate. With `rotationPolicy: Never`, the
renewed certificate keeps the same key and subject, and the leaves it signs still
verify against the old certificate. Running runs are then unaffected, but the key
itself never rotates.

## A Google service account's token

A `gcp` rule needs no secret. The proxy asks the metadata server
(`metadata.google.internal`) for an access token for the service account its
pod runs as, the first time an intercepted request to that host needs one.
Access tokens expire after about an hour and the proxy runs far longer, so it:

- reuses the token until five minutes before it expires, then fetches a fresh
  one on the next request (the metadata server hands out a new token by then);
- shares one fetch between requests that arrive together;
- never caches a failure: if the metadata server can't be reached or refuses,
  that request is answered `502` (`intercept_upstream_failed`), the proxy logs
  `intercept.credential_unavailable` with a fixed reason (never the token), and
  the next request tries again.

The proxy's pod must reach the metadata server. The Helm chart admits it in the
proxy's NetworkPolicy whenever a rule uses `gcp`. Grant the service account
only what runs should get through the tunnel (for example
`roles/artifactregistry.reader` on one repository): every run that reaches the
host acts with it.

## Configuring a run

With the Docker or Kubernetes launcher, a run is configured for you when the
control plane has `CODING_TUNNEL_PORT` set. Every command the run starts gets:

- `HTTPS_PROXY` and `HTTP_PROXY`, and their lowercase forms, set to
  `http://run:<token>@<proxy host>:<CODING_TUNNEL_PORT>`. The token is derived
  from the run's capability and works only on the tunnel port. It is not the
  capability, and it cannot reach the model or registry routes. Setting only
  `HTTPS_PROXY` would leave plain `http://` requests to go direct, or to fail at
  the network, instead of getting a clear refusal.
- `NO_PROXY` and `no_proxy`, listing `localhost`, `127.0.0.1`, `::1` and the
  proxy's own address. Registry and model requests go to the proxy's main port
  directly, and would otherwise be sent into the tunnel and refused.
- When `CODING_TUNNEL_TRUST_CA_CERT` or `CODING_TUNNEL_TRUST_CA_CERT_FILE` is set on the control plane, the
  interception CA: a public certificate at `.cache/tunnel/ca.crt` in the run's
  workspace, with `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` and `PIP_CERT` pointing at it
  (see [Setting it up](#setting-it-up)). The Claude Code tool runner and the Codex
  worker are configured the same way.

On Kubernetes the run's NetworkPolicy also admits the tunnel port on the proxy
pods, in the same single rule that admits the proxy port. Nothing else is added.
On Docker the run network is internal and already reaches the proxy container on
every port it listens on.

The Substrate launcher does not use the tunnel yet: a run there is not given
these variables, and `CODING_TUNNEL_*` settings on its control plane are
ignored.

Things to know when you set a run up yourself or debug one:

- The proxy variables are reserved names, so an agent's service settings cannot
  override them.
- The token appears in the variable's value, so a command that prints its
  environment prints the token. Run steps and debug traces redact it, as they
  do the registry token, but it is still a credential for the tunnel: it lets
  the run reach the allowlisted hosts and nothing else.
- A `docker` service's daemon gets the same proxy settings, and the
  interception CA, from the run's Secret (see
  [Pulling and pushing images](coding-services.md#pulling-and-pushing-images)).
  `docker build` passes them to `RUN` steps only with `--build-arg`.
- The network must stop a run reaching the internet except through the proxy.
  The tunnel only controls traffic that is sent to it. Both launchers already
  enforce this for the run network.
- A run's job records the tunnel port it started with. Change the setting between
  runs, not during one.

## From a coding service

A [coding service](coding-services.md) (a database, or a headless Chromium the
agent drives) shares the run's network but not its environment: it is not given
`HTTPS_PROXY` or the tunnel token. A service that needs the internet gets them
from the agent, at the moment it is used.

For example, an agent that drives a headless Chromium service over the Chrome
DevTools Protocol with Playwright passes the run's tunnel to each browser
context:

```js
import { chromium } from "playwright-core";

// The run's own tunnel URL: http://run:<token>@<proxy host>:<port>. Never print it.
const tunnel = new URL(process.env.HTTPS_PROXY);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = await browser.newContext({
  proxy: {
    server: `${tunnel.protocol}//${tunnel.host}`,
    username: decodeURIComponent(tunnel.username),
    password: decodeURIComponent(tunnel.password),
  },
});
const page = await context.newPage();
await page.goto("https://app.example.com/");
```

The browser then sends `CONNECT` for every HTTPS host a page loads, and each is
allowed or refused like any other tunnel: an agent that browses a web app usually
needs `*.example.com` (app, sign-in, API and asset hosts) in its
[tunnel hosts](#per-agent-tunnel-hosts). A page's plain `http://` requests are
refused (`tunnel_connect_only`). Loopback addresses, where the run's services
listen, are not sent to the proxy. The token is a credential for the tunnel:
pass it only to the process that needs it, and keep it out of logs and
screenshots of settings pages.

## Limits, audit and metrics

- The connection and byte limits are per run and are counted by each proxy
  process separately, so with several proxy replicas a run can use up to the
  limit on each.
- Every tunnel that reaches an authenticated run writes one audit record to the
  proxy log (`audit.tunnel`): run id, host, `matchedBy`, bytes in and out, start,
  duration and outcome, where the outcome is how it ended or the code it was
  refused with. `matchedBy` is `server` for a host on the server list, or the
  run's entry that allowed it (`api.example.com`, `*.example.com`, `*`).
  A tunnel the proxy decrypted also records `intercepted.requests`, the number of
  requests it relayed; never a path, header, credential or body.
- The host is recorded only when you or the agent's owner wrote it out in full:
  a server-list host, or an exact entry. A host allowed by `*.domain` or `*`, and a
  refused host, are left out of the record (only `matchedBy` is kept), because the
  run chose that text and could put anything it holds in it. No token, header
  value or payload is ever written to a log, a record or a metric.
- Metrics count each answer under `protocol="tunnel"` in
  `wardby_proxy_http_requests_total` and the matching duration histogram.
  Tunnels are counted when they end, with the time they were open.

## Helm

Under `codingProxy.tunnel` in the chart: `enabled`, `port`, `allowedHosts`,
`agentHosts` (`off`, `exact`, `pattern` or `any`; default `off`), and optionally
`maxConnections`, `maxBytes`, `idleMs` and `maxDurationMs`. Enabling it adds the
port to the Service and the container, and to the NetworkPolicy rule that admits
coding-run pods, and gives the control plane the port, hosts and `agentHosts` so it
can point runs at the tunnel and check agents' entries. Rendering fails when it is
enabled with no hosts while `agentHosts` is `off`, or with an unknown `agentHosts`.
Public egress from the proxy stays on port 443.

For interception, `codingProxy.tunnel.intercept.rules` takes the rule objects above
and the chart sets `CODING_TUNNEL_INTERCEPT_RULES` on the proxy. For a CA that
rotates, set `codingProxy.tunnel.intercept.caSecret` to a `kubernetes.io/tls` Secret,
such as a cert-manager `Certificate`'s. The chart mounts `tls.crt` and `tls.key` on the
proxy and `tls.crt` alone on the control plane, and sets the `_FILE` variables. Otherwise
give the proxy `CODING_TUNNEL_INTERCEPT_CA_CERT` and
`CODING_TUNNEL_INTERCEPT_CA_KEY` as `secretKeyRef` entries in `codingProxy.extraEnv`,
and give the control plane the certificate alone as `CODING_TUNNEL_TRUST_CA_CERT` in
`controlPlane.extraEnv`, never the key. The chart cannot see inside a Secret, so it does
not check for them: the proxy refuses to start when rules are set without a CA. Supply
each rule's credential variable through
`codingProxy.envFromSecret` or `codingProxy.extraEnv`.

To have the chart issue the CA, set `codingProxy.tunnel.intercept.certManager.enabled`
instead of `caSecret` (cert-manager must be installed). The chart renders a self-signed
`Issuer` and a `Certificate` named `wardby-coding-proxy-intercept-ca`, with a critical
name constraint that permits exactly the rule hosts, and mounts its Secret (of the same
name) as it would `caSecret`. cert-manager reissues a Certificate when its common name
changes, but not when only its name constraint does, so the chart ends the common name
in a hash of the rest of the spec. Adding or removing a rule host therefore changes the
common name, and cert-manager reissues the CA into the same Secret, replacing the old
key. The proxy rolls because its rules changed. Its new pod may start before the
reissued CA reaches its mount (cert-manager takes seconds, the kubelet's Secret sync up
to a minute or two). Until then the pod fails the CA check and restarts, while the old
pod keeps serving. The old pod and the control
plane follow the new CA without a restart. A run already going trusts only the old CA
and loses its intercepted connections.

## Upgrading

The release that adds the tunnel adds one nullable column, `tunnelTokenHash`, to
the coding proxy's session table, applied by the normal migration step. The
database stores only a hash of each run's tunnel token, never the token. Runs
whose session was created before the upgrade have no tunnel token, so they get
`407` from the tunnel for the rest of their life. New runs are unaffected.

Runs that started before the tunnel was enabled were launched without the proxy
variables, and do not use it.

TLS interception adds no migration and is off unless its settings are set.

Per-agent tunnel hosts add three columns to the coding agent profile
(`tunnelHosts`, empty by default, and the approval of `*`) and one to the proxy's
session table (`tunnelHosts`, the entries pinned on a run). All are additive and
applied by the normal migration step. Nothing changes until you set
`CODING_TUNNEL_AGENT_HOSTS`; with it `off`, only the server list applies, as
before. Runs dispatched before the upgrade have no pinned entries.
