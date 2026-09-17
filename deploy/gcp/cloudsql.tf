resource "random_password" "db_password" {
  length  = 32
  special = false # avoid characters that need extra escaping in a connection string
}

resource "google_sql_database_instance" "main" {
  name             = "${var.name_prefix}-postgres"
  project          = var.project_id
  region           = var.region
  database_version = "POSTGRES_16"

  # POSTGRES_16 requires edition = "ENTERPRISE" whenever a shared-core or
  # db-custom-* tier is used; omitting it fails at apply time (confirmed
  # 2026-09-17, not assumed).
  settings {
    tier              = var.cloudsql_tier
    edition           = "ENTERPRISE"
    availability_type = var.cloudsql_availability_type

    ip_configuration {
      ipv4_enabled = true
    }

    backup_configuration {
      enabled = true
    }
  }

  deletion_protection = var.cloudsql_deletion_protection
}

# One logical database. The app/public schema (Prisma migrations) and the
# dbos schema (DBOS's own bootstrap at DBOS.launch()) both live inside it -
# schemas, not separate databases, mirroring local dev's DBOS_SCHEMA
# convention. Nothing else for Terraform to provision here: both schemas
# are created by the application at runtime, not by this module.
resource "google_sql_database" "app" {
  name     = var.name_prefix
  project  = var.project_id
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = var.name_prefix
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  password = random_password.db_password.result
}
