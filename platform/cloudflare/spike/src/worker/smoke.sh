#!/usr/bin/env bash
# Calls the Worker running under `wrangler dev --local` and prints status, D1 queries, rows read (ours vs D1's meta).
BASE="${BASE:-http://127.0.0.1:8799}"
NOW="now=2026-10-15T12:00:00Z"
for p in "/health" "/portfolios" "/holdings" "/portfolio" "/analytics/summary" "/analytics/returns?period=year" "/history?range=ALL" "/calendar" "/dividends/overview" "/analytics/growth?range=1Y" "/assets/AAPL/history?range=ALL&benchmarks=IWDA.AS" "/export/transactions"; do
  sep='?'; case "$p" in *\?*) sep='&' ;; esac
  curl -s -o /dev/null -D - -w "bytes=%{size_download} wall=%{time_total}s\n" "$BASE$p$sep$NOW" \
    | tr -d '\r' | awk -v p="$p" '/^HTTP/{s=$2} /^x-d1-queries/{q=$2} /^x-rows-read/{r=$2} /^x-d1-meta-rows-read/{m=$2} /^bytes/{b=$0} END{printf "%-52s status=%s queries=%s rows_read(ours)=%s rows_read(D1 meta)=%s %s\n", p, s, q, r, m, b}'
done
