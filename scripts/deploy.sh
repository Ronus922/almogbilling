#!/usr/bin/env bash
#
# scripts/deploy.sh — atomic production deploy for the ALMOG billing app.
#
#   npm run deploy            build → promote → restart → smoke test (→ automatic rollback)
#   npm run deploy:rollback   switch back to the one kept previous build
#
# Layout (under the project root, gitignored):
#   .deploy/releases/<BUILD_ID>/  complete standalone builds (server.js, .next, node_modules, public)
#   .deploy/current  → releases/<BUILD_ID>   the build billing.service runs
#   .deploy/previous → releases/<BUILD_ID>   exactly one older build, kept for rollback
#   .next/standalone → ../.deploy/current    the path billing.service's ExecStart names
#
# Why: `next build` empties .next/ (everything but the cache) before it
# compiles. While the live process ran straight out of .next/standalone, every
# build pulled its files out from under it, and a FAILED build left it that way:
# /api/health and the HTML stayed 200 while every /_next/static chunk answered
# 500 — a blank site behind green checks (29/09/2026). Node resolves the
# symlinks when the process starts, so the process runs from
# .deploy/releases/<BUILD_ID>/ and nothing the build does to .next/ reaches it.
#
# Order of operations (npm run deploy):
#   0. guards — this checkout is the one billing.service runs; no proof files under public/
#   1. make sure the live process runs from a release (one-time switch from the old layout)
#   2. npm run build in .next/ — production keeps serving the current release untouched
#   3. only if the build succeeded → move .next/standalone into .deploy/releases/<BUILD_ID>
#      and swap .deploy/current to it (rename(2) of a symlink: atomic)
#   4. restart billing.service
#   5. smoke test: /login and /portal/login answer 200 with a fixed marker and the NEW
#      BUILD_ID, every /_next/static asset they reference answers 200, /api/health is 200
#   6. smoke test failed → swap back to the previous release, restart, smoke test it again
#   7. success → the replaced release becomes .deploy/previous; any older release is deleted
#
# Database migrations are NOT part of this script (npm run db:up, separately).
# A rollback switches code only — it never reverses a migration.
#
# Passwordless restart is granted by /etc/sudoers.d/billing-deploy, scoped to
# exactly `systemctl restart billing.service` (see that file).
#
# Test hooks (all off by default; never set them in production unless you mean it):
#   DEPLOY_SIMULATE_FAILURE=build  run the real build, then treat it as failed
#   DEPLOY_SIMULATE_FAILURE=smoke  promote and restart, then fail the new build's smoke
#                                  test (the automatic rollback runs for real)
#   DEPLOY_TEST_RESTART_CMD=<cmd>  restart a sandbox server with <cmd> instead of
#                                  billing.service (skips the systemd steps)
#   DEPLOY_BASE_URL=<url>          where the smoke test looks (default http://127.0.0.1:3003)
#
set -Eeuo pipefail

SERVICE="billing.service"
SYSTEMCTL="/usr/bin/systemctl"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

DEPLOY_DIR="$PROJECT_ROOT/.deploy"
RELEASES_DIR="$DEPLOY_DIR/releases"
CURRENT_LINK="$DEPLOY_DIR/current"
PREVIOUS_LINK="$DEPLOY_DIR/previous"
LIVE_PATH="$PROJECT_ROOT/.next/standalone"
LIVE_TARGET="../.deploy/current"

BASE_URL="${DEPLOY_BASE_URL:-http://127.0.0.1:3003}"
SIMULATE="${DEPLOY_SIMULATE_FAILURE:-}"
TEST_RESTART_CMD="${DEPLOY_TEST_RESTART_CMD:-}"
SMOKE_WAIT_SECONDS=120

# Pages the smoke test opens, each with a fixed string its server-rendered HTML
# always contains. Neither page touches the database.
SMOKE_PAGES=(
  "/login|ALMOG CRM"
  "/portal/login|כניסת בעלי דירות"
)

MODE="deploy"
case "${1:-}" in
  "") ;;
  --rollback) MODE="rollback" ;;
  *) echo "usage: scripts/deploy.sh [--rollback]" >&2; exit 2 ;;
esac

# --- pretty output helpers -------------------------------------------------
if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
else
  BOLD=''; GREEN=''; RED=''; YELLOW=''; RESET=''
fi
step() { printf '%s\n' "${BOLD}==> $*${RESET}"; }
ok()   { printf '%s\n' "${GREEN}✓ $*${RESET}"; }
warn() { printf '%s\n' "${YELLOW}! $*${RESET}"; }
fail() { printf '%s\n' "${RED}✗ $*${RESET}" >&2; }

on_error() {
  fail "Deploy aborted (line $1)."
  exit 1
}
trap 'on_error $LINENO' ERR
trap 'exit 130' INT TERM

# --- release helpers -------------------------------------------------------
# BUILD_ID a link points at ("" when the link is missing).
release_of() {
  if [[ -L "$1" ]]; then basename "$(readlink "$1")"; fi
}

# Point <link> at <target> atomically: rename(2) a fresh symlink over the old
# one, so there is no instant at which the link is missing.
swap_link() {
  ln -sfn "$2" "$1.tmp.$$"
  mv -Tf "$1.tmp.$$" "$1"
}

# .next/standalone must be the symlink to .deploy/current whenever no build is
# running. Whatever stands there otherwise (nothing, or a build that was never
# promoted) is not the live release, so it can go.
restore_live_link() {
  if [[ ! -L "$LIVE_PATH" && -L "$CURRENT_LINK" ]]; then
    rm -rf "$LIVE_PATH"
    swap_link "$LIVE_PATH" "$LIVE_TARGET"
  fi
}

restart_service() {
  if [[ -n "$TEST_RESTART_CMD" ]]; then
    bash -c "$TEST_RESTART_CMD" 9>&-   # the sandbox server must not inherit the deploy lock
    return
  fi
  if ! sudo "$SYSTEMCTL" restart "$SERVICE"; then
    fail "systemctl restart ${SERVICE} failed."
    return 1
  fi
  local active=""
  for _ in $(seq 1 10); do
    sleep 1
    active="$("$SYSTEMCTL" is-active "$SERVICE" 2>/dev/null || true)"
    [[ "$active" == "active" ]] && return 0
  done
  fail "${SERVICE} is '${active:-unknown}', not 'active'. Inspect: journalctl -u ${SERVICE} -n 50"
  return 1
}

http_code() {
  curl -s -o "${2:-/dev/null}" -w '%{http_code}' --max-time "${3:-10}" "$1" || true
}

# smoke_test <BUILD_ID> — is the restarted process really serving this build,
# with every asset its pages need? Explicit returns throughout: it runs as an
# `if` condition, where errexit does not apply.
smoke_test() {
  local expect="$1" deadline=$((SECONDS + SMOKE_WAIT_SECONDS)) code html assets path marker asset
  until [[ "$(http_code "$BASE_URL/login" /dev/null 5)" == "200" ]]; do
    if (( SECONDS >= deadline )); then
      fail "Smoke: ${BASE_URL}/login did not answer 200 within ${SMOKE_WAIT_SECONDS}s."
      return 1
    fi
    sleep 1
  done

  html="$(mktemp)"
  assets="$(mktemp)"
  : > "$assets"
  for entry in "${SMOKE_PAGES[@]}"; do
    path="${entry%%|*}"
    marker="${entry#*|}"
    code="$(http_code "$BASE_URL$path" "$html" 15)"
    if [[ "$code" != "200" ]]; then
      fail "Smoke: ${path} answered ${code}."
      rm -f "$html" "$assets"; return 1
    fi
    if ! grep -qF -- "$marker" "$html"; then
      fail "Smoke: ${path} is missing its marker \"${marker}\"."
      rm -f "$html" "$assets"; return 1
    fi
    if ! grep -qF -- "$expect" "$html"; then
      fail "Smoke: ${path} is not served by BUILD_ID ${expect}."
      rm -f "$html" "$assets"; return 1
    fi
    grep -oE '/_next/static/[A-Za-z0-9_./~-]+\.(js|css)' "$html" >> "$assets" || true
  done

  local count=0
  while IFS= read -r asset; do
    code="$(http_code "$BASE_URL$asset")"
    if [[ "$code" != "200" ]]; then
      fail "Smoke: ${asset} answered ${code} — the pages would load blank."
      rm -f "$html" "$assets"; return 1
    fi
    count=$((count + 1))
  done < <(sort -u "$assets")
  rm -f "$html" "$assets"
  if (( count == 0 )); then
    fail "Smoke: the pages reference no /_next/static assets — cannot verify them."
    return 1
  fi

  code="$(http_code "$BASE_URL/api/health" /dev/null 10)"
  if [[ "$code" != "200" ]]; then
    fail "Smoke: /api/health answered ${code}."
    return 1
  fi

  if [[ "$SIMULATE" == "smoke" && "$expect" == "${NEW_ID:-}" ]]; then
    fail "DEPLOY_SIMULATE_FAILURE=smoke — the checks passed, failing the new build's smoke test on purpose."
    return 1
  fi
  ok "Smoke test passed: ${#SMOKE_PAGES[@]} pages with markers, ${count} static assets, /api/health — BUILD_ID ${expect}."
}

# activate <BUILD_ID> — make it current, restart, smoke test it.
activate() {
  swap_link "$CURRENT_LINK" "releases/$1"
  restart_service && smoke_test "$1"
}

# --- 0. guards -------------------------------------------------------------
if [[ -n "$SIMULATE" && "$SIMULATE" != "build" && "$SIMULATE" != "smoke" ]]; then
  fail "DEPLOY_SIMULATE_FAILURE must be 'build' or 'smoke' (got '${SIMULATE}')."
  exit 2
fi
if [[ -z "$TEST_RESTART_CMD" ]]; then
  UNIT_DIR="$("$SYSTEMCTL" show "$SERVICE" -p WorkingDirectory --value 2>/dev/null || true)"
  if [[ "$UNIT_DIR" != "$PROJECT_ROOT" ]]; then
    fail "${SERVICE} runs from '${UNIT_DIR:-?}', not from this checkout (${PROJECT_ROOT})."
    fail "Deploy from the production directory itself. Nothing was built or restarted."
    exit 1
  fi
fi
[[ -n "$SIMULATE" ]] && warn "Test hook active: DEPLOY_SIMULATE_FAILURE=${SIMULATE}"

mkdir -p "$RELEASES_DIR"
exec 9> "$DEPLOY_DIR/.lock"
if ! flock -n 9; then
  fail "Another deploy is running (lock: .deploy/.lock). Nothing was changed."
  exit 1
fi

# --- rollback mode ---------------------------------------------------------
if [[ "$MODE" == "rollback" ]]; then
  CUR_ID="$(release_of "$CURRENT_LINK")"
  PREV_ID="$(release_of "$PREVIOUS_LINK")"
  if [[ -z "$PREV_ID" || ! -f "$RELEASES_DIR/$PREV_ID/server.js" ]]; then
    fail "No previous build is kept (.deploy/previous). Nothing was changed."
    exit 1
  fi
  if [[ ! -L "$LIVE_PATH" ]]; then
    fail ".next/standalone is not the release link — run 'npm run deploy' once first. Nothing was changed."
    exit 1
  fi
  step "Rolling back: ${CUR_ID} → ${PREV_ID}…"
  if activate "$PREV_ID"; then
    swap_link "$PREVIOUS_LINK" "releases/$CUR_ID"
    ok "${BOLD}Rolled back — production serves ${PREV_ID}. Run 'npm run deploy:rollback' again to return to ${CUR_ID}.${RESET}"
    exit 0
  fi
  fail "${PREV_ID} failed its smoke test — returning to ${CUR_ID}…"
  if activate "$CUR_ID"; then
    fail "Rollback abandoned: production serves ${CUR_ID} again (unchanged)."
  else
    fail "${BOLD}${CUR_ID} failed its smoke test too — production may be down. Inspect: journalctl -u ${SERVICE} -n 100${RESET}"
  fi
  exit 1
fi

# --- pre-build guards ------------------------------------------------------
step "Running pre-build guards…"
if ! "$SCRIPT_DIR/check-no-public-proof.sh"; then
  fail "Deploy aborted by a pre-build guard — no build ran, the service was NOT touched."
  exit 1
fi
ok "No proof/scratch files under public/."

# --- 1. the live process must run from a release ---------------------------
step "Checking that the live process runs from a release…"
if [[ -L "$LIVE_PATH" ]]; then
  CURRENT_ID="$(release_of "$CURRENT_LINK")"
  if [[ -z "$CURRENT_ID" || ! -f "$RELEASES_DIR/$CURRENT_ID/server.js" ]]; then
    fail ".deploy/current does not name a complete release. Nothing was changed."
    exit 1
  fi
  ok "Live process runs from .deploy/releases/${CURRENT_ID}."
elif [[ -d "$LIVE_PATH" && ! -L "$CURRENT_LINK" ]]; then
  # The old layout: the process runs straight out of .next/standalone. Adopt
  # that build as the first release and restart onto it — the same build, so
  # nothing changes for users except one short restart, once.
  CURRENT_ID="$(cat "$LIVE_PATH/.next/BUILD_ID")"
  mv -T "$LIVE_PATH" "$RELEASES_DIR/$CURRENT_ID"
  swap_link "$CURRENT_LINK" "releases/$CURRENT_ID"
  swap_link "$LIVE_PATH" "$LIVE_TARGET"
  warn "One-time switch: .next/standalone moved to .deploy/releases/${CURRENT_ID}; restarting onto the SAME build…"
  if ! { restart_service && smoke_test "$CURRENT_ID"; }; then
    fail "The running build failed its smoke test after the switch — no build was started. Inspect: journalctl -u ${SERVICE} -n 50"
    exit 1
  fi
elif [[ -L "$CURRENT_LINK" ]]; then
  # .next/standalone is missing or a real directory: an earlier deploy died
  # mid-build, or someone ran `npm run build` on its own. Either way the process
  # may have been restarted onto it, so put the link back and restart onto the
  # current release before building.
  CURRENT_ID="$(release_of "$CURRENT_LINK")"
  warn ".next/standalone was not the release link — restoring it and restarting onto ${CURRENT_ID}…"
  restore_live_link
  if ! { restart_service && smoke_test "$CURRENT_ID"; }; then
    fail "${CURRENT_ID} failed its smoke test — no build was started. Inspect: journalctl -u ${SERVICE} -n 50"
    exit 1
  fi
else
  fail "No live build found: neither .next/standalone nor .deploy/current exists. Nothing was changed."
  exit 1
fi

# --- 2. build --------------------------------------------------------------
# Remove the link so the build can never write through it into the live
# release; any exit before step 3 puts it back.
rm -f "$LIVE_PATH"
trap restore_live_link EXIT

step "Building (npm run build) — production keeps serving ${CURRENT_ID}…"
if ! npm run build || [[ "$SIMULATE" == "build" ]]; then
  [[ "$SIMULATE" == "build" ]] && fail "DEPLOY_SIMULATE_FAILURE=build — treating the build as failed."
  fail "Build failed — production untouched: still serving ${CURRENT_ID} from .deploy/releases/${CURRENT_ID}."
  fail "If the errors mention modules that exist (e.g. a font module), clear a stale cache first: rm -rf .next/cache"
  exit 1
fi

NEW_ID="$(cat .next/BUILD_ID)"
STANDALONE_BUILD_ID="$(cat .next/standalone/.next/BUILD_ID 2>/dev/null || echo '<missing>')"
if [[ "$NEW_ID" != "$STANDALONE_BUILD_ID" || ! -f .next/standalone/server.js \
      || ! -d .next/standalone/.next/static || ! -d .next/standalone/public ]]; then
  fail "Incomplete build output (.next='${NEW_ID}', standalone='${STANDALONE_BUILD_ID}'). Production untouched: still serving ${CURRENT_ID}."
  exit 1
fi
if [[ "$NEW_ID" == "$CURRENT_ID" ]]; then
  fail "The new build has the live BUILD_ID (${NEW_ID}). Production untouched."
  exit 1
fi
ok "Build ${NEW_ID} succeeded."

# --- 3. promote ------------------------------------------------------------
step "Promoting ${NEW_ID}…"
rm -rf "${RELEASES_DIR:?}/$NEW_ID"
mv -T .next/standalone "$RELEASES_DIR/$NEW_ID"
swap_link "$LIVE_PATH" "$LIVE_TARGET"
trap - EXIT

# --- 4–6. restart, smoke test, automatic rollback ---------------------------
step "Restarting ${SERVICE} onto ${NEW_ID}…"
if ! activate "$NEW_ID"; then
  fail "${NEW_ID} failed — rolling back to ${CURRENT_ID}…"
  if activate "$CURRENT_ID"; then
    rm -rf "${RELEASES_DIR:?}/$NEW_ID"
    fail "${BOLD}Deploy failed and was rolled back: production serves ${CURRENT_ID} again. The failed build was removed.${RESET}"
  else
    fail "${BOLD}ROLLBACK FAILED TOO — production may be down. Inspect: journalctl -u ${SERVICE} -n 100${RESET}"
  fi
  exit 1
fi

# --- 7. keep exactly one previous release ----------------------------------
swap_link "$PREVIOUS_LINK" "releases/$CURRENT_ID"
for dir in "$RELEASES_DIR"/*/; do
  id="$(basename "$dir")"
  [[ "$id" == "$NEW_ID" || "$id" == "$CURRENT_ID" ]] || rm -rf "${RELEASES_DIR:?}/$id"
done
ok "Previous build ${CURRENT_ID} kept for 'npm run deploy:rollback'."

# --- 8. Playwright Chromium for the Bllink scraper -------------------------
# scripts/bllink-scrape.ts (billing-bllink-scrape.timer) runs Playwright from
# the repo's node_modules with PLAYWRIGHT_BROWSERS_PATH pinned to a project
# directory (gitignored). A version bump of `playwright` needs the matching
# Chromium build, so every deploy makes sure it is present. Idempotent and fast
# when nothing changed. Non-fatal: the web app is already live at this point and
# a CDN hiccup must not turn a good deploy into a failure — the scraper itself
# reports a missing browser as a 'login' stage error.
if [[ -z "$TEST_RESTART_CMD" ]]; then
  step "Ensuring Playwright Chromium for the Bllink scraper…"
  if PLAYWRIGHT_BROWSERS_PATH="$PROJECT_ROOT/.playwright-browsers" npx playwright install chromium; then
    ok "Playwright Chromium present in .playwright-browsers/."
  else
    warn "Playwright Chromium install failed — the web app is fine; re-run: PLAYWRIGHT_BROWSERS_PATH=$PROJECT_ROOT/.playwright-browsers npx playwright install chromium"
  fi
fi

# --- 9. summary ------------------------------------------------------------
echo
step "Deploy summary"
if [[ -z "$TEST_RESTART_CMD" ]]; then
  printf '  %-12s %s\n' "Service:" "${SERVICE} ${GREEN}active${RESET} (PID $("$SYSTEMCTL" show "$SERVICE" -p MainPID --value))"
fi
printf '  %-12s %s\n' "BUILD_ID:" "${NEW_ID}  (.deploy/current)"
printf '  %-12s %s\n' "Previous:" "${CURRENT_ID}  (npm run deploy:rollback)"
echo
ok "${BOLD}Deploy complete — production is serving ${NEW_ID}.${RESET}"
