# Secrets Manager holds every secret the deployment needs, under
# <name_prefix>/<id>. Terraform creates the secrets and never a value: the
# seeding step adds values, so no secret passes through Terraform or its state.
# The ids are the GKE deployment's (module.test.mjs checks).

locals {
  secret_ids = toset([
    "openai-api-key",
    "anthropic-api-key",
    "secret-app-key",
    "github-app-id",
    "github-app-private-key",
    "github-app-webhook-secret",
    "github-app-client-id",
    "github-app-client-secret",
    "auth-signing-key",
    "auth-credential-hash-key",
    # Optional, all or none: left empty when Jira is unused.
    "jira-site-url",
    "jira-api-base-url",
    "jira-api-token",
    "jira-api-token-expires-at",
    "jira-webhook-secret",
    # Optional: left empty when Slack notifications are unused.
    "slack-bot-token",
    # Optional: left empty without Redis for live editing (documents are pinned instead).
    "live-redis-url",
  ])
}

resource "aws_secretsmanager_secret" "deployment" {
  for_each = local.secret_ids

  name        = "${var.name_prefix}/${each.key}"
  description = "Wardby ${each.key}"

  # These outlive the cluster on purpose: a rebuild must get the same auth keys
  # and SECRET_APP_KEY back. Losing SECRET_APP_KEY makes every stored
  # credential unreadable.
  recovery_window_in_days = var.secrets_recovery_window_days
}
