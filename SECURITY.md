# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability-reporting form under the repository's **Security** tab and include:

- the affected version or commit;
- the boundary or component involved;
- reproduction steps or a minimal proof of concept;
- expected and observed behavior; and
- any known impact or suggested mitigation.

Avoid including real credentials, customer data, proprietary repository
contents, or destructive payloads. A maintainer will acknowledge the report,
coordinate validation and remediation privately, and publish an advisory when
appropriate.

## Supported versions

Until Wardby publishes stable releases, security fixes target the current
default branch. Self-host operators should deploy immutable, reviewed commits
and follow [release verification](docs/release-verification.md) and the
[security deployment guide](docs/security-deployment.md).
