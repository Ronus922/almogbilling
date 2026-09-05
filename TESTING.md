# בדיקות — BILLING (ALMOG CRM)

מערך בדיקות קבוע לאינווריאנטות הקריטיות של המערכת. הפעלה: `npm run check:all`.
כל בדיקה עצמאית (`node scripts/check-<שם>.mjs`), מחזירה `exit 0` בהצלחה והודעת
כישלון ברורה בעברית כשנשברת. בדיקות DB הן **קריאה בלבד** מול הנתונים האמיתיים;
הבדיקות שכותבות (הוכחת unique/idempotency) רצות מול **מסד חד־פעמי** שנוצר ונמחק
בכל ריצה — לעולם לא מול 288 הדיירים האמיתיים.

> **על lint (מ-05/09/2026):** ESLint 9 flat config (`eslint.config.mjs`) — presets של
> `eslint-config-next` + שני כללי הברזל כ-`error`: `@typescript-eslint/no-explicit-any`
> ו-`no-console` (לוגים דרך `src/lib/logger.ts`). בנוסף **SafeQL** מאמת כל SQL סטטי
> שמועבר ל-`query`/`queryOne`/`client.query`/`pool.query` מול הסכימה החיה של
> `DATABASE_URL` (טבלה/עמודה לא קיימת, שגיאת תחביר) — ראה `scripts/lint/`. לכן
> `check:all` = **typecheck → lint → `npm test` → בדיקות האינווריאנטות**. ה-pre-push של husky
> מריץ רק את שלושת הראשונים (ו-lint **בלי** SafeQL) — ראה "מה רץ איפה" למטה.

## הבדיקות — מה כל אחת מגינה

| בדיקה | סקריפט | מגינה מפני |
|---|---|---|
| `check:secrets` | `check-no-secrets.mjs` | דליפת מפתחות ל-git — אף ערך מ-`/etc/billing/billing.env` (דרך `sudo -n`) ו-`.env.local` (service-role, SMTP, Green, Google, Anthropic, DB, `SETTINGS_ENC_KEY`) לא מופיע בקובץ במעקב; אין `.env` במעקב (מלבד `*.example`); ואין **צורת** מפתח שלמה (JWT `role:service_role`, מפתח Anthropic באורך מלא, `-----BEGIN … PRIVATE KEY-----`). התאמה על **צורה** ולא על תחילית — כדי שאזכור התבנית בתיעוד (למשל השורה הזו) לא יפיל את הבדיקה. |
| `check:auth` | `check-api-auth.mjs` | route חשוף — כל handler תחת `src/app/api/**` (125) חייב guard: `require*`/`getCurrentActor`/`getSession` או סוד-מכונה (cron/webhook). קריטי כי ה-routes ניגשים ל-`pg` ישיר (רמת service-role) — **אין RLS כרשת ביטחון**. 9 routes ציבוריים מתועדים (login/logout/reset/invite/google/health/wa-media). |
| `check:rbac` | `check-rbac.mjs` | הרחבת-גישה בטעות במטריצה — מייבא את `hasPermission`/`canManageRole` **האמיתיים** ונועל: `super_admin` הכל · `admin` נחסם מ-`users/roles_management` ולא מנהל תפקיד בכיר · matrix-role מקבל **רק** מה ששורות `user_permissions` מתירות. (רץ תחת `tsx`, לוגיקה טהורה.) |
| `check:money` | `check-money-balanced.mjs` | **חוב שגוי** — לכל דייר פעיל `total_debt = round2(management_fees + hot_water_debt)` ואין ערך שלילי. ה-Bllink sync מחשב זאת מחדש בכל ריצה; סטייה = באג/שחיתות שמציגה חוב שגוי בדשבורד ובדיוני WhatsApp. |
| `check:phone` | `check-phone-policy.mjs` | טלפון מלוכלך במנוחה — `phone_owner`/`phone_tenant` הם מספר מקומי נקי יחיד (`^0\d{8,9}$`) או NULL. ערך מרובה/מתויג/זבל שובר `tel:`, כתובת WhatsApp ופיצול בעלים/שוכר — ומעיד שנתיב קליטה דילג על `cleanPhoneField`. |
| `check:session` | `check-session-hash.mjs` | טוקן session ניתן-לשחזור ב-DB — כל `sessions.id` הוא SHA-256 hex(64) (migration 057). שורה שאינה 64-hex = טוקן גולמי שדליפת DB/גיבוי/replica תהפוך ל-session חי. |
| `check:dupes` | `check-no-duplicate-debtors.mjs` | דייר כפול מ-sync חוזר — אין שני דיירים פעילים עם אותו `apartment_number` (מפתח עסקי `unique`, migration 002). כולל הוכחה בארגז חול ש-unique key דוחה הכנסה חוזרת ומאפשר דירה שונה. |
| `check:wa` | `check-wa-idempotency.mjs` | שליחת WhatsApp כפולה — הוכחה בארגז חול ש-unique index על `wa_campaign_recipients.idempotency_key` (migration 059) דוחה נמען כפול → retry/deploy/מרוץ לא ישלחו את אותה הודעה פעמיים ללקוח. |

> **ארגז החול של הוכחות-הכתיבה** (`uniqueViolationProof` ב-`scripts/_check-lib.mjs`):
> טבלאות `TEMP` בתוך טרנזקציה אחת שנגמרת תמיד ב-`ROLLBACK`, על המסד האמיתי אך
> בלי לגעת בנתונים אמיתיים. מחליף מסד חד־פעמי (`create database`) — ל-role של
> האפליקציה אין `CREATEDB`, ולכן הגרסה ההיא נכשלה תמיד עם `permission denied`.
>
> **בקרת-שלילה (מי שומר על השומר)**: הוכחה שהפסיקה לזהות משהו — סימן שהשתנה,
> נוסח שגיאה של psql שכבר לא תואם, stderr שנבלע — הייתה מדווחת ירוק לנצח. לכן
> `selfTestUniqueViolationProof` מריץ את אותה הוכחה על טבלה **ללא** unique key
> ודורש `rejected=false`; הוא רץ **אוטומטית פעם אחת בכל תהליך** לפני ההוכחה
> האמיתית הראשונה, כך ש-`check:dupes`/`check:wa` לא יכולים להיות ירוקים מגלאי
> שבור. להרצה ידנית: `node scripts/_check-lib.mjs --self-test`. אומת מול גלאי
> שבור מכוון (`rejected` קבוע): הבקרה מפילה אותו — לבד וגם דרך `check:dupes`.

## מה רץ איפה — pre-push מול CI (מ-05/09/2026)

| שער | פקודה | מה רץ | זמן |
|---|---|---|---|
| **pre-push** (husky, `.husky/pre-push`) | `npm run typecheck && SAFEQL=0 npm run lint && npm test` | typecheck · lint (**בלי** SafeQL) · vitest | ~1 דק' (נמדד: 51 שנ' — typecheck 6, lint 41, vitest 4) |
| **CI** (`.github/workflows/ci.yml`, job `check:all`) | `npm run check:all` | הכל: typecheck · lint **עם** SafeQL מול סכימת dbmate · vitest · `check:secrets`/`check:auth`/`check:rbac` · בדיקות ה-DB `check:money`/`check:phone`/`check:session`/`check:dupes`/`check:wa` | ~4–5 דק' |

- **בדיקות שצריכות DB רצות ב-CI בלבד**: `check:money`, `check:phone`, `check:session`, `check:dupes`,
  `check:wa` ואימות ה-SQL של SafeQL. ה-workflow מקים postgres ריק, מריץ `dbmate up` ואז `check:all`.
  מקומית הן זמינות דרך `npm run check:all` כשיש `DATABASE_URL` ב-`.env.local` — זה עדיין השער לפני deploy (ראה "הכלל").
- `SAFEQL=0` מכבה **רק** את בלוק SafeQL ב-`eslint.config.mjs` (ומדפיס `SAFEQL=0 — SafeQL SQL validation
  skipped`); שאר כללי ה-lint רצים כרגיל. בלי הדגל, `npm run lint` מריץ SafeQL בכל פעם ש-`DATABASE_URL` זמין.
- `check:secrets`/`check:auth`/`check:rbac` הן סטטיות ומהירות, אבל נשארו מחוץ ל-pre-push בכוונה
  (pre-push = typecheck + lint + vitest בלבד). הן רצות ב-CI בכל push ובכל `check:all`.
- לדלג על ה-hook פעם אחת: `HUSKY=0 git push`. **CI לא מדלג** — הוא רץ על כל push ועל כל PR.

### הרצה בודדת
```bash
npm run check:money   # או check:secrets / check:auth / check:rbac / check:phone / check:session / check:dupes / check:wa
npm run check:all     # typecheck + lint + vitest + כל בדיקות האינווריאנטות, עוצר על הכישלון הראשון
```

> `check:secrets` קורא את `/etc/billing/billing.env` דרך `sudo -n cat` (מותר ל-
> deploy). בלי sudo הבדיקה יורדת אוטומטית ל-`.env.local` בלבד ומדווחת על כך —
> לא נכשלת.

## בדיקות קצה-לקצה (Playwright)

`npm run test:e2e` — ארבע בדיקות מול ה-build האמיתי, DB בדיקה ו-Mailpit: התחברות,
שינוי סטטוס משפטי, שמירת הגדרות SMTP, שליחת מייל בדיקה. פרטים והרצה: `docs/e2e.md`.
רצות ב-CI כ-job נפרד.

## תוכנית בדיקה ידנית (לפני deploy)

בצע בדפדפן על הפרודקשן אחרי ש-`npm run check:all` ירוק:

1. **התחברות** — פתח את האתר בגלישה פרטית. ודא הפניה ל-`/login`. התחבר. צפוי:
   הגעה לדשבורד ניהול החיובים.
2. **חסימת לא-מורשה** — התנתק, נסה לגשת ישירות ל-`/` או לקרוא `/api/debtors`
   בטאב אנונימי. צפוי: הפניה ל-login / `401`, **לא** נתוני דיירים.
3. **RBAC בסייד-בר** — התחבר כמשתמש `viewer`/`manager` מוגבל. צפוי: מודולים ללא
   הרשאה **מוסתרים** בתפריט, וגישה ישירה ל-API של מודול חסום מחזירה `403`.
4. **גבול admin** — כ-`admin` (לא super_admin) נסה להיכנס ל"ניהול משתמשים" /
   "הרשאות". צפוי: חסום (super_admin בלבד).
5. **סנכרון Bllink** — לחץ "סנכרן עכשיו". צפוי: החוב מתעדכן; פתח דייר וודא
   `total_debt = דמי ניהול + מים חמים`. הרץ שוב מיד → **אין** דיירים כפולים.
6. **טלפון נקי** — פתח דייר עם טלפון; ודא הצגה תקינה ו-`tel:` פועל. ערוך/ייבא
   ערך מורכב (`054... / 050...`). צפוי: נשמר כמספר מקומי נקי יחיד.
7. **שליחת WhatsApp** — צור שידור, שלח. נסה לשלוח שוב / רענן באמצע. צפוי: אין
   נמען/שליחה כפולה, המונים תואמים למצב האמיתי.
8. **התנתקות רב-טאבית** — התנתק בטאב אחד; בטאב שני בצע פעולה. צפוי: איבוד גישה
   (ה-session בוטל).

## הכלל

לפני **כל** deploy:
1. `npm run check:all` — חייב לחזור ירוק.
2. הרץ את תוכנית הבדיקה הידנית למעלה.
3. **אדום = לא פורסים.** מתקנים את השורש (אסור להחליש בדיקה כדי שתעבור), ומריצים שוב.
4. פריסה לפרודקשן היא תמיד `npm run deploy` (build → restart → אימות) — לעולם לא
   `next build` לבד (דורס את `.next/standalone` בלי restart → ChunkLoadError).
