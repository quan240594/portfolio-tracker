#!/usr/bin/env bash
# Vitest writes `SF:` paths relative to each package; Sonar resolves them from the repo root, so prefix every
# lcov.info with its package dir (the parent of `coverage/`). Idempotent. Used by scripts/coverage.sh and CI.
set -euo pipefail
cd "$(dirname "$0")/.."

while IFS= read -r report; do
  pkg="${report%/coverage/lcov.info}"
  perl -pi -e "s|^SF:(?!\Q$pkg/\E)|SF:$pkg/|" "$report"
done < <(find packages services web -path '*/node_modules' -prune -o -path '*/coverage/lcov.info' -print)
