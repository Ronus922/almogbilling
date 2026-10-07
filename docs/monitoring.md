# ניטור — Sentry, healthchecks.io, /api/health

## מה יש בקוד

| רכיב | קובץ | התנהגות |
|---|---|---|
| Logger יחיד | `src/lib/logger.ts` | pino. `logger.error(err, msg)` → `Sentry.captureException`; `logger.error('msg')` → `Sentry.captureMessage`. לעולם לא זורק. |
| Sentry server | `sentry.server.config.ts` ← `src/instrumentation.ts` | `init` **רק אם `SENTRY_DSN` מוגדר**; אחרת שום דבר לא מאותחל ולא נשלח. **ה-DSN נקרא בזמן ריצה** (`sentryRuntimeOptions(process.env)` ב-`src/lib/sentry-options.ts`) — `restart` מפעיל או מכבה, בלי build. שורה אחת ב-journal בכל עלייה: `Sentry initialized` (עם `environment` ו-`tracesSampleRate`) או `Sentry disabled (no DSN)`; ה-DSN עצמו לא נרשם. `onRequestError` תופס שגיאות RSC/route לפני הקוד שלנו. |
| Sentry edge | `sentry.edge.config.ts` | אותו כלל ואותה קריאה בזמן ריצה, ל-`src/middleware.ts` (ה-sandbox של ה-edge מקבל את `process.env` החי). בלי שורת לוג — pino לא רץ ב-edge. |
| Sentry client | `src/instrumentation-client.ts` | לדפדפן אין `process.env`, ולכן ה-DSN שלו **נקבע בזמן build**: `env` ב-`next.config.ts` מטמיע את `SENTRY_DSN` של סביבת ה-build בשם נפרד, `SENTRY_CLIENT_DSN` (ו-`SENTRY_CLIENT_ENVIRONMENT`), כדי שלא יגיע עותק build-time לקוד השרת. בפרודקשן ה-DSN לא קיים בזמן build, ולכן **Sentry בדפדפן כבוי**. `onRouterTransitionStart` לניווטים. |
| שומר build | `scripts/check-sentry-build.mjs` (`npm run check:sentry-build`) | ב-CI, אחרי ה-build בלי DSN: שתי שורות הלוג חייבות להופיע בפלט השרת המהודר. אם ה-DSN ייאפה שוב ב-build, התנאי יקופל לקבוע ושורת `Sentry initialized` תיעלם — והבדיקה נכשלת. אחרי deploy: `node scripts/check-sentry-build.mjs .deploy/current/.next/server`. |
| Error boundary שורש | `src/app/global-error.tsx` | שגיאת render שברחה מכל דף → `captureException` + מסך "משהו השתבש" (RTL). |
| Sourcemaps | `withSentryConfig` ב-`next.config.ts` | מעלה sourcemaps ב-build **רק** כש-`SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` קיימים בסביבת ה-build. בלעדיהם — build רגיל. |
| Health | `GET /api/health` | `200 {status:'ok'}` רק אם `SELECT 1` מול ה-DB עובר; אחרת `503`. ציבורי (בלי session) — מתועד ב-`check:auth`. |
| תזכורות | `scripts/run-reminders.sh` | אחרי ריצה מוצלחת `curl $HEALTHCHECK_REMINDERS_URL`; בכישלון `…/fail`. |
| גיבוי | `scripts/backup/pg-backup.sh` | `curl $HEALTHCHECK_BACKUP_URL` בסיום, `…/fail` בשגיאה. |
| דחיפה ל-B2 | `scripts/backup/restic-push.sh` | `…/fail` בכישלון — בלי זה ה-ping הירוק של ה-dumps היה משאיר את ה-check ירוק בזמן ששום דבר לא עלה החוצה. |
| כישלון יחידת systemd | `deploy/systemd/billing-alert@.service` → `scripts/alert-unit-failure.ts` | `OnFailure=billing-alert@%n.service` על `billing-backup.service` ועל `billing-storage-cleanup.service`. **שני ערוצים בלתי-תלויים, קודם מייל ואז WhatsApp:** מייל ל-`ADMIN_ALERT_EMAIL` דרך חשבון ה-SMTP של האפליקציה עצמה (`scripts/lib/admin-email.ts`, אותו nodemailer, 30 שורות יומן), ו-WhatsApp ל-`ADMIN_ALERT_PHONE` (נופל חזרה ל-`BLLINK_ALERT_PHONE`) דרך ה-instance של billing (שורת יומן אחת). **נוסח ההודעה** נבנה ב-`scripts/lib/unit-failure.ts` (טהור, 24 בדיקות): כותרת בעברית בלי שם יחידה, מה קרה, כמה זה דחוף, פעולה אחת — ורק אז, מתחת לקו, שם היחידה, זמן ב**שעון ישראל** וקוד היציאה. `ALERT_TEST_MODE=1` מסמן הודעת בדיקה. כשל בערוץ אחד לא עוצר את השני; יציאה 1 רק אם **שניהם** נכשלו, כך שה-journal מראה שאיש לא קיבל הודעה. תופס גם מה שהסקריפט לא יכול לדווח בעצמו: `ExecStartPre` שסירב, `TimeoutStartSec`, OOM kill. |
| התראת סורק בלינק | `scripts/bllink-scrape.ts` | אותו מנגנון, דרך `scripts/lib/admin-alert.ts`. |

משתני סביבה (כולם אופציונליים, ריק = כבוי): `SENTRY_DSN`, `SENTRY_ENVIRONMENT`
(ברירת מחדל `NODE_ENV`), `SENTRY_TRACES_SAMPLE_RATE` (0.1), `SENTRY_ORG`,
`SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` (build בלבד), `LOG_LEVEL` (info בפרודקשן,
debug בפיתוח), `HEALTHCHECK_REMINDERS_URL`, `HEALTHCHECK_BACKUP_URL`.

**איפה שמים אותם על השרת:** `SENTRY_DSN` (ו-`SENTRY_ENVIRONMENT` /
`SENTRY_TRACES_SAMPLE_RATE` אם צריך) — **רק** ב-`/etc/billing/billing.env`, מקור
אמת אחד. משם `billing.service` קורא אותם בכל עלייה, ו-`sudo systemctl restart
billing.service` מספיק כדי להפעיל או לכבות (מ-07/10/2026; קודם ה-DSN נאפה ב-build,
ו-build בלעדיו הסיר את בלוק ה-init). **לא** ב-`.env.local`: שם הוא היה מגיע רק
לדפדפן בזמן build, וזו החלטה נפרדת. `SENTRY_AUTH_TOKEN`/`ORG`/`PROJECT` — רק ב-
`.env.local` (build). `HEALTHCHECK_REMINDERS_URL` — ב-`/etc/billing/billing.env`.
`HEALTHCHECK_BACKUP_URL` — ב-`/etc/billing/backup.env`.

## healthchecks.io — אילו checks להגדיר

| Check | סוג | Period | Grace | למה |
|---|---|---|---|---|
| `billing-reminders` | ping מ-`run-reminders.sh` | 5 דקות | **15 דקות** | הטיימר רץ כל 5 דק'; 3 החמצות רצופות = בעיה אמיתית ולא רעש של deploy. |
| `billing-backup` | ping מ-`pg-backup.sh` | יום (`03:00`) | **26 שעות** | מכסה `RandomizedDelaySec=10min` + זמן dump ארוך; יום שלם בלי גיבוי = התראה. |
| `billing-health` | **HTTP uptime** על `https://<host>/api/health` | 5 דקות (או המינימום בתוכנית) | 5 דקות | בודק את השרשרת המלאה: nginx → Next → Postgres. `503` = ה-DB לא מגיב. |

ל-`/fail` יש משמעות: `run-reminders.sh` ו-`pg-backup.sh` פונים אליו בכישלון, אז
ה-check הופך אדום מיד ולא מחכה ל-grace.

## איך מוודאים ש-Sentry מקבל אירועים

1. אחרי שינוי `SENTRY_DSN` ב-`/etc/billing/billing.env` ו-`sudo systemctl restart
   billing.service`: `journalctl -u billing.service --since -2min | grep Sentry` —
   `Sentry initialized` (או `Sentry disabled (no DSN)` כשהוא ריק). זה כל האימות
   שצריך מצד השירות; אין צורך ב-deploy.
2. **שרת, אירוע אמיתי:** סקריפט Node חד-פעמי ב-scratchpad שטוען את `@sentry/node`
   של הפרויקט (`createRequire('/var/www/billing/package.json')`), עם ה-DSN שנקרא
   מהקובץ למשתנה סביבה (`sudo cat … | grep` — לעולם לא על שורת הפקודה של sudo),
   `captureException`, ואז `flush(5000)`. עטיפת `makeNodeTransport` מחזירה את קוד
   ה-HTTP של ה-ingest (200 = נקלט). האירוע צריך להופיע ב-Issues תוך דקה, עם
   `environment=production`.
3. **לקוח:** כבוי בפרודקשן (אין DSN בזמן build). `window.Sentry` לא קיים — זה צפוי.
4. **Sourcemaps:** ב-Issue ה-stack trace מראה שמות קבצים מ-`src/`, לא
   `chunks/xxxx.js`. אם לא — `SENTRY_AUTH_TOKEN` חסר בזמן build.
5. **Logger:** `logger.error(new Error('smoke'))` בכל route → Issue חדש. הבדיקה
   `tests/logger.test.ts` מוכיחה את החיווט מול mock, ו-`tests/sentry-runtime.test.ts`
   את הקריאה בזמן ריצה (init + שורת הלוג, עם DSN ובלעדיו).
