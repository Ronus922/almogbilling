#!/usr/bin/env bash
# Playwright webServer command: start the production (standalone) build on
# $PORT. Builds first when there is no build yet or E2E_REBUILD=1.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if [[ ! -f .next/standalone/server.js || "${E2E_REBUILD:-0}" == "1" ]]; then
  echo "[e2e] no standalone build (or E2E_REBUILD=1) — running npm run build" >&2
  npm run build >&2
fi
exec node .next/standalone/server.js
