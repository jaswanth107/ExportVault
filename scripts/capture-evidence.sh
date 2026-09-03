#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Captures the project's verification evidence into docs/evidence/.
# Everything here is real command output; nothing is transcribed by hand.
# Requires the local stack to be running (docker compose up -d).
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=docs/evidence
mkdir -p "$OUT"

echo "==> 1/6 database record count"
docker exec exportvault-db psql -U exportvault -d exportvault -c \
  "SELECT COUNT(*) AS total_records, COUNT(DISTINCT external_id) AS distinct_external_ids, MIN(id) AS min_id, MAX(id) AS max_id FROM records;" \
  > "$OUT/01-database-records.txt" 2>&1

echo "==> 2/6 unit tests"
(cd server && npm run test:unit) > "$OUT/02-unit-tests.txt" 2>&1

echo "==> 3/6 integration tests"
(cd server && npm run test:integration) > "$OUT/03-integration-tests.txt" 2>&1

echo "==> 4/6 concurrency + interruption + verification tests"
# The reliability tests spawn and kill their OWN worker processes. The stack's
# worker container must stand down, or it would race them for the queue and
# quietly complete the very job a test is trying to crash.
docker stop exportvault-worker >/dev/null 2>&1 || true
(cd server && npm run test:concurrency) > "$OUT/04-concurrency-tests.txt" 2>&1
CONCURRENCY_EXIT=$?
docker start exportvault-worker >/dev/null 2>&1 || true
until curl -sf http://localhost:5000/health >/dev/null 2>&1; do sleep 1; done
echo "    concurrency suite exit code: $CONCURRENCY_EXIT" 

echo "==> 5/6 end-to-end CSV audit against a live export"
node scripts/auditLiveExport.mjs > "$OUT/05-csv-audit.txt" 2>&1

echo "==> 6/6 no-silent-failure audit"
{
  echo "# Empty catch blocks  ->  catch (...) { }"
  grep -rEn 'catch\s*(\([^)]*\))?\s*\{\s*\}' server/src client/src --include='*.ts' --include='*.tsx' || echo "(none found)"
  echo
  echo "# catch blocks returning null without logging"
  grep -rEn -A2 'catch\s*\([^)]*\)\s*\{' server/src client/src --include='*.ts' --include='*.tsx' \
    | grep -E 'return null;' || echo "(none found)"
  echo
  echo "# SQL OFFSET / Prisma skip: pagination in application source"
  grep -rEn 'OFFSET\s+[0-9$:{]|[^A-Za-z]skip\s*:' server/src --include='*.ts' \
    | grep -v '/tests/' || echo "(none found)"
} > "$OUT/06-no-silent-failures.txt" 2>&1

echo
echo "Evidence written to $OUT:"
ls -1 "$OUT"
