# Production Edge and Runtime Boundary

This is the portable deployment baseline for Phase 7 Workstream 2. It places
the MCP HTTP service and scheduler behind Caddy, publishes only ports 80 and
443, and runs the application processes as the non-root runtime-image user.
It is intentionally not a complete production environment: a platform firewall,
managed database, secret manager, backup job, and coding-controller host remain
operator-owned infrastructure.

## What the stack guarantees

- Caddy terminates TLS and automatically redirects the canonical HTTP host to
  HTTPS.
- The application listens only on Docker's private `service` network. Port
  `8080` is exposed to Caddy but never published to the host.
- Caddy overwrites the upstream `Host` with `MCP_PUBLIC_HOST`; the application
  independently rejects a missing, duplicate, malformed, or noncanonical Host.
- The proxy applies header/body time limits and a 1 MiB edge body cap. The app
  retains its stricter 64 KiB OAuth-body and 1 MiB MCP/webhook limits.
- MCP and scheduler containers are read-only, non-root, capability-free, and
  use a bounded `tmpfs`. The separate migration image is a one-off Compose
  profile and is never a request-serving container.
- The default stack does not mount the Docker socket or publish a metrics port.

## What the platform must enforce

Docker Compose cannot safely express the required allowlist egress policy. At
the VPC, host firewall, or egress gateway, permit only the reviewed database,
identity provider, LLM provider, SMTP, object-storage, and explicitly allowed
tool destinations. Deny metadata, loopback, link-local, RFC1918, and all other
private destinations. Apply connection and request-rate limits at the load
balancer, WAF, or equivalent edge service.

Place the Docker host in a private network. The load balancer is the only
internet-facing component and forwards only to Caddy on ports 80/443. Do not
publish the `mcp` container port, attach the application to the Docker socket,
or use the same host for untrusted coding-worker execution. Follow
[coding-worker isolation](../../docs/coding-worker-isolation.md)
when enabling the coding executor.

## Configure and start

1. Build and scan separate runtime and migration images from
   [deploy/Dockerfile](../Dockerfile). Push each under an immutable digest.
2. Copy `production.env.example` to `.env.production`, replace all placeholders
   through the secret manager, and ensure `MCP_CANONICAL_URI` and
   `AUTH_AUDIENCE` are exactly identical normalized HTTPS URLs. For delegated
   authentication, follow [Bring your own identity provider](../../docs/getting-started-identity-provider.md).
3. Validate the rendered topology before starting it:

```sh
docker compose --env-file deploy/production/.env.production \
  -f deploy/production/compose.yml config
```

4. Start the request-serving services:

```sh
docker compose --env-file deploy/production/.env.production \
  -f deploy/production/compose.yml up -d edge mcp scheduler
```

5. Run the migration only after the Workstream 3 backup and restore rehearsal
   succeeds. Use the migration role just for this command, then remove it from
   the process environment:

```sh
docker compose --env-file deploy/production/.env.production \
  -f deploy/production/compose.yml --profile migration run --rm migrate
```

## Release checks

- Confirm `docker compose ... ps` reports only `edge`, `mcp`, and `scheduler`.
- Confirm the host has no listener for TCP `8080` and a direct application-port
  connection from outside the private network fails.
- Verify HTTPS, HTTP redirect, canonical Host rejection, origin rejection, and
  the full OAuth flow against the production-like staging hostname.
- Confirm the runtime image contains none of the Prisma CLI, `@prisma/config`,
  `deepmerge-ts`, or `mysql2`; retain the image SBOM and scan reports with the
  release.
- Record the firewall/egress policy, secret-injection mechanism, image digests,
  and owning operator in the launch evidence.
