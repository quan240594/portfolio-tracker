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

sonar-scanner \
  -Dsonar.host.url=https://sonarcloud.io \
  -Dsonar.token="$SONAR_TOKEN" \
  -Dsonar.branch.name="$BRANCH"
