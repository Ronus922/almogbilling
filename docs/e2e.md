# בדיקות קצה-לקצה — Playwright + Mailpit

ארבע בדיקות (`e2e/`) רצות מול **ה-build האמיתי** (standalone) ומול DB בדיקה + Mailpit:

| # | קובץ | מה נבדק |
|---|---|---|
| 1 | `e2e/auth.setup.ts` | התחברות דרך טופס ה-login האמיתי → session → `/api/auth/me`. משמש גם כ-setup: ה-cookie נשמר ל-`e2e/.auth/state.json` ושאר הבדיקות רצות מחוברות (ניסיון login **אחד** לריצה, בגלל rate-limit לפי IP). |
| 2 | `e2e/legal-status.spec.ts` | `PUT /api/debtors/:id/legal-status` → נקרא חזרה ב-`GET /api/debtors/:id` → משוחזר לסטטוס ברירת-המחדל. |
| 3 | `e2e/smtp-settings.spec.ts` | `PUT /api/settings/smtp` (מוצפן ב-`SETTINGS_ENC_KEY`) → `GET` מחזיר תצוגה ציבורית בלי סיסמה; כתובת שאינה Gmail → 400. |
| 4 | `e2e/smtp-test-email.spec.ts` | `POST /api/settings/smtp/test` → nodemailer אמיתי → Mailpit → אימות דרך `GET /api/v1/messages`. |

**נתוני בדיקה** — `db/seed/e2e.sql` (לא בקוד הבדיקות): משתמש `e2e-admin`
(super_admin, סיסמה `E2e-Passw0rd!`, hash של pgcrypto) ודייר `E2E-101` עם id
קבוע. **לא להריץ על פרודקשן.**

**SMTP לסביבת test** — `src/lib/email/transporter.ts` מכבד `SMTP_HOST` /
`SMTP_PORT` / `SMTP_REQUIRE_TLS=false`; `playwright.config.ts` מכוון אותם ל-Mailpit.
בפרודקשן המשתנים לא מוגדרים → Gmail כמו קודם.

## הרצה מקומית

```bash
npm run e2e:mailpit           # Mailpit: SMTP 127.0.0.1:55525, UI/API http://localhost:55580
npm run db:up && npm run db:seed:e2e   # סכימה + fixtures על DATABASE_URL מ-.env.local
npm run build                 # ה-e2e רץ על .next/standalone (נבנה אוטומטית אם חסר)
npm run test:e2e              # 4 passed
npm run e2e:mailpit:down
```

- הבדיקות פונות ל-`http://localhost:3100` (`E2E_PORT` לשינוי). חובה `localhost` ולא
  `127.0.0.1`: ה-build הוא production, ה-cookie מסומן `Secure`, ו-Playwright שולח
  cookies כאלה ב-http רק ל-localhost.
- אחרי שינוי קוד: `E2E_REBUILD=1 npm run test:e2e` (או `npm run build` לפני).
- כישלון → `npx playwright show-trace test-results/<...>/trace.zip`.

## CI

Job נפרד `e2e` ב-`.github/workflows/ci.yml`: Postgres service → `dbmate up` →
seed → Mailpit (`docker compose`) → `playwright install --with-deps chromium` →
`npm run build` → `npm run test:e2e`. דו"ח Playwright עולה כ-artifact בכישלון.
