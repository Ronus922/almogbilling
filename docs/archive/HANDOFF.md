# HANDOFF — פעולות שדורשות אותך (לפי סדר)

ערכי סודות לא מופיעים כאן — רק שמות משתנים. כל פעולה: למה, פקודות להדבקה, איפה שמים סוד, אימות.

---

## 1. Push לענף, PR, CI ירוק, branch protection

**למה:** הענף `infra/hardening` (8 commits) לא נדחף; ה-CI (`.github/workflows/ci.yml`, שני jobs)
רץ רק ב-GitHub.

```bash
cd /home/ubuntu/work/billing
git push -u origin infra/hardening
gh pr create --base main --head infra/hardening --title "infra: hardening (backup, monitoring, lint, dbmate, SafeQL, e2e, env, renovate)" --body-file REPORT.md
gh pr checks --watch
```

**אימות:** שני ה-checks — `check:all` ו-`e2e (Playwright + Mailpit)` — ירוקים.
אם `e2e` אדום: `gh run download -n playwright-report` ולפתוח `index.html`.

**branch protection על `main`:** Settings → Branches → Add rule → `main` → ✔ Require a pull
request before merging, ✔ Require status checks to pass: `check:all`, `e2e (Playwright + Mailpit)`,
✔ Require branches to be up to date. (או:)

```bash
gh api -X PUT repos/Ronus922/almogbilling/branches/main/protection \
  -f required_status_checks.strict=true \
  -f 'required_status_checks.contexts[]=check:all' \
  -f 'required_status_checks.contexts[]=e2e (Playwright + Mailpit)' \
  -F enforce_admins=false -F required_pull_request_reviews.required_approving_review_count=0 -F restrictions=
```

---

## 2. לפני merge+deploy: לוודא שמשתני הסביבה של הרנטיים קיימים

**למה:** מ-שלב 6 השירות **לא יעלה** בלי `DATABASE_URL`, `APP_URL`, `SETTINGS_ENC_KEY` (t3-env
ב-`src/instrumentation.ts`, exit 1 עם שמות המשתנים). `billing.service` קורא
`/etc/billing/billing.env`.

```bash
sudo grep -oE '^(DATABASE_URL|APP_URL|SETTINGS_ENC_KEY)=' /etc/billing/billing.env | sort
```

**אימות:** הפלט הוא בדיוק שלוש שורות: `APP_URL=`, `DATABASE_URL=`, `SETTINGS_ENC_KEY=`.
אם `APP_URL` חסר — להוסיף (`APP_URL=https://<הדומיין של המערכת>`) לפני ה-deploy.
אחרי merge: `cd /var/www/billing && git pull && npm ci && npm run deploy`, ואז
`journalctl -u billing.service -n 30 --no-pager` — אין `Invalid environment variables`.

---

## 3. גיבוי — restic, B2, healthcheck, systemd timer (שלב 0)

**למה:** הסקריפטים והיחידות בקוד; ההתקנה בשרת דורשת sudo וחשבון B2.

**3a. B2 bucket + app key** (backblaze.com → Buckets → Create Bucket, private, שם למשל
`almog-supabase-backup`; App Keys → Add a New Application Key מוגבל ל-bucket הזה).
לשמור: `keyID` → `B2_ACCOUNT_ID`, `applicationKey` → `B2_ACCOUNT_KEY`.

**3b. healthchecks.io** → New Check: שם `billing-backup`, Period **1 day**, Grace **26 hours**
→ להעתיק את ה-Ping URL → `HEALTHCHECK_BACKUP_URL`.

**3c. בשרת:**
```bash
cd /var/www/billing
sudo apt-get install -y restic
sudo mkdir -p /etc/billing /var/backups/supabase/daily
sudo install -m 600 deploy/systemd/backup.env.example /etc/billing/backup.env
sudo nano /etc/billing/backup.env
#   RESTIC_REPOSITORY=b2:<bucket-name>:supabase
#   RESTIC_PASSWORD=<סיסמה חדשה וארוכה — לשמור במנהל סיסמאות; בלעדיה אין שחזור>
#   B2_ACCOUNT_ID=…   B2_ACCOUNT_KEY=…
#   HEALTHCHECK_BACKUP_URL=https://hc-ping.com/…
sudo cp deploy/systemd/billing-backup.service deploy/systemd/billing-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now billing-backup.timer
sudo systemctl start billing-backup.service          # ריצה ראשונה עכשיו
```

**אימות:**
```bash
sudo journalctl -u billing-backup.service -n 30 --no-pager   # "done: proj_billing-… cluster-…" ואחריו restic "snapshots"
ls -la /var/backups/supabase/daily                           # שני קבצי .sql.gz חדשים
systemctl list-timers billing-backup.timer                   # NEXT = 03:00 הקרוב
sudo scripts/backup/pg-restore.sh /var/backups/supabase/daily/proj_billing-*.sql.gz   # מסתיים ב-RESTORE OK + count של public.debtors
```
ב-healthchecks.io ה-check ירוק. פרטים: `docs/backup.md`.

---

## 4. Sentry (שלב 1)

**למה:** הקוד מאתחל Sentry רק אם `SENTRY_DSN` קיים; בלי פרויקט ו-DSN אין דיווח שגיאות.

**4a.** sentry.io → Create Project → Platform **Next.js** → שם `billing` → להעתיק את ה-DSN.
Settings → Auth Tokens → Create (scopes: `project:releases`, `org:read`) → `SENTRY_AUTH_TOKEN`.
לרשום `SENTRY_ORG` (slug של הארגון) ו-`SENTRY_PROJECT` (`billing`).

**4b. בשרת — runtime (השירות + run-reminders):**
```bash
sudo nano /etc/billing/billing.env
#   SENTRY_DSN=https://…@….ingest.sentry.io/…
#   SENTRY_ENVIRONMENT=production
```
**4c. בשרת — build (הלקוח מקבל את ה-DSN בזמן build, sourcemaps):**
```bash
nano /var/www/billing/.env.local
#   SENTRY_DSN=<אותו DSN>
#   SENTRY_ENVIRONMENT=production
#   SENTRY_ORG=<slug>   SENTRY_PROJECT=billing   SENTRY_AUTH_TOKEN=<token>
cd /var/www/billing && npm run deploy
```

**אימות:**
```bash
cd /var/www/billing && set -a && source .env.local && set +a
node -e "const S=require('@sentry/nextjs');S.init({dsn:process.env.SENTRY_DSN});S.captureMessage('billing smoke '+new Date().toISOString());S.flush(3000).then(()=>console.log('sent'))"
```
תוך דקה מופיע Issue "billing smoke" ב-Sentry. בדפדפן על האתר: `window.Sentry?.captureMessage('client smoke')`
→ Issue נוסף (אם `window.Sentry` לא קיים — ה-DSN לא היה ב-`.env.local` בזמן ה-build).
פרטים: `docs/monitoring.md`.

---

## 5. healthchecks.io — reminders + uptime (שלב 1)

**למה:** `run-reminders.sh` שולח ping רק אם `HEALTHCHECK_REMINDERS_URL` מוגדר; uptime על
`/api/health` מגלה DB לא מגיב (503).

**5a.** New Check: `billing-reminders`, Period **5 minutes**, Grace **15 minutes** → Ping URL.
**5b.** (באותו חשבון, או ב-Better Stack/UptimeRobot) HTTP check על
`https://<host>/api/health`, כל 5 דק', מצפה ל-`200`.
**5c. בשרת:**
```bash
sudo nano /etc/billing/billing.env        # HEALTHCHECK_REMINDERS_URL=https://hc-ping.com/…
sudo systemctl restart billing-reminders.timer
```
**אימות:** אחרי ≤5 דק' ה-check `billing-reminders` מקבל ping (Last ping). לבדיקת `/fail`:
`sudo systemctl stop billing.service; sleep 360` → ה-check אדום מיד (הסקריפט פונה ל-`/fail`);
`sudo systemctl start billing.service`.

---

## 6. dbmate בפרודקשן — סימון ההיסטוריה כ-applied (שלב 3)

**למה:** `proj_billing` עדיין בלי `schema_migrations`. לפני שמסמנים 79 מיגרציות כ-applied
חובה להוכיח שהסכימה בפרודקשן זהה ל-`db/schema.sql`. **אם ה-diff לא ריק — לא מריצים כלום
ומחזירים לי את ה-diff.**

```bash
cd /var/www/billing && git pull
PG_CONTAINER=supabase-db PG_DB=proj_billing DATABASE_URL=postgresql://x@x/proj_billing \
  bash scripts/db/dump-schema.sh /tmp/prod-schema.sql
diff <(sed '/^-- Dbmate schema migrations/,$d' db/schema.sql) /tmp/prod-schema.sql && echo "SCHEMA IDENTICAL"
```

**רק אם הודפס `SCHEMA IDENTICAL`:**
```bash
docker exec -i supabase-db psql -U postgres -d proj_billing -v ON_ERROR_STOP=1 < scripts/db/mark-applied.sql
set -a && source .env.local && set +a
npx dbmate --url "$DIRECT_URL" --migrations-dir db/migrations --no-dump-schema status
```
**אימות:** `Applied: 79` / `Pending: 0`. מעכשיו מיגרציה חדשה = `npm run db:new` → `db:up`
(`docs/migrations.md`). אם ה-diff לא ריק: `diff … > /tmp/prod-schema.diff` ולשלוח לי.

---

## 7. Renovate (שלב 7)

**למה:** `renovate.json` בקוד; ה-bot צריך גישה ל-repo.

github.com/apps/renovate → Install → Only select repositories → `Ronus922/almogbilling`.
בנוסף (ל-`vulnerabilityAlerts`): repo → Settings → Code security → Dependabot alerts **On**.

**אימות:** תוך שעה נפתח PR "Configure Renovate" (onboarding) — ל-merge אותו. בסוף השבוע
הראשון: PR `non-major dependencies` ו-PR `devDependencies (patch)` (האחרון עם automerge).

---

## 8. פגיעויות npm (23 נכון ל-05/09/2026, אחרי `next@16.3.4`) — השאר לא תוקן בכוונה

**מה כבר נסגר (בענף הזה, `f15ad65`):** `next@16.3.4` + `eslint-config-next@16.3.4` — ה-critical של production
(RCE ב-Image Optimization, [GHSA-2xp9-vwfh-vxw4](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4),
`<16.3.3`, ש-npm audit עדיין לא מציג) + 9 advisories ישירים של next + `sharp`/`postcss`/`nanoid`. build,
`check:all`, e2e 4/4 ו-CI ירוקים. **הפרודקשן נשאר על 16.2.9 עד merge + `npm run deploy`** — ואז smoke:
`/api/health`, login, PDF של דייר.

**מה נשאר ב-production (18, 0 critical):** `nodemailer` (high, שדרוג **major** 8→9.1.1 מומלץ, בלי נגיעה בקוד),
`puppeteer-core` (high, major, **רק אחרי** Node 22 בשרת וב-CI), `exceljs` (moderate, אין גרסה מתוקנת — `overrides`
ל-uuid), ו-15 טרנזיטיביות שרובן (12) נסגרות ב-`npm audit fix`. ה-critical היחיד שנותר ב-audit הוא `vitest@2`
(dev בלבד, לא ב-runtime).

**ממצאים מפורטים** — production מול dev, גרסה מתוקנת, patch/minor/major ו-breaking changes לכל תלות ישירה:
`docs/AUDIT.md`. סדר ההמשך שם: `nodemailer@9.1.1` → `npm audit fix` → `vitest@4` → `uuid` override תחת exceljs →
`puppeteer-core@25` **רק אחרי** Node 22 בשרת וב-CI.

```bash
cd /var/www/billing && npm audit
npm audit fix            # בלי --force; ואז npm run check:all
```
שדרוגי major (nodemailer 8→9, vitest 2→4, puppeteer-core 24→25) — דרך PR-ים של Renovate
או ידנית אחד-אחד עם `check:all` + e2e.

---

## 9. ~~אופציונלי — לקצר את pre-push~~ — בוצע (05/09/2026, בענף הזה)

`.husky/pre-push` מריץ עכשיו `npm run typecheck && SAFEQL=0 npm run lint && npm test` בלבד (~1 דק');
בדיקות ה-DB (`check:money/phone/session/dupes/wa`) ו-SafeQL נשארו ב-CI. פירוט: `TESTING.md` → "מה רץ איפה".
(`HUSKY=0 git push` עדיין מדלג פעם אחת.)
