#!/usr/bin/env bash
set -euo pipefail

# צבעים לפלט
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

cd /var/www/billing

echo -e "${GREEN}━━━ ALMOG CRM Deploy ━━━${NC}"

# שלב 1 — Safety check: uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo -e "${YELLOW}⚠️  יש שינויים שלא בוצע עליהם commit:${NC}"
  git status --short
  read -p "להמשיך deploy על הקוד הקיים? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Deploy בוטל${NC}"
    exit 1
  fi
fi

# שלב 2 — Build
echo -e "${GREEN}→ Building...${NC}"
npm run build

# שלב 3 — Migrations (אם יש)
if [ -f "scripts/run-migrations.ts" ]; then
  echo -e "${GREEN}→ Running migrations...${NC}"
  npx tsx scripts/run-migrations.ts
fi

# שלב 4 — Restart
echo -e "${GREEN}→ Restarting service...${NC}"
sudo systemctl restart billing.service

# שלב 5 — Wait + healthcheck
echo -e "${GREEN}→ Waiting for service...${NC}"
sleep 3

for i in {1..10}; do
  if curl -fsS https://billing.bios.co.il/api/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Service healthy${NC}"
    sudo systemctl status billing.service --no-pager -l | head -5
    exit 0
  fi
  echo "  attempt $i/10..."
  sleep 2
done

echo -e "${RED}✗ Healthcheck failed after 20s${NC}"
sudo systemctl status billing.service --no-pager -l | head -20
exit 1
