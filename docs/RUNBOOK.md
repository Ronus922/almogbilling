# RUNBOOK — almogbilling (ALMOG Billing)

נוהל תגובה לתקלה. שמות משתנים ושמות שירותים בלבד, בלי ערכי סודות.
שדה שעוד לא ידוע כתוב "טרם הוגדר".
הריפו ציבורי, ולכן אין כאן נתיבי שרת וכתובות פנימיות. הם בקובץ ה-env של השרת,
ביחידות ה-systemd וב-`ALMOG_BILLING_BRIEF.md` (קובץ מקומי, מחוץ לגיט), לא בגיט.

## זהות

- דומיין: <https://almog-haifa.co.il>. Cloudflare proxy לפני nginx (SSL Full).
- דומיין ישן: `billing.bios.co.il` מחזיר 301 לדומיין החדש בכל נתיב, חוץ מ-`/api/health`
  ו-`/api/webhooks/greenapi`, שנשארו proxy. ה-webhook של Green API רשום על הכתובת הישנה,
  ו-301 על POST היה שובר אותו בשקט.
- תיקייה בשרת: לא מתועדת כאן (ריפו ציבורי).
- תהליכים (systemd, לא pm2):
  - `billing.service`: שרת ה-Next (standalone), `Restart=always`. רץ מ-`.deploy/current`
    (ראה "פריסה"). מאזין על loopback בלבד, ו-nginx הוא היחיד שחשוף החוצה.
  - `wa-queue-worker.service`: worker התפוצות (WhatsApp ומייל), `Restart=always`. רץ
    מהקוד ומ-`node_modules` של עץ העבודה (tsx), לא מה-release, ולכן `npm run deploy`
    לא מפעיל אותו מחדש.
  - טיימרים (שעון השרת UTC). גם הם מריצים את עץ העבודה: החלפת ענף בתיקיית הפרודקשן
    משנה את מה שהם מריצים, בלי deploy.

    | טיימר | מתי | מה |
    |---|---|---|
    | `billing-reminders.timer` | כל 5 דקות | מנוע התזכורות |
    | `billing-bllink-scrape.timer` | 05:30 שעון ישראל | סריקת דוח החובות מבלינק |
    | `billing-sync.timer` | 06:00 שעון ישראל | סנכרון חייבים מבלינק + reconcile |
    | `billing-backup.timer` | 03:00 UTC (עם השהיה אקראית) | גיבוי, ראה "גיבויים" |
    | `billing-storage-cleanup.timer` | 04:30 UTC | GC ל-Storage, במצב dry run |

  - `billing-alert@.service`: התרעת כשל, קודם מייל ואז WhatsApp. מופעלת רק דרך
    `OnFailure=` של `billing-backup`, `billing-bllink-scrape`, `billing-sync`
    ו-`billing-storage-cleanup`. ל-`billing.service`, ל-`wa-queue-worker` ול-`billing-reminders`
    אין `OnFailure=`; את האפליקציה מכסה UptimeRobot.
  - קובצי היחידות שבגיט: `deploy/systemd/`. `billing.service`, `wa-queue-worker.service`
    ו-`billing-reminders.*` מותקנים בשרת בלבד.
- קובץ env בשרת: לא מתועד כאן (ריפו ציבורי). `billing.service` ו-`wa-queue-worker`
  קוראים אותו דרך `EnvironmentFile`. שמות המשתנים: `.env.example`; הוולידציה בעלייה:
  `src/env.ts`. משתני הגיבוי בקובץ נפרד, שמותיהם ב-`deploy/systemd/backup.env.example`.
- DB: PostgreSQL ב-Supabase self-hosted, בקונטיינר `supabase-db` המשותף לפרויקטים
  אחרים, מסד `proj_billing`. `DATABASE_URL` הוא ה-transaction pooler; `DIRECT_URL` הוא
  חיבור session, ונדרש ל-advisory locks, ל-LISTEN/NOTIFY ול-dbmate.
- מיגרציות: dbmate. מצב: `npm run db:status` (בפרודקשן: 0 pending). מיגרציה חדשה:
  `npm run db:new <name>` בענף + PR, ואחרי ה-merge `npm run db:up`. פירוט: `docs/migrations.md`.

## ניטור

- Health: <https://almog-haifa.co.il/api/health>
  - `200 {"status":"ok",...}`: האפליקציה עונה, ו-`SELECT 1` מול ה-DB עבר.
  - `503 {"status":"error","message":"DB unreachable"}`: ה-DB לא ענה תוך 5 שניות.
  - `502` / `504` מ-nginx: התהליך למטה או תקוע.
  - `521` / `522` מ-Cloudflare: השרת או nginx לא עונים.
  - ציבורי, בלי session. אין בתשובה שדה build; את ה-BUILD_ID בודקת בדיקת העשן של הפריסה.
- UptimeRobot: מוניטור HTTP(s) על כתובת ה-health, כל 5 דקות (אומת בלוג nginx,
  07/10/2026). שם המוניטור בדשבורד: טרם תועד. כתובת ה-health של הדומיין הישן עדיין
  עונה 200, אבל לא מנוטרת.
- Sentry: ארגון `bios-s2`, צד שרת בלבד. בדפדפן כבוי, כי ה-DSN של הדפדפן נקבע בזמן build
  ולא קיים שם.
  - ה-DSN נקרא בזמן ריצה מ-`SENTRY_DSN` בקובץ ה-env של השרת. restart ל-`billing.service`
    מפעיל או מכבה, בלי build.
  - שורה אחת בכל עלייה: `journalctl -u billing.service -n 200 --no-pager | grep Sentry`
    מציגה `Sentry initialized` או `Sentry disabled (no DSN)`.
  - slug הפרויקט: טרם תועד בריפו. מאמתים ב-sentry.io → `bios-s2` → Projects.
  - Sentry MCP (טרם חובר): `claude mcp add --transport http sentry https://mcp.sentry.dev/mcp/bios-s2/<slug>`
    ואז `/mcp` ו-Authenticate (OAuth של רונן).
  - פירוט החיווט: `docs/monitoring.md`.
- healthchecks.io: ping בסיום כל גיבוי (`HEALTHCHECK_BACKUP_URL`, פעיל), ו-`/fail` בכישלון.
  ping התזכורות (`HEALTHCHECK_REMINDERS_URL`): לא מוגדר.
- התרעות כשל של יחידות: `billing-alert@.service` (למעלה). רינדור התרעה בלי שליחה:
  `npx tsx scripts/alert-unit-failure.ts <unit> --print`.

## תגובה לקריסה

1. `curl -s -o /dev/null -w '%{http_code}\n' https://almog-haifa.co.il/api/health` ובדיקת
   UptimeRobot, כדי להבחין בין אפליקציה, DB ורשת (מפת הקודים בסעיף "ניטור").
2. `systemctl status billing.service wa-queue-worker.service --no-pager`, ואז 50 שורות
   לוג אחרונות: `journalctl -u billing.service -n 50 --no-pager` (באותו אופן ל-`wa-queue-worker.service`
   או ליחידת הטיימר שנכשלה). ל-DB: `docker ps --filter name=supabase-db`.
3. Sentry: יש אירוע חדש שמסביר את התקלה? אם Sentry MCP מחובר, שואלים דרכו.
4. פריסה אחרונה חשודה: לפי "Rollback" למטה.
5. DB פגוע: שחזור לפי `docs/backup.md`, **קודם לקונטיינר בדיקה**
   (`scripts/backup/pg-restore.sh`). שחזור על פרוד רק עם גיבוי טרי ואישור מפורש של רונן.
6. כל פעולה שמשנה מצב מדווחת לרונן לפני ביצוע. עצירת תהליך: `sudo systemctl stop <unit>`
   או `kill <PID>`. לעולם לא `pkill -f` או `killall`, כי על השרת רצים תהליכי production
   של פרויקטים אחרים.

### תקלות מוכרות

- `502` לשנייה אחת בכל restart: צפוי. עד ~90 שניות כשחיבור SSE פתוח מחזיק את התהליך הישן.
- מיילים לא יוצאים, ובלוג `535`: ה-App Password של Gmail פג. זה קורה מדי כמה חודשים,
  בלי שום התרעה. רק רונן מנפיק חדש. הסיסמה שמורה בשני מקומות: מסך הגדרות ה-SMTP
  באפליקציה (מוצפנת ב-DB, המקור המועדף) ו-`SMTP_PASS` בקובץ ה-env כגיבוי.
- שינוי בקוד התור או ה-worker נפרס ולא פועל: `wa-queue-worker` לא הופעל מחדש.
- נתיב שנמחק מ-`public/` מחזיר `500` ולא `404`: חסר restart אחרי המחיקה.

## Rollback

`main` מוגן (ruleset בלי bypass, גם למנהלים): אין push ישיר, ואין `git reset --hard` על פרוד.

**המסלול הקנוני: revert דרך PR.**

1. `git checkout main && git pull && git checkout -b revert/<topic>`
2. `git revert -m 1 <merge-commit>` (לקומיט רגיל: `git revert <commit>`).
3. push לענף → `gh pr create --base main` → CI ירוק (`check:all` ו-`e2e (Playwright + Mailpit)`)
   → merge באישור רונן: `gh pr merge <n> --merge`.
4. בתיקיית הפרודקשן: `git checkout main && git pull`. אם `package-lock.json` השתנה: `npm ci`.
5. `npm run deploy`. אם ה-revert נוגע בקוד התור או ה-worker, או שה-lockfile השתנה:
   `sudo systemctl restart wa-queue-worker.service`.

**המסלול המיידי, כשאי אפשר לחכות ל-CI:** `npm run deploy:rollback`. מחזיר את ה-build
הקודם (רק אחד נשמר, ב-`.deploy/previous`; הרצה נוספת מחזירה קדימה). מחליף רק את הקוד
של `billing.service`. ה-worker וסקריפטי הטיימרים רצים מעץ העבודה, ולהם המסלול הוא ה-revert.
מיד אחריו פותחים את ה-revert PR: פריסה הבאה מ-`main` בלעדיו מחזירה את הבאג.

**מיגרציות:** אף rollback לא מחזיר מיגרציה. תיקון סכמה = מיגרציה חדשה (additive) דרך PR.
`npm run db:rollback` על פרוד רק עם גיבוי טרי ואישור מפורש של רונן.

## פריסה

- פקודה, בתיקיית הפרודקשן, מ-`main` מעודכן: `git checkout main && git pull` → `npm ci`
  אם ה-lockfile השתנה → מיגרציות ממתינות: `npm run db:status` ואז `npm run db:up` →
  `npm run deploy`.
- פריסת חירום מענף אפשרית (`scripts/deploy.sh` לא אוכף ענף), וה-merge ל-`main` מגיע באותו
  יום. אחרת הפריסה הבאה מ-`main` מגלגלת את התיקון אחורה.
- מה הסקריפט עושה: build ב-`.next/` בזמן שהאתר ממשיך לרוץ מה-release הנוכחי → רק build
  מוצלח מקודם (`.deploy/current`, החלפת symlink אטומית) → restart ל-`billing.service` →
  בדיקת עשן → כשל = חזרה אוטומטית ל-build הקודם. build שנכשל לא נוגע באתר.
- אימות, בתוך הסקריפט: `/login` ו-`/portal/login` עונים 200 עם סמן קבוע ועם ה-BUILD_ID
  החדש; כל קובץ `/_next/static` שהם מפנים אליו עונה 200; `/api/health` עונה 200.
- ה-BUILD_ID החי: `cat .deploy/current/.next/BUILD_ID`. לא `.next/BUILD_ID`: שם נשאר גם
  build שנדחה.
- אחרי הפריסה: `sudo systemctl restart wa-queue-worker.service` כשהשתנו קוד התור, קוד
  ה-worker או ה-lockfile. סטטוס: `systemctl is-active billing.service wa-queue-worker.service`.
- אסור `npm run build` לבד בתיקיית הפרודקשן: הוא מניח ב-`.next/standalone` build שלא נבדק,
  וה-restart הבא יעלה אותו. בדיקת build של ענף: ב-worktree נפרד.

## גיבויים

- `billing-backup.timer`, יומי 03:00 UTC:
  - `pg_dumpall` של כל ה-cluster של `supabase-db` + `pg_dump` של `proj_billing`, עם עותק
    מקומי ל-7 ימים.
  - restic לדלי B2 ייעודי (השם ב-`RESTIC_REPOSITORY`, בקובץ ה-env של הגיבוי): snapshot של
    ה-dumps (tag `supabase-daily`) ו-snapshot של קבצי ה-Storage (tag `storage`). שמירה
    7d/4w/6m לכל קבוצת host+paths.
  - `OnFailure=` → `billing-alert@` (מייל + WhatsApp), ו-ping ל-healthchecks.io בכל סיום.
- **פרויקטים אחרים תלויים בגיבוי הזה:** ה-dump של ה-cluster וה-snapshot של ה-Storage
  מכסים את כל ה-Supabase המשותף, ופרויקטים אחרים על השרת (למשל invoice-vps) נשענים
  עליהם. שינוי או השבתה כאן מפסיקים גם את הגיבוי שלהם.
- דריל: תרגיל שחזור אוטומטי טרם הוגדר ל-billing. הוכחת שחזור ידנית, בלי לגעת בפרודקשן:
  `sudo scripts/backup/pg-restore.sh <dump>` מרים Postgres זמני, משחזר לתוכו ומסתיים
  ב-`RESTORE OK` עם ספירות טבלאות; משווים מול הפרוד. מומלץ פעם בחודש. שחזור מ-B2 ושחזור
  אמיתי: `docs/backup.md`.
- משמורת מפתחות: ארכיון הסודות המוצפן (age) נשמר מחוץ לשרת, ומפתח ה-age לא נשמר בשרת.
  `RESTIC_PASSWORD`: לפי תבנית ההקשחה, עותק במנהל הסיסמאות של רונן. את זה אי אפשר לאמת
  מתוך הריפו.
