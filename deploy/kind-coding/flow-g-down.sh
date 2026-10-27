#!/usr/bin/env bash
# TEST ONLY: removes the Flow G kind cluster (wardby-flowg) and its private database. Touches no
# other cluster.
set -euo pipefail
kind delete cluster --name wardby-flowg
docker exec "${WARDBY_FLOWG_PG_CONTAINER:-local-postgres-1}" psql -U wardby -d wardby -q -c "DROP DATABASE IF EXISTS wardby_flowg WITH (FORCE);"
