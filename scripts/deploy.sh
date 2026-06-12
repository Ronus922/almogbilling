#!/usr/bin/env bash
#
# scripts/deploy.sh — safe production deploy for the Alun CRM (billing) app.
#
# Prevents the "Postbuild Gotcha": `next build` rewrites .next/standalone/ on
# disk, but the live `node server.js` process keeps the OLD build's chunk
# manifests in memory — so it serves HTML/RSC referencing chunk filenames that
# no longer exist → 404 → ChunkLoadError → "This page couldn't load".
#
# Order of operations:
#   1. npm run build  (compile + postbuild copy into .next/standalone/)
#   2. only if the build succeeded → restart billing.service
#   3. short wait, then verify the service is `active`
#   4. verify the NEW process actually picked up the build on disk
#      (process start time must be later than .next/BUILD_ID write time)
#   5. print a clear summary
#
# Passwordless restart is granted by /etc/sudoers.d/billing-deploy, scoped to
# exactly `systemctl restart billing.service` (see that file).
#
set -Eeuo pipefail

SERVICE="billing.service"
SYSTEMCTL="/usr/bin/systemctl"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# --- pretty output helpers -------------------------------------------------
if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; DIM=$'\e[2m'; RESET=$'\e[0m'
else
  BOLD=''; GREEN=''; RED=''; YELLOW=''; DIM=''; RESET=''
fi
step() { printf '%s\n' "${BOLD}==> $*${RESET}"; }
ok()   { printf '%s\n' "${GREEN}✓ $*${RESET}"; }
warn() { printf '%s\n' "${YELLOW}! $*${RESET}"; }
fail() { printf '%s\n' "${RED}✗ $*${RESET}" >&2; }

on_error() {
  local line=$1
  fail "Deploy aborted (line ${line}). The running service was NOT changed unless the restart step already ran."
  exit 1
}
trap 'on_error $LINENO' ERR

# --- 1. build --------------------------------------------------------------
step "Building (npm run build)…"
if ! npm run build; then
  fail "Build failed — service left untouched. Fix the build and re-run 'npm run deploy'."
  exit 1
fi
ok "Build succeeded."

# Record when this build stamped its BUILD_ID. The restarted process must come
# up AFTER this instant to prove it loaded the fresh build.
BUILD_ID="$(cat .next/BUILD_ID)"
BUILD_EPOCH="$(stat -c %Y .next/BUILD_ID)"

# Sanity: the standalone copy postbuild produced must carry the same BUILD_ID.
STANDALONE_BUILD_ID="$(cat .next/standalone/.next/BUILD_ID 2>/dev/null || echo '<missing>')"
if [[ "$BUILD_ID" != "$STANDALONE_BUILD_ID" ]]; then
  fail "BUILD_ID mismatch: .next='${BUILD_ID}' vs standalone='${STANDALONE_BUILD_ID}'. postbuild copy is broken."
  exit 1
fi

# --- 2. restart ------------------------------------------------------------
step "Restarting ${SERVICE}…"
sudo "$SYSTEMCTL" restart "$SERVICE"

# --- 3. wait + active check ------------------------------------------------
step "Waiting for the service to come up…"
ACTIVE=""
for _ in $(seq 1 10); do
  sleep 1
  ACTIVE="$("$SYSTEMCTL" is-active "$SERVICE" 2>/dev/null || true)"
  [[ "$ACTIVE" == "active" ]] && break
done
if [[ "$ACTIVE" != "active" ]]; then
  fail "Service is '${ACTIVE:-unknown}', not 'active'. Inspect: journalctl -u ${SERVICE} -n 50"
  exit 1
fi
ok "Service is active."

# --- 4. verify the process loaded the fresh build --------------------------
step "Verifying the running process matches the build on disk…"
PID="$("$SYSTEMCTL" show "$SERVICE" -p MainPID --value)"
START_RAW="$("$SYSTEMCTL" show "$SERVICE" -p ExecMainStartTimestamp --value)"
if [[ -z "$START_RAW" ]]; then
  fail "Could not read the service start time."
  exit 1
fi
START_EPOCH="$(date -d "$START_RAW" +%s)"

if (( START_EPOCH < BUILD_EPOCH )); then
  fail "Stale process: it started BEFORE the new build was written."
  fail "  process start : $(date -d "@$START_EPOCH" '+%F %T %Z')"
  fail "  BUILD_ID write: $(date -d "@$BUILD_EPOCH" '+%F %T %Z')"
  fail "The Postbuild Gotcha is still in effect — re-run 'sudo systemctl restart ${SERVICE}'."
  exit 1
fi
ok "Running process started after the build (no stale chunks)."

# --- 5. summary ------------------------------------------------------------
echo
step "Deploy summary"
printf '  %-18s %s\n' "Service:"        "${SERVICE} ${GREEN}active${RESET} (PID ${PID})"
printf '  %-18s %s\n' "BUILD_ID:"       "${BUILD_ID}"
printf '  %-18s %s\n' "BUILD_ID write:" "$(date -d "@$BUILD_EPOCH" '+%F %T %Z')"
printf '  %-18s %s\n' "Process start:"  "$(date -d "@$START_EPOCH" '+%F %T %Z')"
echo
ok "${BOLD}Deploy complete — production is serving the fresh build.${RESET}"
