output "private_ip_address" {
  description = "The instance's private address. Reachable only from inside the peered VPC."
  value       = google_sql_database_instance.main.private_ip_address
}

output "instance_name" {
  description = "Cloud SQL instance name, for gcloud commands and the console."
  value       = google_sql_database_instance.main.name
}

output "database_name" {
  value = google_sql_database.app.name
}

output "database_user" {
  value = google_sql_user.app.name
}

# Marked sensitive so it is not printed by `terraform apply` or `terraform
# output` without being asked for by name. Read it with:
#
#   terraform output -raw database_url
#
# and pipe it straight into whatever builds the Kubernetes Secret -- never into
# a terminal that is being recorded or shared. `sslmode=require` matches the
# instance's ENCRYPTED_ONLY setting; without it a client that negotiates plain
# text is refused at connect time rather than at apply time.
output "database_url" {
  description = "Ready-to-use DATABASE_URL for the control plane and the coding proxy."
  value       = "postgresql://${google_sql_user.app.name}:${random_password.db.result}@${google_sql_database_instance.main.private_ip_address}:5432/${google_sql_database.app.name}?sslmode=require"
  sensitive   = true
}

output "database_password" {
  description = "The generated password on its own, for a secret store that wants it separately."
  value       = random_password.db.result
  sensitive   = true
}
