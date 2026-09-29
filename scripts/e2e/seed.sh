#!/usr/bin/env bash
# Apply db/seed/e2e.sql to DATABASE_URL (env, else .env.local). Test DBs only.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if [[ -z "${DATABASE_URL:-}" && -f .env.local ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2- | tr -d "\"'")"
fi
[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL not set" >&2; exit 1; }
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f db/seed/e2e.sql
# The WhatsApp instance the portal's login code goes through. Separate from the
# SQL because its token is an encrypted blob — see the script's header.
DATABASE_URL="$DATABASE_URL" node scripts/e2e/seed-whatsapp-instance.mjs
echo "e2e seed applied"
