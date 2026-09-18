resource "google_secret_manager_secret" "db_url" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-database-url"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_url" {
  secret = google_secret_manager_secret.db_url.id
  # Unix-socket form: matches how Cloud Run's built-in Cloud SQL volume
  # mount exposes the instance, at /cloudsql/<connection_name> (cloud-run.tf).
  secret_data = "postgresql://${google_sql_user.app.name}:${random_password.db_password.result}@localhost/${google_sql_database.app.name}?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
}

resource "google_secret_manager_secret_iam_member" "db_url_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.db_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run.email}"
}

# SECRET_APP_KEY (src/providers/secrets/app-key.ts): 32 bytes of hex,
# required by the app's own SecretCipher adapter to encrypt secrets at
# rest - not a deployer-supplied credential like the LLM keys, so unlike
# those there's no variable for it: Terraform generates it itself, exactly
# like random_password.db_password above.
resource "random_id" "secret_app_key" {
  byte_length = 32
}

resource "google_secret_manager_secret" "app_key" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-secret-app-key"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "app_key" {
  secret      = google_secret_manager_secret.app_key.id
  secret_data = random_id.secret_app_key.hex
}

resource "google_secret_manager_secret_iam_member" "app_key_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.app_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run.email}"
}

# AUTH_SIGNING_KEY and AUTH_CREDENTIAL_HASH_KEY (src/providers/auth/index.ts):
# required alongside AUTH_AUDIENCE whenever AUTH_PROVIDER=self-hosted, same
# 32-byte-hex shape as SECRET_APP_KEY above and generated the same way. The
# app also rejects startup if AUTH_CREDENTIAL_HASH_KEY equals SECRET_APP_KEY
# (index.ts) - two independent random_id resources make a collision
# astronomically unlikely, so no extra handling is needed here.
resource "random_id" "auth_signing_key" {
  byte_length = 32
}

resource "google_secret_manager_secret" "auth_signing_key" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-auth-signing-key"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "auth_signing_key" {
  secret      = google_secret_manager_secret.auth_signing_key.id
  secret_data = random_id.auth_signing_key.hex
}

resource "google_secret_manager_secret_iam_member" "auth_signing_key_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.auth_signing_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run.email}"
}

resource "random_id" "auth_credential_hash_key" {
  byte_length = 32
}

resource "google_secret_manager_secret" "auth_credential_hash_key" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-auth-credential-hash-key"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "auth_credential_hash_key" {
  secret      = google_secret_manager_secret.auth_credential_hash_key.id
  secret_data = random_id.auth_credential_hash_key.hex
}

resource "google_secret_manager_secret_iam_member" "auth_credential_hash_key_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.auth_credential_hash_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run.email}"
}

# Optional LLM provider credentials. The app (src/config/providers.ts)
# registers each provider additively by credential presence - OpenAI and
# Anthropic (and Bedrock, via BEDROCK_REGION, which isn't a secret and isn't
# wired here) can all be configured at once, so this is a map rather than a
# single slot: add an entry here for any other provider env var later. The
# MCP server/scheduler process fails its own startup check with none of
# these present - hit for real testing this module, 2026-09-17/18. Only
# entries with a non-null value actually create a secret.
locals {
  llm_api_key_values = {
    OPENAI_API_KEY    = var.openai_api_key_value
    ANTHROPIC_API_KEY = var.anthropic_api_key_value
  }
  # for_each can't accept a value derived from a sensitive variable (the API
  # key values above) - Terraform taints the whole filtered map as sensitive
  # and refuses it as a for_each argument, even though only the *names* are
  # actually needed to decide which resources to create. nonsensitive()
  # extracts just the null-check result (true/false, never the key itself)
  # so this set of *names* is safe to iterate on; the real value is looked
  # up separately (still sensitive, exactly where it should be) inside each
  # resource body via local.llm_api_key_values[each.key].
  llm_api_key_names = toset([
    for env_name, value in local.llm_api_key_values : env_name if nonsensitive(value != null)
  ])
}

resource "google_secret_manager_secret" "llm_api_key" {
  for_each  = local.llm_api_key_names
  project   = var.project_id
  secret_id = "${var.name_prefix}-${lower(replace(each.key, "_", "-"))}"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "llm_api_key" {
  for_each    = local.llm_api_key_names
  secret      = google_secret_manager_secret.llm_api_key[each.key].id
  secret_data = local.llm_api_key_values[each.key]
}

resource "google_secret_manager_secret_iam_member" "llm_api_key_access" {
  for_each  = local.llm_api_key_names
  project   = var.project_id
  secret_id = google_secret_manager_secret.llm_api_key[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run.email}"
}
