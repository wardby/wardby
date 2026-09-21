# External HTTPS load balancer + Cloud Armor, in front of Cloud Run.
#
# Cloud Run itself has no request rate limiting, and once the service is
# publicly invokable (which it must be - see var.allow_unauthenticated) the
# only throttle is the app's own per-IP limiter, which costs a Postgres
# round-trip per request and is trivially bypassed by rotating source IPs.
# This moves that defence to the edge, in front of the container.
#
# Everything here is gated on var.enable_cloud_armor and creates nothing when
# it is false.

resource "google_compute_security_policy" "control_plane" {
  count   = var.enable_cloud_armor ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-control-plane"

  rule {
    action      = "throttle"
    priority    = 1000
    description = "Per-IP rate limit"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = var.cloud_armor_rate_limit_per_minute
        interval_sec = 60
      }
    }
  }

  # Cloud Armor requires an explicit default rule at the lowest priority.
  rule {
    action      = "allow"
    priority    = 2147483647
    description = "Default allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

resource "google_compute_region_network_endpoint_group" "control_plane" {
  count                 = var.enable_cloud_armor ? 1 : 0
  project               = var.project_id
  name                  = "${var.name_prefix}-control-plane-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.main.name
  }
}

resource "google_compute_backend_service" "control_plane" {
  count                 = var.enable_cloud_armor ? 1 : 0
  project               = var.project_id
  name                  = "${var.name_prefix}-control-plane-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.control_plane[0].id

  backend {
    group = google_compute_region_network_endpoint_group.control_plane[0].id
  }
}

resource "google_compute_url_map" "control_plane" {
  count           = var.enable_cloud_armor ? 1 : 0
  project         = var.project_id
  name            = "${var.name_prefix}-control-plane-lb"
  default_service = google_compute_backend_service.control_plane[0].id
}

# The load balancer needs a stable address before the certificate, because a
# domainless deployment has nothing else to name itself by - see
# local.mcp_canonical_uri, which uses this IP as the canonical URI. Creating
# the address first is also what lets a domainless armored deployment come up
# in a single apply, rather than the two-pass dance the *.run.app URL forces.
resource "google_compute_global_address" "control_plane" {
  count   = var.enable_cloud_armor ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-control-plane-ip"
}

# Certificate. With a domain, Google manages it. Without one there is nothing
# for a managed certificate to validate against, so the module self-signs for
# the load balancer's IP: enough to exercise the real HTTPS path end to end,
# but clients must skip verification (curl -k), so it is for evaluation only.
resource "tls_private_key" "self_signed" {
  count     = var.enable_cloud_armor && var.domain_name == null ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "control_plane" {
  count           = var.enable_cloud_armor && var.domain_name == null ? 1 : 0
  private_key_pem = tls_private_key.self_signed[0].private_key_pem
  ip_addresses    = [google_compute_global_address.control_plane[0].address]

  subject {
    common_name  = google_compute_global_address.control_plane[0].address
    organization = "wardby (self-signed, evaluation only)"
  }

  validity_period_hours = 8760
  allowed_uses          = ["key_encipherment", "digital_signature", "server_auth"]
}

resource "google_compute_ssl_certificate" "self_signed" {
  count       = var.enable_cloud_armor && var.domain_name == null ? 1 : 0
  project     = var.project_id
  name_prefix = "${var.name_prefix}-self-signed-"
  private_key = tls_private_key.self_signed[0].private_key_pem
  certificate = tls_self_signed_cert.control_plane[0].cert_pem

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_managed_ssl_certificate" "control_plane" {
  count   = var.enable_cloud_armor && var.domain_name != null ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-control-plane-cert"
  managed {
    domains = [var.domain_name]
  }
}

resource "google_compute_target_https_proxy" "control_plane" {
  count   = var.enable_cloud_armor ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-control-plane-https-proxy"
  url_map = google_compute_url_map.control_plane[0].id
  ssl_certificates = var.domain_name != null ? [
    google_compute_managed_ssl_certificate.control_plane[0].id
    ] : [
    google_compute_ssl_certificate.self_signed[0].id
  ]
}

resource "google_compute_global_forwarding_rule" "control_plane" {
  count                 = var.enable_cloud_armor ? 1 : 0
  project               = var.project_id
  name                  = "${var.name_prefix}-control-plane-https"
  target                = google_compute_target_https_proxy.control_plane[0].id
  ip_address            = google_compute_global_address.control_plane[0].id
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
