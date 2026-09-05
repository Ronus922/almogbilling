# גיבוי ושחזור — Postgres (supabase-db)

ה-DB של billing (`proj_billing`) יושב בקונטיינר ה-Supabase המשותף `supabase-db`
(`supabase/postgres:15.8.1.085`) לצד פרויקטים אחרים. לכן הגיבוי הלילי מכסה
**את כל ה-cluster** ובנפרד את `proj_billing` לשחזור מהיר.

| קובץ | תפקיד |
|---|---|
| `scripts/backup/pg-backup.sh` | שני dumps דרך `docker exec supabase-db`: `cluster-<stamp>.sql.gz` (`pg_dumpall`) + `proj_billing-<stamp>.sql.gz` (`pg_dump`). gzip, כתיבה ל-`.part` ואז rename אטומי, בדיקת `gzip -t` וגודל מינימלי, שמירת 7 ימים, ping ל-`$HEALTHCHECK_BACKUP_URL` (ו-`/fail` בכישלון). |
| `scripts/backup/restic-push.sh` | `restic backup` של תיקיית הגיבויים ל-`$RESTIC_REPOSITORY` (B2) ואז `forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune`. ללא `RESTIC_REPOSITORY` — מדלג (exit 0) ומדפיס הודעה. |
| `scripts/backup/pg-restore.sh <file>` | מרים Postgres זמני (אותו image), משחזר לתוכו ומדפיס `count(*)` מטבלאות אימות. הקונטיינר נמחק בסיום (`--keep` משאיר אותו). |
| `deploy/systemd/billing-backup.service` + `.timer` | הרצה יומית ב-03:00 (`Persistent=true`), `EnvironmentFile=-/etc/billing/backup.env`. |
| `deploy/systemd/backup.env.example` | שמות המשתנים ל-`/etc/billing/backup.env`. |

ברירות מחדל (ניתנות לדריסה ב-env): `PG_CONTAINER=supabase-db`, `PG_USER=postgres`,
`BILLING_DB=proj_billing`, `BACKUP_DIR=/var/backups/supabase/daily`, `RETENTION_DAYS=7`.

## התקנה על השרת

```bash
cd /var/www/billing
sudo apt-get install -y restic                       # פעם אחת
sudo mkdir -p /etc/billing /var/backups/supabase/daily
sudo install -m 600 deploy/systemd/backup.env.example /etc/billing/backup.env
sudo nano /etc/billing/backup.env                    # RESTIC_*, B2_*, HEALTHCHECK_BACKUP_URL
sudo cp deploy/systemd/billing-backup.service deploy/systemd/billing-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now billing-backup.timer
```

הרצה ראשונה ידנית, כדי לא לחכות ל-03:00:

```bash
sudo systemctl start billing-backup.service
sudo journalctl -u billing-backup.service -n 40 --no-pager
ls -la /var/backups/supabase/daily
```

## איך בודקים שהגיבוי רץ

1. **systemd** — `systemctl list-timers billing-backup.timer` מראה `NEXT`/`LAST`;
   `systemctl status billing-backup.service` צריך להיות `inactive (dead)` עם
   `status=0/SUCCESS` בריצה האחרונה.
2. **קבצים** — ב-`/var/backups/supabase/daily` יש זוג קבצים חדש כל יום, ולא יותר
   מ-8 ימים אחורה.
3. **healthchecks.io** — ה-check של הגיבוי (grace 26 שעות, ראה `docs/monitoring.md`)
   מקבל ping בכל סיום מוצלח. אין ping → התראה.
4. **off-site** — `sudo -E restic snapshots` (עם ה-env של `/etc/billing/backup.env`)
   מראה snapshot חדש בכל יום.

## איך משחזרים

### הוכחת שחזור (בלי לגעת בפרודקשן)

```bash
sudo scripts/backup/pg-restore.sh /var/backups/supabase/daily/proj_billing-<stamp>.sql.gz
```

הפלט מסתיים ב-`RESTORE OK` ובספירות של `public.debtors`, `public.users`,
`public.app_settings`. להשוואה מול הפרודקשן:

```bash
docker exec supabase-db psql -U postgres -d proj_billing -tAc "select count(*) from public.debtors"
```

מומלץ להריץ את ההוכחה הזו פעם בחודש. גם קובץ `cluster-*.sql.gz` ניתן להעביר
ל-`pg-restore.sh` (הוא מזהה לפי השם ומשחזר את כל ה-cluster לקונטיינר הזמני;
שגיאות "already exists"/"reserved role" על roles ש-image ה-Supabase כבר מכיל הן
צפויות ומסוננות).

### שחזור אמיתי של proj_billing

1. עצור את האפליקציה: `sudo systemctl stop billing.service billing-reminders.timer`.
2. שחזר לתוך DB חדש כדי לא לדרוס את הקיים לפני שאימתת:
   ```bash
   docker exec supabase-db psql -U postgres -c 'create database proj_billing_restore'
   gunzip -c /var/backups/supabase/daily/proj_billing-<stamp>.sql.gz \
     | docker exec -i supabase-db psql -U postgres -d proj_billing_restore -v ON_ERROR_STOP=1
   docker exec supabase-db psql -U postgres -d proj_billing_restore -tAc "select count(*) from public.debtors"
   ```
3. אם הספירות נכונות — החלפת שמות (מחייבת שאין חיבורים פתוחים ל-`proj_billing`):
   ```bash
   docker exec supabase-db psql -U postgres -c "alter database proj_billing rename to proj_billing_broken_$(date +%Y%m%d)"
   docker exec supabase-db psql -U postgres -c 'alter database proj_billing_restore rename to proj_billing'
   ```
4. `sudo systemctl start billing.service billing-reminders.timer` ו-`curl -s https://<host>/api/health`.

### שחזור מ-B2 (השרת אבד)

```bash
set -a; source /etc/billing/backup.env; set +a
restic snapshots
restic restore latest --target /var/backups/restore
# ואז pg-restore.sh על הקובץ שנחלץ, או השחזור האמיתי למעלה.
```

## בדיקה מקומית (מה שהורץ בפיתוח)

```bash
PG_CONTAINER=billing-loop-db BILLING_DB=billing BACKUP_DIR=/tmp/bk scripts/backup/pg-backup.sh
RESTORE_PORT=55440 scripts/backup/pg-restore.sh /tmp/bk/billing-<stamp>.sql.gz   # → RESTORE OK
```
