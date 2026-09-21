#!/bin/sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${TASK0B_KEY_FILE:?set TASK0B_KEY_FILE to a mode-0600 file containing a disposable project key}"

key_mode=$(stat -f '%Lp' "$TASK0B_KEY_FILE" 2>/dev/null || stat -c '%a' "$TASK0B_KEY_FILE")
if [ "$key_mode" != "600" ]; then
  printf '%s\n' "refusing key file with mode $key_mode; expected 600" >&2
  exit 1
fi

capability=${WARDBY_RUN_CAPABILITY:-"wardby-task0b-$(openssl rand -hex 24)"}
if [ -n "${TASK0B_EVIDENCE_DIR:-}" ]; then
  evidence_dir=$TASK0B_EVIDENCE_DIR
  mkdir -p "$evidence_dir"
else
  mkdir -p "$here/evidence"
  evidence_dir=$(mktemp -d "$here/evidence/run.XXXXXX")
fi
chmod 700 "$evidence_dir"

export TASK0B_EVIDENCE_DIR="$evidence_dir"
export WARDBY_RUN_CAPABILITY="$capability"

cleanup() {
  docker compose -f "$here/compose.task0b.yml" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker compose -f "$here/compose.task0b.yml" build worker
docker compose -f "$here/compose.task0b.yml" up --detach --wait proxy
docker compose -f "$here/compose.task0b.yml" run --rm worker
