#!/usr/bin/env bash
# Runs the whole probe in one go (about 5 minutes) and writes results.csv + summary.txt in the current folder.
#   BASE=https://pt-limits-probe.<your-subdomain>.workers.dev ./scripts/run-all.sh
# Every attempt costs one request of the 100,000 free ones per day, nothing else. Nothing here can be billed: on the Free
# plan a call over a cap simply fails (Error 1102 / 1027).
set -uo pipefail
BASE="${BASE:?set BASE=https://pt-limits-probe.<your-subdomain>.workers.dev}"
export BASE OUT="${OUT:-results.csv}" MAX="${MAX:-4096}"
SUMMARY="${SUMMARY:-summary.txt}"
here="$(cd "$(dirname "$0")" && pwd)"
: > "$SUMMARY"
log() { echo "$*" | tee -a "$SUMMARY"; }

log "== probe run $(date -u +%FT%TZ) against $BASE =="
for spec in "/burn" "/do-burn" "/do-alarm-burn alarm" "/queue-burn async"; do
  log "-- find-cap $spec"
  # shellcheck disable=SC2086
  "$here/find-cap.sh" $spec 2>&1 | tee -a "$SUMMARY" | tail -2
done

log "-- subrequests (expect 50 to succeed on the Free plan, then an error)"
curl -s -m 60 "$BASE/subrequests?n=60" | tee -a "$SUMMARY"; echo | tee -a "$SUMMARY"
log "-- 60 separate D1 statements (do they count against the 50 subrequests?)"
curl -s -m 60 "$BASE/d1-queries?n=60" | tee -a "$SUMMARY"; echo | tee -a "$SUMMARY"
log "-- ONE db.batch() of 120 statements (1 subrequest or 120?)"
curl -s -m 60 "$BASE/d1-batch?n=120" | tee -a "$SUMMARY"; echo | tee -a "$SUMMARY"
log "-- 2000 rows written through multi-row inserts (compare rowsWritten with 2000)"
curl -s -m 60 "$BASE/d1-write?n=2000" | tee -a "$SUMMARY"; echo | tee -a "$SUMMARY"

log
log "Cron is the only surface left: run  curl \"$BASE/cron-set?ms=5\"  then wait for the next */5 tick and read  $BASE/results"
log "(repeat with 8, 12, 50: an entry without \`finished\` was killed). Details: limits-probe/README.md step 6."
log "Next: convert the nominal ms above into real CPU ms with 'npm run tail' (README step 5), then fill in the results table."
