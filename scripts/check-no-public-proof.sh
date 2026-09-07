#!/usr/bin/env bash
#
# scripts/check-no-public-proof.sh — pre-build deploy guard.
#
# Everything under public/ is copied into .next/standalone/public/ by the
# postbuild step and served verbatim at the site root. A screenshot dropped
# there is PUBLIC on the production domain, with no auth in front of it.
#
# On 07/09/2026 six chips verification screenshots reached production this way
# and were served live at /proof/chips-v3/*.png until they were removed.
#
# Proof screenshots, test output and scratch files belong in ref/proof/
# (gitignored) or outside the repo entirely — never under public/.
#
# Exits 1 BEFORE any build runs if public/proof/ holds a file. Run it on its
# own at any time; it touches nothing and needs no privileges.
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
GUARDED_REL="public/proof"
GUARDED_DIR="$PROJECT_ROOT/$GUARDED_REL"

if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; RED=$'\e[31m'; RESET=$'\e[0m'
else
  BOLD=''; RED=''; RESET=''
fi

# Absent directory is the normal, healthy state.
if [[ ! -d "$GUARDED_DIR" ]]; then
  exit 0
fi

# Files and symlinks at any depth. An empty directory ships nothing and git
# cannot track it, so it is not an offence.
OFFENDERS=()
while IFS= read -r line; do
  OFFENDERS+=("$line")
done < <(find "$GUARDED_DIR" \( -type f -o -type l \) -printf '%P\n' | sort)

if (( ${#OFFENDERS[@]} == 0 )); then
  exit 0
fi

{
  printf '%s\n' "${RED}✗ Deploy blocked: ${GUARDED_REL}/ contains ${#OFFENDERS[@]} file(s).${RESET}"
  printf '\n'
  printf '%s\n' "  Everything under public/ is served publicly at the site root, so these"
  printf '%s\n' "  would be reachable on the production domain under /proof/ with no auth:"
  printf '\n'
  for f in "${OFFENDERS[@]}"; do
    printf '%s\n' "    ${GUARDED_REL}/${f}"
  done
  printf '\n'
  printf '%s\n' "  ${BOLD}Move them to ref/proof/ (gitignored) or outside the repo, then re-run.${RESET}"
  printf '\n'
  printf '%s\n' "  If you delete them from a directory the running server already loaded,"
  printf '%s\n' "  also run: sudo systemctl restart billing.service"
  printf '%s\n' "  Next fixes the static file list at process start — without the restart a"
  printf '%s\n' "  deleted path answers 500 instead of 404."
  printf '\n'
  printf '%s\n' "  No build was started. The running service was not touched."
} >&2

exit 1
