# One repository per image deploy/gke/docker-bake.hcl builds (module.test.mjs
# keeps the lists equal). Build with REGISTRY=<output ecr_registry>. Tags are
# mutable because the bake pushes :latest; the deployment pins every image by
# digest, and the launcher refuses a tag.

locals {
  image_names = toset([
    "runtime",
    "migration",
    "coding-worker",
    "coding-worker-node-python",
    "claude-coding-worker",
    "claude-tool-runner",
    "claude-tool-runner-node-python",
    "native-worker",
    # Optional PNG/PDF export renderer: built from the renderer bake target, not in its default group.
    "renderer",
  ])
}

resource "aws_ecr_repository" "images" {
  for_each = local.image_names

  name                 = "${var.name_prefix}/${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = var.ecr_force_delete

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}
