#!/usr/bin/env bash
# Builds services/prices/dist/prices.zip (Lambda python3.12, arm64) with the `prices/` package at the
# zip root. Handlers: prices.handlers.scheduled_refresh / prices.handlers.on_transactions_changed.
# Works from any cwd. Runtime deps from requirements.txt (normally none) are installed for arm64.
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${SERVICE_DIR}/build/package"
DIST_DIR="${SERVICE_DIR}/dist"
ZIP_PATH="${DIST_DIR}/prices.zip"
PYTHON="${PYTHON:-python3}"

command -v zip >/dev/null 2>&1 || { echo "error: 'zip' is required" >&2; exit 1; }

rm -rf "${BUILD_DIR}" "${ZIP_PATH}"
mkdir -p "${BUILD_DIR}" "${DIST_DIR}"

# Copy the package, excluding caches/tests/bytecode.
(cd "${SERVICE_DIR}" && find prices -type f -name '*.py' \
  -not -path '*/__pycache__/*' -not -path '*/tests/*' -not -name 'test_*.py' -print0 \
  | while IFS= read -r -d '' f; do
      mkdir -p "${BUILD_DIR}/$(dirname "$f")"
      cp "$f" "${BUILD_DIR}/$f"
    done)

# Third-party runtime deps (none today). Built for the Lambda platform, never the host.
if grep -Eqv '^[[:space:]]*(#|$)' "${SERVICE_DIR}/requirements.txt" 2>/dev/null; then
  "${PYTHON}" -m pip install --quiet --no-compile -r "${SERVICE_DIR}/requirements.txt" \
    --target "${BUILD_DIR}" --platform manylinux2014_aarch64 --implementation cp \
    --python-version 3.12 --only-binary=:all:
fi

# Reproducible archive: fixed mtimes + sorted entries => stable hash for Terraform source_code_hash.
find "${BUILD_DIR}" -exec touch -h -t 202001010000 {} +
(cd "${BUILD_DIR}" && find . -type f | LC_ALL=C sort | sed 's|^\./||' | zip -X -q -@ "${ZIP_PATH}")

rm -rf "${SERVICE_DIR}/build"
echo "built ${ZIP_PATH} ($(wc -c < "${ZIP_PATH}" | tr -d ' ') bytes)"
