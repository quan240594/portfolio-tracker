#!/usr/bin/env bash
# Finds the largest nominal `ms` that a probe endpoint survives, by doubling then bisecting, and appends every attempt
# to results.csv. Usage:
#   BASE=https://pt-limits-probe.<your-subdomain>.workers.dev ./scripts/find-cap.sh /burn          # Worker HTTP
#   BASE=... ./scripts/find-cap.sh /do-burn                                                       # Durable Object fetch
#   BASE=... ./scripts/find-cap.sh /do-alarm-burn  alarm                                          # DO alarm (async, see /results)
#   BASE=... ./scripts/find-cap.sh /queue-burn     async                                          # Queue consumer
#   BASE=... ./scripts/find-cap.sh /cron-set       cron                                           # Cron (one try per 5 minutes)
# A failed HTTP attempt shows up as a non-200 status (Cloudflare answers Error 1102 "Worker exceeded resource limits",
# normally with HTTP 503) -- the script treats any non-200 or a body containing "1102" as "exceeded".
# Keep the request count low: every attempt costs one of the 100,000 daily requests (nothing else, no money).
set -euo pipefail
BASE="${BASE:?set BASE=https://pt-limits-probe.<subdomain>.workers.dev}"
PATH_="${1:?endpoint path, e.g. /burn}"
MODE="${2:-sync}"
OUT="${OUT:-results.csv}"
[ -f "$OUT" ] || echo "timestamp,endpoint,requested_ms,http_status,verdict" > "$OUT"

try_sync() { # ms -> prints ok|exceeded (the body is kept in a variable: no temp files)
  local ms="$1" out status body verdict=ok
  out="$(curl -s -m 60 -w '\n%{http_code}' "$BASE$PATH_?ms=$ms" || printf '\n000')"
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"
  if [ "$status" != "200" ] || printf '%s' "$body" | grep -q '1102'; then verdict=exceeded; fi
  echo "$(date -u +%FT%TZ),$PATH_,$ms,$status,$verdict" >> "$OUT"
  echo "$verdict"
}

try_async() { # ms -> prints ok|exceeded|pending (waits up to 20 s for the ledger entry to finish)
  local ms="$1" id i verdict=pending
  id="$(curl -s -m 30 "$BASE$PATH_?ms=$ms" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
  for i in $(seq 1 20); do
    sleep 1
    local row; row="$(curl -s -m 30 "$BASE/results")"
    if echo "$row" | grep -q "\"id\":\"$id\"[^}]*\"finished\":\"[0-9]"; then verdict=ok; break; fi
  done
  [ "$verdict" = pending ] && verdict=exceeded
  echo "$(date -u +%FT%TZ),$PATH_,$ms,async,$verdict" >> "$OUT"
  echo "$verdict"
}

if [ "$MODE" = cron ]; then
  echo "Cron: run '$BASE/cron-set?ms=N' for a few N, wait for the next */5 tick, then read $BASE/results (finished entry = survived)."
  exit 0
fi
TRY=try_sync
if [ "$MODE" = alarm ] || [ "$MODE" = async ]; then TRY=try_async; fi

lo=0; hi=1
MAX="${MAX:-8192}"
# doubling phase: 1, 2, 4, ... until the first failure (max $MAX ms nominal)
while [ "$hi" -le "$MAX" ]; do
  r="$($TRY "$hi")"; echo "ms=$hi -> $r"
  if [ "$r" = ok ]; then lo="$hi"; hi=$((hi * 2)); else break; fi
done
if [ "$hi" -gt "$MAX" ] && [ "$r" = ok ]; then echo "no failure up to $lo nominal ms for $PATH_ (raise MAX to go further)"; exit 0; fi
# bisect between the last success and the first failure
while [ $((hi - lo)) -gt 1 ]; do
  mid=$(((lo + hi) / 2))
  r="$($TRY "$mid")"; echo "ms=$mid -> $r"
  if [ "$r" = ok ]; then lo="$mid"; else hi="$mid"; fi
done
echo "LARGEST SURVIVING nominal ms for $PATH_: $lo (first failure: $hi)  [see $OUT]"
echo "Now read the real CPU time of an $lo-ms call from 'npm run tail' / Workers Logs to convert nominal ms into platform CPU ms."
