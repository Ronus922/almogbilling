# ניטור — Sentry, healthchecks.io, /api/health

## מה יש בקוד

| רכיב | קובץ | התנהגות |
|---|---|---|
| Logger יחיד | `src/lib/logger.ts` | pino. `logger.error(err, msg)` → `Sentry.captureException`; `logger.error('msg')` → `Sentry.captureMessage`. לעולם לא זורק. |
| Sentry server | `sentry.server.config.ts` ← `src/instrumentation.ts` | `init` **רק אם `SENTRY_DSN` מוגדר**; אחרת שום דבר לא מאותחל ולא נשלח. `onRequestError` תופס שגיאות RSC/route לפני הקוד שלנו. |
| Sentry edge | `sentry.edge.config.ts` | אותו כלל, ל-`src/middleware.ts`. |
| Sentry client | `src/instrumentation-client.ts` | ה-DSN מגיע מ-`SENTRY_DSN` דרך `env` ב-`next.config.ts` (inline בזמן build). `onRouterTransitionStart` לניווטים. |
| Error boundary שורש | `src/app/global-error.tsx` | שגיאת render שברחה מכל דף → `captureException` + מסך "משהו השתבש" (RTL). |
| Sourcemaps | `withSentryConfig` ב-`next.config.ts` | מעלה sourcemaps ב-build **רק** כש-`SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` קיימים בסביבת ה-build. בלעדיהם — build רגיל. |
| Health | `GET /api/health` | `200 {status:'ok'}` רק אם `SELECT 1` מול ה-DB עובר; אחרת `503`. ציבורי (בלי session) — מתועד ב-`check:auth`. |
| תזכורות | `scripts/run-reminders.sh` | אחרי ריצה מוצלחת `curl $HEALTHCHECK_REMINDERS_URL`; בכישלון `…/fail`. |
| גיבוי | `scripts/backup/pg-backup.sh` | `curl $HEALTHCHECK_BACKUP_URL` בסיום, `…/fail` בשגיאה. |

משתני סביבה (כולם אופציונליים, ריק = כבוי): `SENTRY_DSN`, `SENTRY_ENVIRONMENT`
(ברירת מחדל `NODE_ENV`), `SENTRY_TRACES_SAMPLE_RATE` (0.1), `SENTRY_ORG`,
`SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` (build בלבד), `LOG_LEVEL` (info בפרודקשן,
debug בפיתוח), `HEALTHCHECK_REMINDERS_URL`, `HEALTHCHECK_BACKUP_URL`.

**איפה שמים אותם על השרר:** `SENTRY_DSN`/`SENTRY_ENVIRONMENT` גם ב-
`/etc/billing/billing.env` (runtime של `billing.service` + `run-reminders.sh`)
**וגם** ב-`/var/www/billing/.env.local` (כדי ש-`npm run deploy` יראה אותם בזמן
build ויטמיע את ה-DSN בקוד הלקוח). `SENTRY_AUTH_TOKEN`/`ORG`/`PROJECT` — רק ב-
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

1. אחרי מילוי `SENTRY_DSN` ו-`npm run deploy`: `journalctl -u billing.service -n 20`
   — אין שגיאות init.
2. **שרת:** קרא ל-route שמחזיר 500 מבוקר, או מ-`node` בתוך `/var/www/billing`:
   ```bash
   set -a; source .env.local; set +a
   node -e "require('@sentry/nextjs').init({dsn:process.env.SENTRY_DSN});require('@sentry/nextjs').captureMessage('billing smoke '+new Date().toISOString());require('@sentry/nextjs').flush(3000).then(()=>console.log('sent'))"
   ```
   האירוע צריך להופיע ב-Issues תוך דקה, עם `environment=production`.
3. **לקוח:** בקונסולת הדפדפן על האתר: `window.Sentry?.captureMessage('client smoke')` —
   אם `window.Sentry` לא קיים, ה-DSN לא היה בסביבת ה-build (בדוק `.env.local`).
4. **Sourcemaps:** ב-Issue מהלקוח ה-stack trace מראה שמות קבצים מ-`src/`, לא
   `chunks/xxxx.js`. אם לא — `SENTRY_AUTH_TOKEN` חסר בזמן build.
5. **Logger:** `logger.error(new Error('smoke'))` בכל route → Issue חדש. הבדיקה
   `tests/logger.test.ts` מוכיחה את החיווט מול mock.
