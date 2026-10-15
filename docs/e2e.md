# בדיקות קצה-לקצה — Playwright + Mailpit

בדיקות (`e2e/`) רצות מול **ה-build האמיתי** (standalone) ומול DB בדיקה + Mailpit.
**עודכן 15/10/2026 — הייתה כאן רשימה של 4 בדיקות בלבד; היום יש 28 קובצי
`.spec.ts`/`.setup.ts`.** הרשימה למטה היא תמונת מצב ועלולה להתיישן שוב —
`ls e2e/*.spec.ts` הוא מקור האמת החי; השורה הראשונה של כל קובץ היא התיעוד
המלא שלו.

| # | קובץ | מה נבדק |
|---|---|---|
| 1 | `e2e/auth.setup.ts` | התחברות דרך טופס ה-login האמיתי → session נשמר ל-`e2e/.auth/state.json`; שאר הבדיקות רצות מחוברות (ניסיון login **אחד** לריצה, בגלל rate-limit לפי IP). |
| 2 | `e2e/legal-status.spec.ts` | `PUT /api/debtors/:id/legal-status` → נקרא חזרה ← משוחזר לברירת המחדל. |
| 3 | `e2e/smtp-settings.spec.ts` | `PUT /api/settings/smtp` (מוצפן ב-`SETTINGS_ENC_KEY`) → `GET` מחזיר תצוגה ציבורית בלי סיסמה; כתובת שאינה Gmail → 400. |
| 4 | `e2e/smtp-test-email.spec.ts` | `POST /api/settings/smtp/test` → nodemailer אמיתי → Mailpit → אימות דרך `GET /api/v1/messages`. |
| 5 | `e2e/single-message-attachments.spec.ts` | שליחת WhatsApp לדייר בודד — שדה הקובץ תומך `multiple`, בחירה אחת של שני קבצים = שתי שורות בתצוגה המקדימה. |
| 6 | `e2e/broadcast-attachments.spec.ts` | אותו דבר בחלון התפוצה (dropzone, עד 10 קבצים) — לא קלטת הצ'אט. |
| 7 | `e2e/broadcast-email.spec.ts` | תפוצה מאוחדת — ערוץ המייל, קטגוריית "תפוצה", תבנית עד שליחה. |
| 8 | `e2e/contact-suggestions.spec.ts` | תור הצעות בלינק: הצעה שהסנכרון מגיש לא דורסת שדה קיים עד שמישהו מכריע, דרך המסך. |
| 9 | `e2e/debtors-tab-counts.spec.ts` | תגי הטאבים בדף החייבים סופרים את מה שהטבלה מציגה **תחת החיפוש הנוכחי**, לא את כל הבניין. |
| 10 | `e2e/issues-kanban-dnd.spec.ts` | לוח `/issues` לפי מוקצה ראשי (מסלול ref/issues-board.html) — נתיבי גרירה: כותרת מסלול, שורה ברשימה. |
| 11 | `e2e/portal-category-trend.spec.ts` | טאב העסקאות בפורטל: שורת קטגוריה נפתחת על סכום 12 החודשים המפורסמים האחרונים. |
| 12 | `e2e/portal-decisions-preview-lock.spec.ts` | תצוגה מקדימה לאדמין של טאב ההחלטות — "פתיחת מסמך"/"הורדה" עוברים דרך נתיב הקבצים של הצוות, דורשים `portal_decisions:view`. |
| 13 | `e2e/portal-issue-report.spec.ts` | "דיווח על תקלה" מהפורטל — השורה נרשמת על שם הבעלים שבסשן (לא בהכרח הבעלים הראשון של הדירה). |
| 14 | `e2e/portal-login-otp.spec.ts` | `/portal/login` מקצה לקצה: שלב הטלפון, הקוד (וואטסאפ היום; SMS/וואטסאפ-ברירת-מחדל לפי `otpChannel.ts` מ-15/10/2026), חילוץ קוד מהדבקה רועשת, כפתור "הדבק קוד", 16 המצבים של קוד שגוי/פג/חסימה/שליחה חוזרת. |
| 15 | `e2e/portal-numbers.spec.ts` | תצוגת שקלים שלמים בכל מסך בפורטל, מול סכומים מדויקים עם אגורות ב-DB. |
| 16 | `e2e/portal-overview-redesign.spec.ts` | מסך הסקירה המחודש (סבב 3, 14/10/2026) — הכותרת הנגררת-מתכווצת, טופס הדיווח שלא נדחק החוצה בדסקטופ צר. |
| 17 | `e2e/portal-period-picker.spec.ts` | בורר הטווח החד-לחיצתי בטאב ההכנסות וההוצאות — "כל YYYY" + חיצי שנה מעל רשת 3×4. |
| 18 | `e2e/portal-roles.spec.ts` | הפורטל לפי תפקיד (בעלים/שוכר/מפעיל) ואזהרת ההזנה: מסך "טלפונים חסומים" ו"אותו אדם?" כשטלפון שהוזן רשום בדירה אחרת תחת שם אחר. |
| 19 | `e2e/portal-security.spec.ts` | שנים-עשר בדיקות אבטחה של הפורטל — בידוד מכניסת הצוות, גבולות ה-session, חודש מוסתר, קודים חד-פעמיים. |
| 20 | `e2e/reminder-attachments.spec.ts` | תיאור + קבצים מצורפים בתזכורת — ההעלאה עצמה מדומה (אין Storage זמין ב-CI). |
| 21 | `e2e/supplier-contacts.spec.ts` | "הוסף איש קשר נוסף" לספק — יצירה/עריכה/הסרה דרך המסך האמיתי, ונשמר נקי ב-DB. |
| 22 | `e2e/user-reminders-access.spec.ts` | מי רשאי לקרוא/לשנות/למחוק תזכורת — היוצר מול משתמש אחר. |
| 23 | `e2e/user-reminders-order.spec.ts` | סדר אישי (per-user) של רשימת התזכורות, כולל אחרי רענון ולכל משתמש בנפרד. |
| 24 | `e2e/users-permanent-delete.spec.ts` | "מחק לצמיתות" — המשתמש נעלם מהרשימה והמונים, לא יכול להתחבר, אך תוכן שכתב נשאר תחת שמו. |
| 25 | `e2e/users-role-change.spec.ts` | טופס "צור משתמש" בלי תפקיד ברירת מחדל; שינוי תפקיד נשמר נכון. |
| 26 | `e2e/users-tiered-admin.spec.ts` | מסך "משתמשים" לפי תפקיד — דרג הניהול (users/permissions/settings) נעול למנהל שאינו סופר-אדמין. |
| 27 | `e2e/work-items-board-order.spec.ts` | "התאמת לוח" + גרירת שורה ברשימה — שני ערוצי גרירה שנשמרים per-user per-module. |
| 28 | `e2e/app-shell-padding.spec.ts` | ריפוד התוכן הקבוע (`.safe-px`/DESIGN.md §32) — אינווריאנט: אין תוכן שנוגע בקצה המסך. |
| 29 | `e2e/assistant-resident-view.spec.ts` | "עוזר אישי" הצף לא קיים בתצוגת הדייר (`?view=resident`) — קיים בכל מסך אחר. |

**נתוני בדיקה** — `db/seed/e2e.sql` (לא בקוד הבדיקות): משתמש `e2e-admin`
(super_admin, סיסמה `E2e-Passw0rd!`, hash של pgcrypto), דייר `E2E-101`,
דירות הפורטל `E2E-A`..`E2E-D`/`E2E-T`/`E2E-O` עם בעלים/שוכרים/מפעילים
קבועים. **לא להריץ על פרודקשן.**

**SMTP לסביבת test** — `src/lib/email/transporter.ts` מכבד `SMTP_HOST` /
`SMTP_PORT` / `SMTP_REQUIRE_TLS=false`; `playwright.config.ts` מכוון אותם ל-Mailpit.
בפרודקשן המשתנים לא מוגדרים → Gmail כמו קודם.

## הרצה מקומית

```bash
npm run e2e:mailpit           # Mailpit: SMTP 127.0.0.1:55525, UI/API http://localhost:55580
npm run db:up && npm run db:seed:e2e   # סכימה + fixtures על DATABASE_URL מ-.env.local
npm run build                 # ה-e2e רץ על .next/standalone (נבנה אוטומטית אם חסר)
npm run test:e2e              # כל הבדיקות
npm run e2e:mailpit:down
```

- **`DATABASE_URL`/`.env.local` של הרצה הזו חייב להצביע על מסד בדיקה חד-פעמי,
  לא על `proj_billing` האמיתי** — ה-`.env.local` שיושב בתיקיית הפרודקשן
  (`/var/www/billing`) מצביע ישירות על הפרודקשן ואסור להשתמש בו להרצת
  הסקריפטים למעלה (`db:up`/`db:seed:e2e` כותבים). עבודה על ענף = worktree עם
  `.env.local` נפרד, מכוון למסד חד-פעמי.
- הבדיקות פונות ל-`http://localhost:3100` (`E2E_PORT` לשינוי). חובה `localhost` ולא
  `127.0.0.1`: ה-build הוא production, ה-cookie מסומן `Secure`, ו-Playwright שולח
  cookies כאלה ב-http רק ל-localhost.
- אחרי שינוי קוד: `E2E_REBUILD=1 npm run test:e2e` (או `npm run build` לפני).
- כישלון → `npx playwright show-trace test-results/<...>/trace.zip`.

## CI

Job נפרד `e2e` ב-`.github/workflows/ci.yml`: Postgres service → `dbmate up` →
seed → Mailpit (`docker compose`) → `playwright install --with-deps chromium` →
`npm run build` → `npm run test:e2e`. דו"ח Playwright עולה כ-artifact בכישלון.
