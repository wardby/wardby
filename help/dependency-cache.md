---
id: dependency-cache
title: Dependency cache for coding runs
summary: Restore npm node_modules from a verified snapshot before a coding agent starts, so runs skip the install.
audience: operator
tags: [coding-agents, packages, npm, node_modules, dependency-cache, cache, npm-ci, lockfile, snapshot, restore, blob-store, workspaces, tool_unavailable, budget_too_small, snapshot_skipped, timeout, CODING_CPUS, CODING_MEMORY_MB, disk, sha_mismatch, unsafe_archive, dependencyCache, worker_input_failed, workerImageRef]
appliesTo: >=0.7.0
---

# Dependency cache for coding runs

With the dependency cache on, a coding run's `node_modules` is prepared
**before the agent starts** from a snapshot in a blob store, so the agent
doesn't spend minutes on `npm ci`. It covers npm only. Off by default.

## How it behaves

For each eligible project the run reports one result in `get_run`
(`dependencyCache.projects[]`):

- `hit`: a snapshot for this exact lockfile was restored; nothing was
  installed. A snapshot that fails to download or verify isn't used: the
  project installs `cold` instead.
- `nearest`: a snapshot for an older lockfile of the same repository and folder
  was restored, then updated to the committed lockfile.
- `cold`: no snapshot, so `npm ci` ran and the result was stored (when it fit the disk).
- `skipped` or `refused`: nothing was prepared and the agent installs for
  itself. A skip never fails the run; its `reason` says why.

The agent's task says dependencies are pre-installed and not to run `npm ci`
there (it would delete the prepared tree); `npm install <package>` is fine.
A pull request gets a "Dependency cache: restored `node_modules` for ..." line
for folders restored from a snapshot.

## Why it is safe

- Snapshots are built only by Wardby, before the agent starts. Then the upload
  window is sealed: the worker seals it, and the coding proxy seals it itself
  on the run's first model request, so the agent can't read or write the
  cache.
- A restore happens only after the coding proxy re-approves the committed
  lockfile under the agent's current allowlist, release age and advisory
  policy. A policy that now refuses a package means no restore.
- Agents on the same repository share snapshots (the key is the repository,
  project folder, lockfile and image, not the package policy), and each
  restore is still gated by that agent's own current policy.
- Keys come from the server, not the worker. Downloads are checked against the
  SHA-256 and size the proxy recorded (that is the integrity check), the
  archive is scanned, and the tree's recorded package versions are compared
  with the lockfile before use. A damaged snapshot is deleted and rebuilt.
  A restore skips re-scanning an archive whose scan result was recorded at
  upload and whose digest matches; extraction still enforces every archive
  rule.
- The packages are the ones the agent's policy approves; the cache doesn't vet
  their contents beyond what a normal install through the registry does.
- Install scripts are not cached. Snapshots are built with `--ignore-scripts`;
  `npm rebuild` runs after the seal, only when needed, with a minimal
  environment.

## When it applies

- npm with `package-lock.json` `lockfileVersion` 2 or 3, at the repository root
  and/or up to 4 projects up to 3 folders deep.
- Ignored: `node_modules`, dot-folders, symlinks, folders that already have a
  `node_modules`, and npm workspaces monorepos (root and members are skipped).
- The agent needs a package allowlist.
- Every worker image must come from a release that includes the cache: the
  Codex worker images, the Claude Code worker image and its tool runner
  images. An older Codex or Claude Code worker image fails the run at input
  (`worker_input_failed`). Rebuild a `workerImageRef` image `FROM` that
  release's driver image (Codex) or tool runner image (Claude Code) first;
  `create_agent` and `update_agent` warn when an agent has both.

## Turn it on

1. On the coding proxy: `WARDBY_DEPENDENCY_CACHE=true` plus a blob store
   (`BLOB_STORE=gcs|s3|local` and its bucket or directory variables). GKE:
   `dependency_cache_enabled` and `dependency_cache_bucket_name` in Terraform,
   then `WARDBY_DEPENDENCY_CACHE=true deploy/gke/up.sh`. AWS: the same Terraform
   variables, plus the `BLOB_STORE_S3_*` proxy variables. kind:
   `WARDBY_DEPENDENCY_CACHE=true bash deploy/kind-coding/up.sh` (not durable).
   Docker quickstart: add `WARDBY_DEPENDENCY_CACHE=true` to `.wardby/.env`
   (requires wardby 0.7.0 or later).
2. GKE: nothing extra. `up.sh` grants the proxy the `DependencySnapshot`
   table before the rollout.
3. Per agent, once the worker images are current: `update_agent` with
   `codingProfile.dependencyCache: true`. This needs `packages:approve` or
   `agents:admin`.

## Disk use

The cache works within a budget: the run's workspace disk
(`workspaceDiskMb`) less what the checkout uses and a margin. Restores and the
snapshot archive are held to it while they are written. An install is checked
only before it starts: at least 1 GiB must be left (or twice the project's
tree when a snapshot of it was seen), otherwise the project is
`budget_too_small` and the agent installs for itself. npm's writes during the
install itself aren't bounded. After its own install the worker deletes npm's
download cache (`_cacache`), then archives the tree for upload only if the
archive fits what is left. A snapshot skipped for space keeps the installed
tree and the `cold` or `nearest` result; the worker log says
`snapshot_skipped` (reason `budget`), not `get_run`.

Tuning, on the proxy: `WARDBY_DEPENDENCY_CACHE_MAX_SNAPSHOT_MB` (1024),
`_REPO_CAP_MB` (4096), `_TOTAL_CAP_MB` (20480), `_MAX_AGE_DAYS` (14, counted
from creation, so snapshots are rebuilt periodically) and `_UPLOAD_SECONDS`
(900). On GKE and AWS keep the Terraform `dependency_cache_max_age_days` equal
to `_MAX_AGE_DAYS`; the bucket also deletes objects older than that plus 7 days.

## Troubleshooting

Read `dependencyCache` in `get_run`; then match the `reason`. A rejected `hit`
or `nearest` snapshot is not a reason: the project shows `cold`.

| Reason                                                                                       | What to do                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no_lockfile`, `lockfile_unreadable`, `no_package_json`, `no_dependencies`                   | Nothing to cache in that folder.                                                                                                                                                                                                                   |
| `lockfile_version`                                                                           | Regenerate the lockfile with npm 7 or later.                                                                                                                                                                                                       |
| `workspaces`, `workspace_member`, `shrinkwrap_present`                                       | Not supported; the agent installs itself.                                                                                                                                                                                                          |
| `node_modules_present`, `cache_dir_unsafe`                                                   | Remove the committed `node_modules` or `.cache` (symlink) from the repository.                                                                                                                                                                     |
| `too_many_projects`                                                                          | Only 4 projects per run are prepared.                                                                                                                                                                                                              |
| `no_registry`, `plan_failed`, `plan_refused`                                                 | Give the agent a package allowlist and fix refused packages; see [Approve packages for coding agents](help://coding-packages). A plan the proxy left incomplete is retried for up to 10 minutes (at most 5 attempts per project, 8 plans per run). |
| `cache_unavailable`, `plan_required`, `sealed`, `lookup_failed`, `download_failed`           | Check `WARDBY_DEPENDENCY_CACHE` and `BLOB_STORE` on the proxy, the store's permissions and the proxy log.                                                                                                                                          |
| `size_mismatch`, `sha_mismatch`, `unsafe_archive`, `inconsistent`                            | The snapshot was not trusted; the project installed `cold` instead. It is rebuilt when it ages out or is deleted. Repeats point at the blob store.                                                                                                 |
| `too_large`, `over_budget`, `budget_unknown`, `budget_too_small`                             | Raise `WARDBY_DEPENDENCY_CACHE_MAX_SNAPSHOT_MB` or the agent's `workspaceDiskMb` (see [Disk use](#disk-use)).                                                                                                                                      |
| `install_failed`, `timeout`, `cancelled`, `internal_error`, `worker_error`, `report_invalid` | The agent installs for itself; check the worker log. The preparation gets at most 20 minutes or half the time left before the run's deadline. On Docker a huge restore can exhaust the tmpfs inode limit before its bytes.                         |
| `tool_unavailable`                                                                           | Claude Code tool-runner image predates the cache or is custom; rebuild it from the current tool-runner image. The proxy still seals on the run's first model request.                                                                              |
| `already_started`, `invalid_deadline`                                                        | Not expected: a command ran before preparation, or the worker and tool runner images are from different releases.                                                                                                                                  |
| `worker_input_failed` (the run fails)                                                        | A Codex or Claude Code worker image, or a `workerImageRef` image, older than the cache. Update the images, or rebuild the custom image `FROM` the current release, before turning the cache on.                                                    |

Every run of a large project installing `cold` again usually means its
snapshot is never stored. Check the worker log for `snapshot_skipped` with
reason `timeout`: its `limit` says which bound ran out. For `pack` or
`deadline`, give coding pods more CPU (`CODING_CPUS=2`); for `upload_window`,
raise `WARDBY_DEPENDENCY_CACHE_UPLOAD_SECONDS`. A large tree (about 1 GiB) can
also need more than the default 2048 MiB of memory to install under gVisor;
raise `CODING_MEMORY_MB`.

`rebuild` of `failed`, `timeout` or `unsealed` means native add-ons may be
unbuilt; the agent can run `npm rebuild`.

The full reference, with every limit, is
[`docs/coding-packages.md`](../docs/coding-packages.md#dependency-cache).
