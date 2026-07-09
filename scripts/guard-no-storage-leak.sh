#!/usr/bin/env bash
#
# scripts/guard-no-storage-leak.sh — fails the build if any code outside the
# storage chokepoint can hand the client a URL pointing at the storage host.
#
# WHY: a Supabase signed URL is a bearer token. Whoever holds the link opens the
# file — no session, no permission check, and the DB hostname is exposed. Files
# must be served only through /api/files/<bucket>/<path>, which re-checks the
# session and the module permission on every request.
#
# Runs as npm `prebuild`, so `npm run deploy` (→ npm run build) fails on a leak.
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"

# Forbidden anywhere under src/ except the allowlist below.
PATTERN='db\.bios\.co\.il|createSignedUrl|getPublicUrl|storage/v1/object|storage/v1'

# The ONLY files permitted to talk to Storage directly.
#   src/lib/storage/server.ts  — the chokepoint (StorageClient + the one sanctioned
#                                public URL, for Green API outbound media)
#   src/app/api/files/         — the authenticated proxy route
ALLOWLIST=(
  'src/lib/storage/server.ts'
  'src/app/api/files/'
)

is_allowed() {
  local file="$1"
  for allowed in "${ALLOWLIST[@]}"; do
    [[ "$file" == "$allowed"* ]] && return 0
  done
  return 1
}

violations=0
while IFS= read -r line; do
  file="${line%%:*}"
  is_allowed "$file" && continue
  if [[ $violations -eq 0 ]]; then
    echo "✗ STORAGE LEAK: storage URLs/clients are confined to the chokepoint." >&2
    echo "  Serve files through /api/files/<bucket>/<path> instead." >&2
    echo >&2
  fi
  echo "  $line" >&2
  violations=$((violations + 1))
done < <(grep -rnE "$PATTERN" src/ 2>/dev/null || true)

if [[ $violations -gt 0 ]]; then
  echo >&2
  echo "  $violations violation(s). Allowlisted: ${ALLOWLIST[*]}" >&2
  exit 1
fi

echo "✓ no storage leaks (allowlist: ${ALLOWLIST[*]})"
