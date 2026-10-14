#!/usr/bin/env bash
# Regenerates every coverage report referenced by sonar-project.properties
# (lcov.info per TS package + services/prices/coverage.xml). Used by CI, the
# pre-push hook and scripts/sonar-scan.sh --coverage.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "coverage: TypeScript packages (vitest)..."
pnpm test:coverage

scripts/fix-lcov-paths.sh

echo "coverage: services/prices (pytest)..."
cd services/prices
PYTHON_BIN=".venv/bin/python"
[ -x "$PYTHON_BIN" ] || PYTHON_BIN="python3"
"$PYTHON_BIN" -m pytest -q --cov=prices --cov-report=xml:coverage.xml
