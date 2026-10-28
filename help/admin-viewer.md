---
id: admin-viewer
title: Watch live runs with the admin viewer API
summary: Read-only, deployment-wide live view of runs, sub-agent trees, triggers, outcomes and coding-run services for admins (admin:view).
audience: operator
tags: [viewer, admin, runs, live, desktop, infrastructure, kubernetes, download, openapi, api contract, sign-in]
appliesTo: ">=0.4.0"
---

# Watch live runs with the admin viewer API

The admin viewer API is a read-only HTTP API for dashboards and desktop
viewers. It shows every owner's runs across the deployment: sub-agent trees,
what triggered each run, its outcomes (pull requests, comments, checks), and
coding-run services, with a live event stream.

It requires the Wardby `admin` role and the `admin:view` scope, which only the
`admin` role grants. In delegating mode, define `admin:view` in your identity
provider and map it like `agents:admin`. See
[Configure identity and privileged access](identity-and-access.md).

Endpoints, all `GET`:

- `/admin/api/graph?since=1h&limit=500`: a snapshot of runs in a time window.
- `/admin/api/runs/<id>`: one run in full, including its final text and error.
- `/admin/api/infra`: how this deployment runs coding jobs (launcher, Kubernetes namespace, platform, run labels).
- `/admin/api/events`: a Server-Sent Events stream of live changes.

The stream has no replay: open the event stream first, then load the graph,
and refetch the graph on every `resync` event and after any reconnect. `hello`
and `status` events report whether live events are flowing. Proxies and load balancers in front of Wardby
must allow long-lived responses and not buffer `text/event-stream`.

A desktop viewer for macOS is included in the source tree (`apps/viewer`). Add
your server's canonical URI, sign in with an `admin` user in the browser, and it
shows the live graph. Each GitHub release has an unsigned macOS build of the viewer attached (see the README for opening it past Gatekeeper). Its README covers setup, and what an external identity
provider client needs when the server runs in delegating mode.

## Viewer sign-in with an external identity provider

In delegating mode, the viewer signs in through your identity provider's
public (native) client. That client must:

- register the exact redirect URI `http://127.0.0.1:8585/callback`. The viewer
  always listens on port 8585, and some providers (Okta, for example) match a
  loopback redirect by its exact port, so a port-less or wildcard loopback
  entry may not match;
- allow the `admin:view` scope for the Wardby resource;
- enable the refresh-token grant and allow the `offline_access` scope. The
  viewer requests it so the provider returns a refresh token, and sign-in
  fails with "server issued no refresh token" without one.

The viewer prints its callback URL to stderr at startup. If sign-in reports
that it could not open the local callback listener on `127.0.0.1:8585`,
another program is using that port: close it and sign in again. In
self-hosted mode the viewer registers itself, so there is no client to set up.

From Wardby 0.6.0, admins can also sign in to a mobile app for the same read-only live view; see the help article `mobile-app`.

The Infrastructure tab shows the Kubernetes pods where your deployment runs
coding jobs, read-only. It uses your kubeconfig (switchable per server) and
requires a minimal read-only Kubernetes role. See the Infrastructure view
section of the [viewer README](../apps/viewer/README.md#infrastructure-view) for
setup. Its Map shows the request path (entry, protection layer such as Cloud
Armor, routes), each NetworkPolicy with a plain-English summary, and on GKE a
link from each pod to the Google Cloud console. In low-power mode the sleeping
coding proxy and native gateway show as asleep (with when they last woke), and
a failed old replica next to a healthy one is greyed out rather than shown as a
failure. The run graph's zoom controls
include **Fit width**, which fills the canvas with the graph's width.

From Wardby 0.6.0 the API is also published as OpenAPI 3.1 (`docs/viewer-api.openapi.yml` in the package), an API contract you can feed to client generators such as `openapi-typescript`.

For parameters, status codes, frame formats and schemas, follow
[`docs/viewer-api.md`](../docs/viewer-api.md).
