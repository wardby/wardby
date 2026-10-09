---
id: deploy-gke
title: Deploy Wardby on GKE Autopilot
summary: Use the supported Google Cloud path for a private database, isolated coding workers, and HTTPS ingress.
audience: operator
tags: [deployment, gke, gcp, kubernetes, production, secrets, jira]
appliesTo: >=0.2.1
---

# Deploy Wardby on GKE Autopilot

The supported Google Cloud deployment creates a GKE Autopilot cluster, private
Cloud SQL for PostgreSQL, Artifact Registry, HTTPS Gateway, Google Secret
Manager synchronization, and isolated gVisor-backed coding-worker pods for
Codex and Claude Code. It also applies namespace RBAC and default-deny network
policies.

Use a dedicated billed project, a hostname you control, remote Terraform state,
and a GitHub App installed only on repositories that agents need. Review
Terraform's plan and set cloud budgets before applying it: the deployment
creates billable resources.

The deployment process is:

1. Install `gcloud`, Terraform, Docker with `linux/amd64` support, `kubectl`,
   Helm, Node.js 24, and authenticate to the target project.
2. Configure `deploy/gke/terraform.tfvars`, apply Terraform, and prepare the
   Gateway's address, certificate map, Cloud Armor policy, and DNS record.
3. Put first-time values in an untracked `.env.local`; `deploy/gke/up.sh`
   seeds Secret Manager without overwriting existing production values.
   Jira settings are optional there, all or none; see [Jira](jira.md).
4. Run `WARDBY_HOSTNAME=wardby.example.com deploy/gke/up.sh`, then verify DNS,
   certificate issuance, database IAM bootstrap, and service health.
   Use `WARDBY_HOSTNAME`, not `HOSTNAME` (shells set that to the machine name);
   the script refuses local names such as `*.lan` or `*.local`, and asks you
   to confirm (or set `WARDBY_HOSTNAME_CHANGE=<new hostname>`) before moving
   a deployment to a different hostname.

When a release changes `deploy/gke/database-grants.sql`, re-run the database
grants bootstrap **before** deploying that release, so the proxy role can
already write the tables and columns it adds (such as per-model usage for
[cost attribution](cost-attribution.md), or a run's live turn count). Until the
grants are applied, the coding proxy's writes are refused and coding runs fail.

The Kubernetes launcher runs Codex and Claude Code coding workers; a Claude
Code pod adds a tool-runner sidecar with its own image. Configure an identity
provider and GitHub App before allowing people to use the public endpoint.

## Plan it with your assistant

If you are an assistant connected to Wardby over MCP and the user asked to plan
a GKE deployment, produce a written plan; do not create cloud resources. Read
[Choose a deployment target](deployment-targets.md) first and confirm GKE is
the right target. Then ask for, one at a time, and record:

1. The Google Cloud project (dedicated, with billing) and region, and who
   holds the IAM roles to apply Terraform.
2. The public hostname and who controls its DNS.
3. The identity provider for people signing in (see
   [Configure identity and privileged access](identity-and-access.md)).
4. The GitHub App: which repositories it is installed on (see
   [Connect GitHub repositories](github.md)).
5. Which coding providers the agents use (Codex, Claude Code or both), and
   which provider keys and worker images that needs.
6. Where Terraform state lives, and the monthly cloud budget and alerts.
7. Optional: Jira.

The plan lists those answers, the ordered steps above with the values filled
in, the commands the user will run themselves, and the open questions. Point
the user to the full guide below for every step.

Follow the complete, ordered guide at
[`docs/getting-started-gke.md`](../docs/getting-started-gke.md). It includes
the precise IAM, DNS, bootstrap, upgrades, and teardown steps.
