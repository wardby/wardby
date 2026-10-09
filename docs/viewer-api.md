# Admin viewer API

The viewer API is a read-only HTTP API that shows what is running in a Wardby
deployment: runs, sub-agent trees, what triggered each run, its outcomes
(pull requests, comments, checks), and coding-run services. It is built for
dashboards and desktop viewers that want a live picture of the whole
deployment.

It is **deployment-wide**. Unlike the MCP tools, which show a caller their own
and public agents, the viewer shows **every owner's** runs. For that reason it
requires the privileged `admin:view` scope, and that scope is granted only by
the `admin` role.

## Access

A caller needs an access token for the Wardby MCP resource that carries the
`admin:view` scope, and the Wardby `admin` role. Send it as
`Authorization: Bearer <token>`.

- **Self-hosted sign-in:** the `admin` role grants `admin:view`. A client
  requests the scope during sign-in like any other.
- **External identity provider (delegating mode):** define the `admin:view`
  scope in the provider and map it the same way as `agents:admin`, and map the
  provider's admin group to the Wardby `admin` role. When you upgrade an
  existing deployment, define the scope before deploying: clients that request
  every advertised scope otherwise fail with `invalid_scope`. See
  [getting-started-identity-provider.md](getting-started-identity-provider.md).

Native and desktop clients sign in with PKCE and a loopback redirect. In
self-hosted mode a client may register a loopback redirect
(`http://127.0.0.1/...`, `http://[::1]/...` or `http://localhost/...`) and then
use any port at sign-in, as RFC 8252 describes. Everything except the port
must match the registered redirect.

## Endpoints

All three endpoints accept only `GET`.

| Status | Meaning                                                           |
| ------ | ----------------------------------------------------------------- |
| `401`  | No valid access token.                                            |
| `403`  | The token lacks `admin:view`, or the caller lacks the admin role. |
| `400`  | `invalid_since` or `invalid_limit` (graph only).                  |
| `404`  | Unknown run id (run detail only).                                 |
| `405`  | A method other than `GET`.                                        |

### `GET /admin/api/graph`

A snapshot of runs and their relationships.

| Query parameter | Values                                                   | Default |
| --------------- | -------------------------------------------------------- | ------- |
| `since`         | `15m`, `1h`, `6h`, `24h`, `7d`, or an ISO-8601 timestamp | `1h`    |
| `limit`         | An integer from 1 to 2000                                | `500`   |

The snapshot includes runs that started in the window **or** are still pending
or running, plus all of their ancestors, so a sub-agent tree is never cut off
from its root. When more runs match than `limit`, the response sets
`truncated`.

Each run carries its agent, status, trigger, turn and token counts, cost and
budget, outcomes, and coding-run services. `model` is the model the run used
(a coding run's own model, otherwise the agent's). `codingProvider` names the
coding worker, such as `codex` or `claude-code`, and is `null` for runs that
aren't coding runs. `nativeExecutionMode` says where a native run executed,
`control-plane` or `sandbox` (its own isolated container or pod), recorded when
the run started; it is `null` for coding runs and for runs from before the
server recorded it. `warmWorkerName` names the warm pool worker (container or
pod) a sandbox run claimed, so a client can find that pod, which carries no
run label; it is `null` otherwise, and once the server has retired the worker.
`declaredServices` lists the services (name and version) a coding run was
started with; `services` holds their recorded readiness. A finished run can
declare a service that has no readiness record, for example a run from before
the server recorded service status.

A Jira trigger and a Jira comment outcome carry `url`: the issue's page on the
site in `WARDBY_JIRA_SITE_URL`, and for the comment the same page opened at
wardby's comment (`?focusedCommentId=`). Both are `null` when Jira isn't
configured.

Each outcome carries `at`, when it happened: when a pull request was opened,
when a comment was last updated, or when a check completed (`null` while a
check is still pending).

### `GET /admin/api/runs/<id>`

One run in full: the graph fields plus the run's final text and error. For
coding runs, services report the **names** of their environment variables
only, never values. An unknown id returns `404`.

### `GET /admin/api/infra`

How this deployment runs coding jobs, for clients that show its Kubernetes
footprint: `launcher` (`local`, `docker` or `kubernetes`) and, for the
Kubernetes launcher, the namespace, the platform (`KUBERNETES_PLATFORM`), the
runtime class (or `null`), the coding proxy's Service name, and the labels on
coding-run pods. `runLabel` holds the first `runLabelHashChars` hex characters
of the SHA-256 of the run id, so a client can match a pod to a run it already
knows. The response never includes credentials, the server's kube context, or
image references. `kubernetes` is `null` for the other launchers.

`native` describes how sandbox-mode native agents run, and is `null` when
`NATIVE_SANDBOX_LAUNCHER` is unset: `launcher` (`docker` or `kubernetes`),
`warmPoolSize` (`NATIVE_SANDBOX_WARM_POOL_SIZE`), and for Kubernetes the
namespace their pods run in, the runtime class (or `null`), and the labels on
their pods: `componentLabel` on every sandbox pod, `runLabel` (the same run-id
hash as coding runs) on a run's own pod, and `warmPoolLabel` plus the
`warmWorkerLabel` key on warm pool pods, which have no run label even after a
run claims them.

### `GET /admin/api/events`

A Server-Sent Events stream (`text/event-stream`) of live changes. Frames:

| Frame                                            | Meaning                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `retry: 3000`                                    | Suggested client reconnect delay in milliseconds.                                              |
| `event: hello`                                   | Sent first. Data is `{"connected": <bool>}`: whether the server's live-event connection is up. |
| `event: run`, `event: service`, `event: outcome` | A run, coding-run service, or outcome changed. Each carries an `id:` line.                     |
| `event: status`                                  | The server's live-event connection changed. Data is `{"connected": <bool>}`.                   |
| `event: resync`                                  | The live-event connection is up (again). Events may have been missed: refetch the graph.       |
| `: ping`                                         | Comment sent every 15 seconds to keep the connection open.                                     |

Event payloads are small and never include final text; fetch
`/admin/api/runs/<id>` for detail. A `run` event carries the run's status,
turn and token counts, cost and finish time. A `service` event carries the
service name, its state and the attempt count. An `outcome` event carries only
the run id and the outcome source (`pull_request`, `host_status`,
`issue_status` or `host_check`), so refetch the run to see what changed.

**There is no replay.** Open the event stream first, then load
`/admin/api/graph` and apply events on top of it. Refetch `/admin/api/graph` on
every `resync` and after every reconnect rather than trying to resume.

The server's live-event connection starts when the first client subscribes, so
`hello` may report `{"connected": false}`. When the connection comes up, the
stream sends `status` with `{"connected": true}` followed by `resync`; when it
drops, it sends `status` with `{"connected": false}`, and `status` plus
`resync` again once it is restored. Use `hello` and `status` to show whether
the view is live or reconnecting.

A client that stops reading has its stream closed once about 1 MiB of unsent
data is waiting; it reconnects and resyncs like any other reconnect.

Live events come from Postgres `NOTIFY`. Each server replica holds one
database connection for them, opened only while at least one client is
subscribed.

## Desktop viewer

A desktop app for macOS in the source tree, `apps/viewer`, is a ready-made
client of this API: it signs in with the same flow described under Access,
draws the graph, and updates it from the event stream. See
[`apps/viewer/README.md`](https://github.com/wardby/wardby/tree/main/apps/viewer) for prerequisites, running
it, adding a server, and what an external identity provider client needs.
Its Infrastructure tab uses `GET /admin/api/infra` to find the server's
namespace and run labels, then reads that namespace read-only with the
operator's own kubeconfig; the README lists the Kubernetes Role it needs.

## Response schemas

JSON Schemas for every response and event are in `src/viewer/schemas/` of the
source tree (`graph-snapshot.schema.json`, `infra-info.schema.json`,
`run-detail.schema.json`, `viewer-event.schema.json`). Regenerate them with `npm run build:viewer-schemas`.

## Proxies and load balancers

The event stream is a long-lived response. Any proxy or load balancer in front
of Wardby must allow responses that last as long as a client stays connected
and must not buffer `text/event-stream`. Wardby sends `Cache-Control: no-store`
and `X-Accel-Buffering: no` on the stream. The reference GKE Gateway overlay
raises the backend timeout to 3600 seconds (`GCPBackendPolicy`
`spec.default.timeoutSec`), and the reference Compose deployment's Caddyfile
allows responses of up to one hour (`timeouts` `write 1h`); clients reconnect
and resync when a stream ends.
