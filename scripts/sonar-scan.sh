#!/usr/bin/env bash
# Runs a local SonarCloud scan for this project using the token in
# .env.sonar.local (gitignored, never committed - see README/.gitignore).
# Setup (one-time, run this yourself so the token never appears in chat/logs):
#   read -s "SONAR_TOKEN?SonarCloud token: " && echo && \
#     printf 'SONAR_TOKEN=%s\n' "$SONAR_TOKEN" > .env.sonar.local && \
#     chmod 600 .env.sonar.local && unset SONAR_TOKEN
# Pass --coverage to regenerate all coverage reports before scanning.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env.sonar.local ]; then
  echo "Missing .env.sonar.local - see the setup comment at the top of this script." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.sonar.local
set +a

if [ -z "${SONAR_TOKEN:-}" ]; then
  echo "SONAR_TOKEN is not set in .env.sonar.local" >&2
  exit 1
fi

if [ "${1:-}" = "--coverage" ]; then
  scripts/coverage.sh
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# SonarCloud's JS/TS analyzer needs a current Node LTS (>= 22). If the default `node` is older,
# use SONAR_NODEJS_EXECUTABLE or the newest installed even-numbered (LTS) Node >= 22.
# Prints the major version, or nothing if the binary is missing/broken (e.g. a dangling Homebrew dylib).
node_major() {
  local v
  v="$({ "$1" -v; } 2>/dev/null)" 2>/dev/null || return 0
  v="${v#v}"
  echo "${v%%.*}"
}
NODE_ARGS=()
if [ -n "${SONAR_NODEJS_EXECUTABLE:-}" ]; then
  NODE_ARGS=(-Dsonar.nodejs.executable="$SONAR_NODEJS_EXECUTABLE")
elif [ "$(node_major node)" -lt 22 ] 2>/dev/null || [ -z "$(node_major node)" ]; then
  best="" best_major=0
  for candidate in "$HOME"/.nvm/versions/node/v*/bin/node /opt/homebrew/opt/node@*/bin/node /usr/local/opt/node@*/bin/node; do
    [ -x "$candidate" ] || continue
    major="$(node_major "$candidate")"
    if [ -n "$major" ] && [ "$major" -ge 22 ] && [ $((major % 2)) -eq 0 ] && [ "$major" -gt "$best_major" ]; then
      best="$candidate" best_major="$major"
    fi
  done
  if [ -z "$best" ]; then
    echo "sonar-scan: Node >= 22 LTS required for the JS/TS analyzer (found $(node -v)); set SONAR_NODEJS_EXECUTABLE." >&2
    exit 1
  fi
  echo "sonar-scan: using $best ($("$best" -v)) for the JS/TS analyzer"
  NODE_ARGS=(-Dsonar.nodejs.executable="$best")
fi

sonar-scanner \
  -Dsonar.host.url=https://sonarcloud.io \
  -Dsonar.token="$SONAR_TOKEN" \
  -Dsonar.branch.name="$BRANCH" \
  ${NODE_ARGS[@]+"${NODE_ARGS[@]}"}
