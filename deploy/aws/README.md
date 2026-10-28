# Wardby on AWS (EKS) — Terraform module

This module creates the AWS infrastructure for a Wardby deployment on Amazon EKS:
a network, an EKS cluster with a system node group and a gVisor sandbox node
group, a private PostgreSQL database with password-less IAM login, container
registries, Secrets Manager secrets with the access the External Secrets
Operator needs, and the certificate, web application firewall and IAM role for
the public load balancer. It creates no Kubernetes objects and no load balancer
or DNS record for the hostname: those belong to the deployment manifests, which
read the values this module outputs.

Nothing about your account is hardcoded. Every identity (region, hostname,
account) is a variable or comes from the credentials Terraform runs with.

## What this creates

| File                                        | Creates                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main.tf`                                   | Looks up the account, partition and DNS suffix from your credentials so no ARN is hardcoded.                                                                                                                                                                                                                                                                                                                 |
| `vpc.tf`                                    | A VPC with public, private and database subnets across up to three zones, NAT gateway(s), and a database tier with no route out of the VPC. Skipped entirely with `existing_vpc_id`.                                                                                                                                                                                                                         |
| `cluster.tf`                                | The EKS cluster (standard mode, access entries only, no self-managed add-ons) and its control-plane log group, cluster-admin access entries, the Pod Identity agent, the VPC CNI with NetworkPolicy enforcement, kube-proxy, and the trust policy every workload role shares (Pod Identity, this cluster, this account). Every managed add-on runs the default version for the cluster's Kubernetes version. |
| `nodegroups.tf`, `gvisor-install.sh`        | Two managed node groups on the EKS-optimized AL2023 AMI, with IMDSv2 required and a hop limit of 1. The sandbox group is tainted `sandbox=gvisor:NoSchedule` and labelled `wardby.dev/sandbox=gvisor`, and installs gVisor at boot. The coredns add-on is here too, created once the system nodes exist. System nodes carry the only security group the database admits.                                     |
| `rds.tf`                                    | A private, encrypted RDS for PostgreSQL instance in the database subnets. TLS is forced, IAM database authentication is on, the master password is generated and kept by RDS in Secrets Manager, and only system nodes can reach port 5432.                                                                                                                                                                  |
| `database-iam.tf`                           | One IAM role per database workload (app, migrator, proxy, gateway), each bound to its Kubernetes service account through Pod Identity and allowed to log in as exactly one Postgres user.                                                                                                                                                                                                                    |
| `ecr.tf`                                    | One ECR repository per Wardby image, with scan on push.                                                                                                                                                                                                                                                                                                                                                      |
| `secrets.tf`                                | The Secrets Manager secrets the deployment needs, named `<name_prefix>/<id>`. Terraform never writes a value, so no secret passes through Terraform or its state.                                                                                                                                                                                                                                            |
| `eso.tf`                                    | The IAM role of the External Secrets Operator controller: read access to this module's secrets and nothing else.                                                                                                                                                                                                                                                                                             |
| `edge.tf`                                   | An ACM certificate for `hostname` (with Route 53 validation records when `route53_zone_id` is set) and a WAF web ACL for the load balancer: a per-IP rate limit, the AWS IP reputation list, and the AWS common and known-bad-inputs rule groups.                                                                                                                                                            |
| `lbc.tf`                                    | The IAM role and policy of the AWS Load Balancer Controller, bound to its service account through Pod Identity.                                                                                                                                                                                                                                                                                              |
| `variables.tf`, `outputs.tf`, `versions.tf` | Inputs, outputs and provider requirements. No backend is configured.                                                                                                                                                                                                                                                                                                                                         |

## Prerequisites

- Terraform 1.10 or newer.
- AWS credentials that can create VPC, EKS, EC2, IAM, RDS, ECR, Secrets
  Manager, ACM and WAF resources (and Route 53 records if you set
  `route53_zone_id`). Only the identity that creates the cluster (the first
  `terraform apply`) is made cluster admin. Anyone else who will run Terraform
  or kubectl against it later must be listed in
  `additional_admin_principal_arns`; do not list the creator itself, whose
  access entry EKS already made (the duplicate fails the apply).
- A `name_prefix` unused in the account. IAM role names are account-wide, so two
  deployments in different regions of one account still need different
  prefixes.
- A hostname you control for the control plane.
- Network access from where Terraform runs to `raw.githubusercontent.com`.
  Terraform downloads the load balancer controller's IAM policy and checks its
  checksum on every plan, refresh and destroy, so it must be reachable each
  time, not only at the first apply.
- Outbound HTTPS from the private subnets for the sandbox nodes at boot: the
  AL2023 package repositories (the install script runs `dnf install bzip2` if
  the tool is missing) and the gVisor download, from `storage.googleapis.com`
  or your `gvisor_download_base_url` mirror.

## Quick start

```bash
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`: set at least `region`, `hostname` and
`public_access_cidrs` (your own address as a /32; `0.0.0.0/0` is refused).

```bash
terraform init
```

```bash
terraform apply
```

State is local by default. For shared use, configure a remote backend (for
example S3) in a git-ignored `backend.tf` or with `-backend-config`; the module
itself configures none.

Create the kubectl context from the `kubeconfig_command` output.

### The certificate and DNS

With `route53_zone_id` set, the module creates the certificate's validation
records and waits for issuance. Without it, the certificate stays pending: create
the DNS records listed in the `certificate_validation_records` output in your own
DNS. The certificate issues once they resolve, and the load balancer listener
cannot use it until then.

Changing `hostname` replaces the certificate. The old certificate stays attached
to the load balancer until the Gateway is moved to the new `certificate_arn`, so
deleting it fails until you have done that and applied again.

The DNS record for `hostname` itself points at the load balancer, which does not
exist until the Gateway is created, so the module does not manage it.

## Bring your own VPC

Set `existing_vpc_id` together with all three subnet lists, or none of them:

- `existing_public_subnet_ids`, `existing_private_subnet_ids` and
  `existing_database_subnet_ids`, at least two subnets each, in different
  availability zones.
- The private subnets need outbound internet (a NAT gateway) or VPC endpoints for
  the following, plus a path to the gVisor download host (or your mirror) and the
  AL2023 package repositories (the bzip2 fallback): an S3 gateway endpoint (ECR
  image layers and the AL2023 repositories), `ecr.api` and `ecr.dkr`, EC2 (the
  VPC CNI), EKS, `eks-auth` (the Pod Identity agent, which every workload role
  depends on), STS, Secrets Manager and Elastic Load Balancing (the load balancer
  controller).
- The VPC must have DNS support and DNS hostnames enabled: the EKS private API
  endpoint does not resolve inside the VPC without them.
- The database subnets must be reachable from the private subnets on port 5432.
  They may be the private subnets; isolated subnets are better.
- The module creates no network resources and tags none of your subnets. The
  load balancer is given `public_subnet_ids` explicitly, so subnet role tags
  are not required.

## gVisor on the sandbox nodes

Coding-run and native-worker pods run under gVisor on the sandbox node group.
The sandbox nodes' user data has two parts. The first is a nodeadm `NodeConfig`
that registers the runtime with containerd under the handler name `runsc`; the
`gvisor` RuntimeClass in the manifests must use handler `runsc`. The second runs
`gvisor-install.sh`, which downloads the release named by `gvisor_version` from
`gvisor_download_base_url`, verifies it against `gvisor_sha512`, and installs
`runsc`, the containerd shim and the runsc configuration.

Every sandbox node downloads the release (about 166 MB) at boot, through the NAT
gateway unless you mirror it. Each download attempt is bounded (15 seconds to
connect, 15 minutes in all), failed attempts are retried, and a node that cannot
finish the download never joins. A mirror in the same region (see below) makes
boots faster and cuts NAT data charges.

The install fails closed. Before anything that can fail, the script writes a
kubelet drop-in (`/etc/systemd/system/kubelet.service.d/00-wardby-gvisor.conf`)
requiring the file `/etc/wardby/gvisor-installed`, and it creates that file only
as the last step of a fully successful install. Until it exists, systemd does not
start kubelet, so the node never joins the cluster. This holds after a failed
download, a checksum mismatch, a killed or hung script, and across reboots. A
sandbox node that cannot install gVisor therefore shows up as a node-group
health issue (nodes failing to join) rather than as a node that could run
sandboxed pods without a sandbox.

To move to a new gVisor release:

1. Take the checksum from `<base>/<version>/x86_64/gvisor.tar.bz2.sha512` for the
   new release.
2. Set `gvisor_version` and `gvisor_sha512` together.
3. Apply. The new values change the sandbox launch template, and the node group
   follows its latest version, so the apply itself rolls the sandbox nodes onto
   the new release. If the checksum is wrong or the download fails, the new
   nodes never join, so the node group update fails and with it the apply; the
   old nodes keep running until you fix the values and apply again.

To avoid a boot-time dependency on the public bucket, copy the release files to
an HTTPS location you control (for example behind an S3 bucket) with the same
`<version>/x86_64/gvisor.tar.bz2` layout and set `gvisor_download_base_url`.
The checksum still applies.

Set `node_ami_release_version` to pin the AL2023 AMI release for both node groups
when a gVisor or containerd change needs a known-good pairing. Left unset
(`null`), a node group gets the latest release for `kubernetes_version` when it is
created, and its nodes move to a newer AMI only when the launch template or the
Kubernetes version changes, or when you pin a newer release.

## Upgrading Kubernetes

Upgrade one minor version at a time (for example 1.36 to 1.37): EKS refuses to
skip versions.

1. Set `kubernetes_version` to the next minor version. If you pin
   `node_ami_release_version`, change it to a release for the new version in the
   same apply.
2. Apply. The control plane upgrades first. Then the managed add-ons move to the
   new version's default add-on versions, and both node groups roll onto nodes
   of the new version. New sandbox nodes run the gVisor install again as they
   boot.

With `upgrade_support_type = "STANDARD"`, EKS upgrades the control plane itself
when standard support for the version ends. The add-ons and node groups do not
follow on their own: set `kubernetes_version` to the version the control plane
now runs and apply, so they catch up.

## Security notes

- **Instance metadata.** IMDSv2 is required with a hop limit of 1, so pods cannot
  reach instance metadata. Add-ons that need the VPC id or region (such as the
  load balancer controller) must be given them explicitly.
- **Workload credentials** come only from EKS Pod Identity. Every role's trust is
  limited to this cluster and this account. Each database role may call
  `rds-db:connect` for exactly one Postgres user.
- **Database.** Not publicly accessible; encrypted at rest; `rds.force_ssl` forces
  TLS; the security group admits only system nodes, so run pods on sandbox nodes
  have no network path to Postgres. Terraform creates no Postgres users: the
  grants bootstrap creates them (see the `database_users` output) using the
  master password from `database_master_user_secret_arn`.
- **External Secrets.** With Pod Identity the operator reads secrets as its own
  controller identity, and a SecretStore cannot name another service account. Its
  role may read only this module's secrets, but every SecretStore in the cluster
  reads with it, so restrict who may create SecretStores with Kubernetes RBAC.
- **Web application firewall.** A per-IP rate limit (`waf_rate_limit` per
  `waf_rate_limit_window_seconds`, answered with 429) and the AWS IP reputation
  list block. The AWS common and known-bad-inputs rule groups follow
  `waf_managed_rules_action`, which starts at `count`: their body rules can match
  code in MCP tool arguments and large webhook payloads. Check the rule groups'
  CloudWatch metrics and sampled requests (or configure WAF logging yourself; the
  module creates no logging configuration) for false positives before switching
  to `block`.
- **Load balancer controller policy.** The controller's IAM policy is downloaded at
  the pinned `lbc_version` and refused unless its SHA-256 equals
  `lbc_iam_policy_sha256`. Change `lbc_version`, the checksum and the controller's
  Helm chart together. The policy URL is the commercial-partition one.
- **Database engine upgrades.** `allow_major_version_upgrade` is on, so changing
  `database_engine_version` performs a major upgrade. Take a snapshot and read
  RDS's major-version upgrade guidance first, then set
  `database_apply_immediately = true` for the upgrade apply (expect downtime
  during the upgrade). If you leave it `false`, RDS defers the change to the
  maintenance window and the apply reports a failure deleting the old parameter
  group, which the instance still uses; apply again once the window has passed.

## Run dependency cache

Off by default. The coding-run dependency cache (see
[Dependency cache](../../docs/coding-packages.md#dependency-cache)) keeps npm
`node_modules` snapshots in a private S3 bucket. Set
`dependency_cache_enabled = true` and a globally unique
`dependency_cache_bucket_name`. The module then creates the bucket (public
access blocked, AES256 encryption, TLS-only policy, no versioning) and lets
the coding proxy's Pod Identity role, and nothing else, read, write and delete
its objects. The control plane, gateway and worker pods get no access.

A lifecycle rule deletes objects older than `dependency_cache_max_age_days + 7`
days (and incomplete multipart uploads after a day) as a backstop for objects
the proxy never recorded. Keep `dependency_cache_max_age_days` equal to the
proxy's `WARDBY_DEPENDENCY_CACHE_MAX_AGE_DAYS` (default 14).

Terraform does not configure the proxy itself. Give the coding proxy container
these environment variables:

| Variable                  | Value                                |
| ------------------------- | ------------------------------------ |
| `BLOB_STORE`              | `s3`                                 |
| `BLOB_STORE_S3_BUCKET`    | the `dependency_cache_bucket` output |
| `BLOB_STORE_S3_REGION`    | the `region` output                  |
| `WARDBY_DEPENDENCY_CACHE` | `true`                               |

The base proxy network policy already allows HTTPS to the public internet, so
S3's public endpoint is reachable. If you add a VPC gateway endpoint for S3
(private addresses), add a matching egress rule for the proxy. The tuning variables are
in [Dependency cache limits](../../docs/coding-packages.md#dependency-cache-limits).

## Session transcripts

Off by default. Claude Code agents with `sessionResume` on keep each run's
redacted session transcript (see
[Resume a run locally](../../docs/coding-agent-setup.md#resume-a-run-locally)).
The control plane stores them in a private S3 bucket of their own. A transcript
holds the run's whole conversation, including file contents and command output,
so it never shares the dependency cache bucket. Set
`session_transcripts_enabled = true` and a globally unique
`session_transcripts_bucket_name` (different from
`dependency_cache_bucket_name`). The module then creates the bucket (public
access blocked, AES256 encryption, TLS-only policy, no versioning) and lets the
control plane's Pod Identity role, and nothing else, read, write and delete its
objects. The coding proxy, gateway and worker pods get no access.

A lifecycle rule deletes objects under `run-transcripts/` older than
`session_transcripts_retention_days` (a whole number from 1 to 3650, default
30), and incomplete multipart uploads after a day, so transcripts are removed
on schedule even when no new run is stored.

Terraform does not configure the control plane itself. Give the control plane
container these environment variables:

| Variable                        | Value                                           |
| ------------------------------- | ----------------------------------------------- |
| `BLOB_STORE`                    | `s3`                                            |
| `BLOB_STORE_S3_BUCKET`          | the `session_transcripts_bucket` output         |
| `BLOB_STORE_S3_REGION`          | the `region` output                             |
| `RUN_TRANSCRIPT_RETENTION_DAYS` | the `session_transcripts_retention_days` output |

Take `RUN_TRANSCRIPT_RETENTION_DAYS` from the output rather than typing it, so
the server's retention and the bucket's lifecycle rule agree. Optionally set
`RUN_TRANSCRIPT_MAX_BYTES` (1048576 to 67108864, default 10 MiB). Do not give
these values to the coding proxy: its blob store, if any, is the dependency
cache's. The control plane needs HTTPS egress to S3's endpoint; if you add a VPC
gateway endpoint for S3 (private addresses), add a matching egress rule for the
control plane.

## Inputs

Only `region` and `hostname` have no default, and `public_access_cidrs` is
required while `endpoint_public_access` is true.

| Variable                             | Default                                                  | Meaning                                                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `region`                             | required                                                 | AWS region for every resource.                                                                                                                                                        |
| `name_prefix`                        | `wardby`                                                 | Prefix for every resource name and the cluster's name (3-20 characters, no `--`). Must be unique in the account (IAM role names are account-wide).                                    |
| `namespace`                          | `wardby-coding`                                          | Kubernetes namespace of the Wardby workloads; must match the manifests.                                                                                                               |
| `tags`                               | `{}`                                                     | Extra tags added to every resource.                                                                                                                                                   |
| `vpc_cidr`                           | `10.40.0.0/16`                                           | CIDR of the VPC the module creates (/16 to /20). Ignored with `existing_vpc_id`.                                                                                                      |
| `single_nat_gateway`                 | `true`                                                   | One NAT gateway for the VPC (cheaper) instead of one per zone. Ignored with `existing_vpc_id`.                                                                                        |
| `existing_vpc_id`                    | `null`                                                   | Deploy into an existing VPC; set with all three subnet lists.                                                                                                                         |
| `existing_public_subnet_ids`         | `[]`                                                     | With `existing_vpc_id`: subnets for the internet-facing load balancer.                                                                                                                |
| `existing_private_subnet_ids`        | `[]`                                                     | With `existing_vpc_id`: subnets for nodes and pods.                                                                                                                                   |
| `existing_database_subnet_ids`       | `[]`                                                     | With `existing_vpc_id`: subnets for the RDS instance.                                                                                                                                 |
| `kubernetes_version`                 | `1.36`                                                   | EKS Kubernetes minor version.                                                                                                                                                         |
| `endpoint_public_access`             | `true`                                                   | Expose the Kubernetes API publicly, restricted to `public_access_cidrs`. With `false` it is reachable only from inside the VPC.                                                       |
| `public_access_cidrs`                | `[]`                                                     | CIDRs allowed to reach the public API endpoint; required while `endpoint_public_access` is true; `0.0.0.0/0` is refused.                                                              |
| `additional_admin_principal_arns`    | `[]`                                                     | IAM principals given cluster-admin besides the cluster's creator; list every later operator, but not the creator.                                                                     |
| `cluster_log_types`                  | `["api", "audit", "authenticator"]`                      | Control-plane log types sent to CloudWatch Logs.                                                                                                                                      |
| `cluster_log_retention_days`         | `90`                                                     | Days CloudWatch Logs keeps the control-plane logs; one of CloudWatch's allowed retention values.                                                                                      |
| `upgrade_support_type`               | `STANDARD`                                               | `STANDARD`: EKS upgrades the control plane itself when standard support ends (apply again so add-ons and nodes follow); `EXTENDED` stays on the version at the extended-support rate. |
| `cluster_deletion_protection`        | `true`                                                   | Guard against deleting the cluster. Apply `false` first, then destroy.                                                                                                                |
| `node_ami_release_version`           | `null`                                                   | Pin the AL2023 AMI release for both node groups; `null` takes the latest when a group is created.                                                                                     |
| `system_instance_types`              | `["m6i.large"]`                                          | Instance types of the system node group.                                                                                                                                              |
| `system_min_size`                    | `2`                                                      | System node group minimum size.                                                                                                                                                       |
| `system_desired_size`                | `2`                                                      | System node group initial size; later changes are ignored so manual scaling sticks.                                                                                                   |
| `system_max_size`                    | `4`                                                      | System node group maximum size.                                                                                                                                                       |
| `system_disk_size_gb`                | `50`                                                     | Root volume of system nodes, GiB.                                                                                                                                                     |
| `sandbox_instance_types`             | `["m6i.xlarge"]`                                         | Instance types of the gVisor sandbox node group (x86_64 only).                                                                                                                        |
| `sandbox_min_size`                   | `0`                                                      | Sandbox node group minimum size; 0 lets you scale it to nothing when idle.                                                                                                            |
| `sandbox_desired_size`               | `1`                                                      | Sandbox node group initial size; later changes are ignored.                                                                                                                           |
| `sandbox_max_size`                   | `3`                                                      | Sandbox node group maximum size.                                                                                                                                                      |
| `sandbox_disk_size_gb`               | `100`                                                    | Root volume of sandbox nodes, GiB.                                                                                                                                                    |
| `gvisor_version`                     | `20260921.0`                                             | gVisor release installed on sandbox nodes at boot.                                                                                                                                    |
| `gvisor_sha512`                      | the release's checksum                                   | SHA-512 of `gvisor.tar.bz2` for `gvisor_version` on x86_64. A node whose download does not match never joins.                                                                         |
| `gvisor_download_base_url`           | `https://storage.googleapis.com/gvisor/releases/release` | Base URL of gVisor releases; point at your own HTTPS mirror to drop the dependency on Google's bucket.                                                                                |
| `database_engine_version`            | `17`                                                     | RDS Postgres major version. Changing it performs a major upgrade.                                                                                                                     |
| `database_instance_class`            | `db.t4g.small`                                           | RDS instance class.                                                                                                                                                                   |
| `database_allocated_storage_gb`      | `20`                                                     | Initial storage, GiB.                                                                                                                                                                 |
| `database_max_allocated_storage_gb`  | `100`                                                    | Storage autoscaling ceiling, GiB.                                                                                                                                                     |
| `database_multi_az`                  | `false`                                                  | Multi-AZ standby (roughly doubles the instance cost).                                                                                                                                 |
| `database_backup_retention_days`     | `7`                                                      | Automated backup retention, 1-35 days.                                                                                                                                                |
| `database_name`                      | `wardby`                                                 | Database created inside the instance.                                                                                                                                                 |
| `database_master_username`           | `wardby`                                                 | RDS master user; used only to bootstrap the IAM database users and grants.                                                                                                            |
| `database_apply_immediately`         | `false`                                                  | Apply database changes now instead of in the maintenance window; set `true` for a major engine upgrade (causes downtime).                                                             |
| `database_deletion_protection`       | `true`                                                   | Guard against deleting the database. Apply `false` first, then destroy.                                                                                                               |
| `ecr_force_delete`                   | `false`                                                  | Let destroy delete ECR repositories that still hold images.                                                                                                                           |
| `secrets_recovery_window_days`       | `30`                                                     | Days a deleted secret can be restored (0 deletes at once, else 7-30).                                                                                                                 |
| `eso_namespace`                      | `external-secrets`                                       | Namespace of the External Secrets Operator controller.                                                                                                                                |
| `eso_service_account`                | `external-secrets`                                       | Service account of the External Secrets Operator controller.                                                                                                                          |
| `hostname`                           | required                                                 | Public hostname of the control plane; the certificate is issued for it.                                                                                                               |
| `route53_zone_id`                    | `null`                                                   | Route 53 zone for `hostname`; when set, the module creates validation records and waits for issuance.                                                                                 |
| `waf_rate_limit`                     | `300`                                                    | Requests per client IP per window before the WAF answers 429 (minimum 10).                                                                                                            |
| `waf_rate_limit_window_seconds`      | `60`                                                     | Rate-limit window: 60, 120, 300 or 600 seconds.                                                                                                                                       |
| `waf_managed_rules_action`           | `count`                                                  | `count` logs matches of the AWS common and known-bad-inputs rule groups; `block` blocks them.                                                                                         |
| `lbc_version`                        | `v3.5.0`                                                 | AWS Load Balancer Controller release whose IAM policy the role gets.                                                                                                                  |
| `lbc_iam_policy_sha256`              | the policy's checksum                                    | SHA-256 of that release's `iam_policy.json`; a mismatching download is refused.                                                                                                       |
| `lbc_namespace`                      | `kube-system`                                            | Namespace of the load balancer controller.                                                                                                                                            |
| `lbc_service_account`                | `aws-load-balancer-controller`                           | Service account of the load balancer controller.                                                                                                                                      |
| `dependency_cache_enabled`           | `false`                                                  | Create the run dependency cache bucket, readable and writable by the coding proxy's role only.                                                                                        |
| `dependency_cache_bucket_name`       | `""`                                                     | Name of that bucket (global across S3). Required when the cache is enabled.                                                                                                           |
| `dependency_cache_max_age_days`      | `14`                                                     | Match `WARDBY_DEPENDENCY_CACHE_MAX_AGE_DAYS`; the bucket deletes objects older than this plus 7 days as a backstop.                                                                   |
| `session_transcripts_enabled`        | `false`                                                  | Create the session transcripts bucket, readable and writable by the control plane's role only.                                                                                        |
| `session_transcripts_bucket_name`    | `""`                                                     | Name of that bucket (global across S3, not the dependency cache bucket). Required when transcripts are enabled.                                                                       |
| `session_transcripts_retention_days` | `30`                                                     | Days before the bucket deletes a transcript; give the control plane the same `RUN_TRANSCRIPT_RETENTION_DAYS`.                                                                         |

## Outputs

| Output                               | Meaning                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `region`                             | The region.                                                                                       |
| `account_id`                         | The account the module was applied in.                                                            |
| `vpc_id`                             | The VPC (created, or `existing_vpc_id`); pass it to the load balancer controller explicitly.      |
| `public_subnet_ids`                  | Subnets for the internet-facing load balancer.                                                    |
| `private_subnet_ids`                 | Subnets of the nodes and pods.                                                                    |
| `database_subnet_cidrs`              | CIDRs of the database subnets, for the workloads' database egress NetworkPolicies.                |
| `cluster_name`                       | The EKS cluster name.                                                                             |
| `cluster_arn`                        | The EKS cluster ARN.                                                                              |
| `cluster_endpoint`                   | The Kubernetes API endpoint.                                                                      |
| `cluster_security_group_id`          | The EKS-managed cluster security group, on every node.                                            |
| `kubeconfig_command`                 | Command that creates the kubectl context for this cluster.                                        |
| `sandbox_node_selector`              | The `nodeSelector` the `gvisor` RuntimeClass's scheduling block must add.                         |
| `sandbox_toleration`                 | The sandbox node taint (`key=value:effect`) the `gvisor` RuntimeClass must tolerate.              |
| `database_endpoint`                  | RDS host name (the TLS server name for `sslmode=verify-full`).                                    |
| `database_port`                      | RDS port.                                                                                         |
| `database_name`                      | The database inside the instance.                                                                 |
| `database_resource_id`               | The instance's resource id (the instance part of `rds-db:connect` ARNs).                          |
| `database_master_username`           | The RDS master user.                                                                              |
| `database_master_user_secret_arn`    | Secrets Manager secret holding the RDS-managed master password, for the one-off grants bootstrap. |
| `database_users`                     | The Postgres user per workload; the grants bootstrap creates them with `GRANT rds_iam`.           |
| `database_role_arns`                 | The IAM role per database workload.                                                               |
| `ecr_registry`                       | Registry prefix for building images: images are `<ecr_registry>/<target>`.                        |
| `ecr_repository_urls`                | Repository URL per image.                                                                         |
| `secret_name_prefix`                 | Secrets are named `<secret_name_prefix><id>`.                                                     |
| `secret_arns`                        | ARN per secret.                                                                                   |
| `external_secrets_role_arn`          | IAM role of the External Secrets Operator controller.                                             |
| `certificate_arn`                    | ACM certificate for `hostname`, for the load balancer's HTTPS listener.                           |
| `certificate_validation_records`     | DNS records that validate the certificate; create them yourself when `route53_zone_id` is unset.  |
| `waf_web_acl_arn`                    | WAF web ACL for the load balancer.                                                                |
| `lbc_role_arn`                       | IAM role of the AWS Load Balancer Controller.                                                     |
| `dependency_cache_bucket`            | The run dependency cache bucket (`BLOB_STORE_S3_BUCKET`); empty when disabled.                    |
| `session_transcripts_bucket`         | The session transcripts bucket (the control plane's `BLOB_STORE_S3_BUCKET`); empty when disabled. |
| `session_transcripts_retention_days` | Days the bucket keeps a transcript (the control plane's `RUN_TRANSCRIPT_RETENTION_DAYS`).         |

## Cost

While it exists, this module bills for: the EKS control plane (hourly), NAT
gateway(s) (hourly plus data processed) and their public IPv4 addresses
(hourly), EC2 nodes for both groups and their EBS root volumes, the RDS
instance, its storage and backups, ECR image storage, WAF (per web ACL, rule and
request), Secrets Manager (per secret), and CloudWatch Logs ingestion and
storage for the control-plane log types (kept for `cluster_log_retention_days`).
ACM certificates are free. The load balancer created later from the Gateway bills
separately. When idle, scale the sandbox node group to 0 (`sandbox_min_size` is
0 by default); the system group and the database keep running.

## Teardown

1. Delete the Kubernetes Gateway first, and wait for the controller to remove the
   load balancer. A load balancer left behind blocks deleting the VPC.
2. Set `cluster_deletion_protection = false` and
   `database_deletion_protection = false` and apply.
3. Run `terraform destroy`. The control-plane log group, and the logs in it,
   are deleted with the module.

Things that bite on teardown and rebuild:

- If GuardDuty Runtime Monitoring is enabled in the account, GuardDuty adds its
  own VPC endpoint and security group to the VPC, and they block deleting the
  VPC. Delete them (or turn off automated agent management for the account)
  before the destroy, or delete them and run the destroy again.

- The final database snapshot is named `<name_prefix>-final`, a fixed name. It is
  kept after destroy; delete it before destroying a recreated instance, or the
  destroy fails.
- Secrets enter a recovery window of `secrets_recovery_window_days`. Applying
  again with the same `name_prefix` inside the window fails with a "scheduled for
  deletion" error: restore each of the module's secrets, then import it into state (restoring
  alone leaves it outside state, and a secret scheduled for deletion cannot be
  imported). This is deliberate: losing `secret-app-key` makes every stored
  credential unreadable.

  ```bash
  aws secretsmanager restore-secret --secret-id <name_prefix>/<id>
  ```

  ```bash
  terraform import 'aws_secretsmanager_secret.deployment["<id>"]' <name_prefix>/<id>
  ```

- ECR repositories that still hold images need `ecr_force_delete = true`
  (applied before the destroy).
- Replacing the certificate (see "The certificate and DNS") can fail to delete the
  old one while a load balancer still uses it.

## Checking changes to this module

Run the `terraform` commands from `deploy/aws` (or add `-chdir=deploy/aws`), and
the `npx vitest` command from the repository root.

```bash
terraform fmt -check -recursive
```

```bash
terraform init -backend=false
```

```bash
terraform validate
```

```bash
terraform test
```

`terraform test` uses mock providers: no AWS account or credentials are needed.

```bash
npx vitest run deploy/aws
```
