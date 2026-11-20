---
id: mobile-app
title: Use the wardby mobile app
summary: Let admins sign in to the wardby mobile app for a read-only live view of runs; enable it with WARDBY_MOBILE_ENABLED on self-hosted auth or register the redirect URI in your IdP.
audience: operator
tags: [mobile, ios, android, sign-in, oauth, WARDBY_MOBILE_ENABLED]
appliesTo: ">=0.6.0"
---

# Use the wardby mobile app

The mobile app is a read-only live view of runs for admins and viewers, built on the admin
viewer API (see `admin-viewer`). Sign-in needs the `admin` or `viewer` role
and the `admin:view` scope.

## Enable it with self-hosted auth

Mobile sign-in is off by default. Set `WARDBY_MOBILE_ENABLED=true` on the
control plane and restart it. The OAuth server then accepts exactly one extra
redirect URI, `com.wardby.mobile:/oauth`, by exact match only. On GKE, pass
`WARDBY_MOBILE_ENABLED=true` to `deploy/gke/up.sh` on every run; a run without it
turns mobile sign-in off.

`WARDBY_MOBILE_REDIRECT_URI` is for white-label builds only. It must be a
reverse-domain private-use URI, for example `com.example.app:/oauth`: a
lowercase scheme with at least one dot, then `:/`, then a path of letters,
digits, `/`, `_` or `-`, with no host, query or fragment. Changing it signs out
app clients registered under the old value; they must sign in again. A
malformed `WARDBY_MOBILE_ENABLED` or `WARDBY_MOBILE_REDIRECT_URI` stops startup
in every auth mode.

## Enable it with an external identity provider

Wardby needs no setting. Register `com.wardby.mobile:/oauth` (or your
white-label redirect) as an allowed redirect URI on the IdP client that
requests `admin:view`, and make sure the `admin:view` scope is defined and
mapped. See [Configure identity and privileged access](identity-and-access.md).

## Turning it off

Set `WARDBY_MOBILE_ENABLED=false` (or unset it). New sign-ins and token
refreshes are refused. Access tokens already issued keep working until they
expire, at most 10 minutes. Turning it back on lets existing sessions refresh
again; nothing is revoked.

## Troubleshooting

If the app's registration or sign-in is refused with `mobile_disabled`, see
[Mobile sign-in is not enabled](errors/mobile-disabled.md).

## See also

- [Watch live runs with the admin viewer API](admin-viewer.md)
- The viewer API reference in `docs/viewer-api.md`.
