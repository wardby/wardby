locals {
  # AUTH_AUDIENCE must be byte-identical to MCP_CANONICAL_URI (the app
  # enforces this at startup) - one source of truth for both env vars below.
  mcp_canonical_uri = var.create_domain_mapping ? "https://${var.domain_name}" : var.mcp_canonical_uri_override
  # Self-hosted mode issues its own tokens, so it is its own issuer.
  auth_issuer = var.auth_provider == "self-hosted" ? local.mcp_canonical_uri : var.auth_issuer
}

resource "google_cloud_run_v2_service" "main" {
  name     = "${var.name_prefix}-control-plane"
  project  = var.project_id
  location = var.region

  # Unlike Cloud SQL (cloudsql_deletion_protection), a Cloud Run service is
  # stateless - recreating it loses nothing. The provider defaults this to
  # true, which blocks a replace (destroy-then-create) with no way to
  # override short of a separate apply; false matches how disposable this
  # resource actually is.
  deletion_protection = false

  template {
    service_account = google_service_account.cloud_run.email

    scaling {
      min_instance_count = var.min_instance_count
      max_instance_count = var.max_instance_count
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }

    containers {
      image = var.container_image

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "EXECUTOR"
        value = "dbos"
      }

      env {
        name = "SECRET_APP_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app_key.secret_id
            version = "latest"
          }
        }
      }

      # MCP_TRANSPORT defaults to "stdio" (src/config/providers.ts) - stdio
      # never opens a TCP port, so without this Cloud Run's health check
      # times out waiting on $PORT (hit for real testing this module,
      # 2026-09-17/18). 0.0.0.0:8080 matches Cloud Run's default container
      # port (unset here, so it stays at the platform default of 8080).
      env {
        name  = "MCP_TRANSPORT"
        value = "http"
      }

      env {
        name  = "MCP_HTTP_BIND"
        value = "0.0.0.0:8080"
      }

      # Required by the app whenever MCP_TRANSPORT=http. With a custom
      # domain this is knowable upfront (var.domain_name); without one, the
      # *.run.app URL doesn't exist until this very resource is created -
      # a genuine chicken-and-egg a single apply can't resolve. See
      # var.mcp_canonical_uri_override's description for the domainless path.
      env {
        name  = "MCP_CANONICAL_URI"
        value = local.mcp_canonical_uri
      }

      env {
        name  = "AUTH_PROVIDER"
        value = var.auth_provider
      }

      # Self-hosted mode is its own issuer, so the canonical URI serves as
      # AUTH_ISSUER; delegating mode takes the external IdP's issuer verbatim,
      # because it must match the `iss` claim byte for byte.
      env {
        name  = "AUTH_ISSUER"
        value = local.auth_issuer
      }

      # Must equal MCP_CANONICAL_URI - the app's OAuth resource-server
      # validation rejects startup otherwise. In delegating mode this is also
      # the audience your IdP has to mint into `aud`; reevo accepts either
      # spelling of an origin (with or without the trailing slash), so copying
      # the `resource` value straight out of reevo's own
      # /.well-known/oauth-protected-resource is safe.
      env {
        name  = "AUTH_AUDIENCE"
        value = local.mcp_canonical_uri
      }

      # Signature verification key source, delegating mode only.
      dynamic "env" {
        for_each = var.auth_provider == "delegating" ? [var.auth_jwks_uri] : []
        content {
          name  = "AUTH_JWKS_URI"
          value = env.value
        }
      }

      # Self-hosted mode only: these sign reevo's own OAuth tokens and hash
      # stored credentials (src/providers/auth/index.ts). Delegating mode
      # issues no tokens and stores no login keys, so they are neither
      # generated nor mounted.
      dynamic "env" {
        for_each = var.auth_provider == "self-hosted" ? [1] : []
        content {
          name = "AUTH_SIGNING_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.auth_signing_key[0].secret_id
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = var.auth_provider == "self-hosted" ? [1] : []
        content {
          name = "AUTH_CREDENTIAL_HASH_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.auth_credential_hash_key[0].secret_id
              version = "latest"
            }
          }
        }
      }

      # The app fails its own startup check without at least one LLM
      # credential (or BEDROCK_REGION, which needs no secret and isn't
      # wired here). One env block per name in local.llm_api_key_names -
      # zero, one, or both of OpenAI/Anthropic, since the app registers
      # providers additively by credential presence.
      dynamic "env" {
        for_each = local.llm_api_key_names
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.llm_api_key[env.key].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  # Cloud Run reads secrets at version = "latest" at service-create time -
  # without depending on the *_version resources directly (not just the
  # secret container or the IAM grant), Terraform's implicit graph can
  # create this service before a secret's real version has finished
  # propagating, failing with "Secret ... was not found" (hit for real
  # testing this module against onit-dashboard, 2026-09-17/18).
  depends_on = [
    google_secret_manager_secret_iam_member.db_url_access,
    google_secret_manager_secret_version.db_url,
    google_secret_manager_secret_iam_member.app_key_access,
    google_secret_manager_secret_version.app_key,
    google_secret_manager_secret_iam_member.auth_signing_key_access,
    google_secret_manager_secret_version.auth_signing_key,
    google_secret_manager_secret_iam_member.auth_credential_hash_key_access,
    google_secret_manager_secret_version.auth_credential_hash_key,
    google_secret_manager_secret_iam_member.llm_api_key_access,
    google_secret_manager_secret_version.llm_api_key,
    null_resource.run_migration,
  ]
}

# Without this the service 403s every caller, including the OAuth endpoints,
# with nothing in the response pointing at IAM as the cause - the failure
# looks like reevo rejecting the request. See var.allow_unauthenticated for
# why public invoker is the working default rather than a lax one.
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count    = var.allow_unauthenticated ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.main.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
