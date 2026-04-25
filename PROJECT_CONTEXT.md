# מערכת ניהול דיירים וגבייה — Project Context
- BASE44_REFERENCE.md הוא חומר עזר בלבד. אסור לקרוא אותו 
  באופן פרואקטיבי. קרא אותו רק אם:
  א. המשתמש מבקש במפורש
  ב. אתה צריך להבין לוגיקה עסקית מסוימת (סעיף 6 או 11)
  
  במקרים אלו — ציין שאתה מתייחס ל-reference, ושאל אם זה 
  רלוונטי לגרסה החדשה לפני שתיישם.
## על הפרויקט
מערכת SaaS לניהול נכסים וגביית חובות, המיועדת למנהלי בניינים, 
חברות ניהול נכסים, בעלי נכסים וגורמי גבייה.

המערכת מרכזת תחת קורת גג אחת:
- ניהול דיירים ובעלי דירות
- מעקב וגביית חובות
- ניהול משימות ותקלות בבניין
- לוח שנה ופגישות
- תקשורת פנימית וחיצונית (WhatsApp, אימייל)
- ניהול ספקים ומסמכים

## קהל יעד
- מנהלי בניינים
- חברות ניהול נכסים
- בעלי נכסים פרטיים
- עורכי דין וגורמי גבייה

## סטאק טכנולוגי
- **Frontend**: Next.js + TypeScript
- **Styling**: TailwindCSS + shadcn/ui
- **Backend**: Supabase self-hosted (db.bios.co.il)
- **שפה**: עברית, RTL מלא
- **Deployment**: על שרת פרטי

## עקרונות עיצוב
העיצוב נוצר ב-Claude Design ומועבר מסך-אחר-מסך.
ה-design system מבוסס על פרויקט PMS קיים שנבנה על אותו שרת.
לפני בניית כל מסך, המשתמש יעביר את העיצוב (screenshot + JSX).
קלוד מחויב לשמור על 100% מהעיצוב המוגדר — אין לפרש מחדש.

## סגנון עבודה
- **Planning-first**: לפני קוד, תוכנית מפורטת לאישור.
- **מסך אחד בכל פעם**: בונים פיצ'ר שלם end-to-end 
  לפני שעוברים לבא.
- **ללא ניחושים**: אם משהו לא מוגדר, שואל לפני שמחליט.
- **שיחה נפרדת לכל מסך**: כל מסך = שיחה חדשה בקלוד קוד.

## Clarifications & Decisions (עודכן 23/04/2026)

### Auth
- **החלטה**: שתי דרכי כניסה — username/password + Supabase Auth (OAuth)
- **לא לעשות**: אין להעתיק את מערכת AppUser+Role של Base44 
  עם password_hash ב-base64 (לא מאובטח).
- **כן לעשות**: Supabase Auth כמערכת הראשית, טבלת profiles 
  מחוברת ל-auth.users.

### MVP Scope (פאזה א')
- Auth + App Shell (Layout + Sidebar + Header + Guards)
- Dashboard
- Import (ייבוא מ-Excel)
- Settings

שאר המסכים (Tasks, Calendar, Chat, Issues, Suppliers, וכו') 
נדחים לפאזה ב'.

### Integrations
- **פאזה א'**: כל האינטגרציות החיצוניות (Green API, Bllink, 
  MAKE, Resend, Gmail) מיושמות כ-**Stubs** ב-`src/services/`.
- **פאזה ב'**: החלפת ה-stubs בקריאות אמיתיות.

## Reference Material
- `BASE44_REFERENCE.md` — מפרט האפליקציה הישנה ב-Base44. 
  **חומר עזר בלבד**, לא כמקור חובה. המבנה החדש עשוי להיות 
  שונה לפי החלטות שיתקבלו בדרך.

## Decisions Log
- 23/04/2026 - Stack נבחר: Next.js + Supabase self-hosted
- 23/04/2026 - MVP מצומצם ל-Auth + Dashboard + Import + Settings
- 23/04/2026 - אינטגרציות כ-stubs בפאזה א'
- 23/04/2026 - מסך ראשון לבנייה: Auth + App Shell
- 23/04/2026 - שם המוצר: ALMOG CRM (בעברית: אלמוג), דומיין פרודקשן: billing.bios.co.il
- 23/04/2026 - Custom auth ב-proj_billing.public (טבלאות users + sessions + password_reset_tokens). אין Supabase Auth, אין auth schema. הנימוק: בידוד מלא בין פרויקטים על אותו שרת — אין JOINs חוצי-DB ואין session משותף.
- 23/04/2026 - PostgREST ב-db.bios.co.il לא מקבל את ה-service-role key של הפרויקט (HTTP 401 לבקשות REST). הוסר @supabase/supabase-js, נוספו pg + @types/pg. כל גישת DB מהאפליקציה דרך src/lib/db.ts (singleton Pool ב-globalThis עם max=10, על DATABASE_URL = transaction pooler 6543). הסקריפט create-first-user.ts משתמש ב-DIRECT_URL (session pooler 5432) כי הוא one-shot.
- 23/04/2026 - bcryptjs (pure JS, בלי native deps), 10 rounds
- 23/04/2026 - session id ו-reset token: crypto.randomBytes(32).toString('base64url'); נשמרים כ-plain ב-DB (token reset חד-פעמי + expires 60 דקות + HTTPS); TODO הרדנינג בפאזה ב'
- 23/04/2026 - "זכור אותי": session expires_at = 30 יום + cookie maxAge = 30 יום. לא מסומן → 24h + session cookie (ללא maxAge). httpOnly + sameSite=lax + secure בפרודקשן.
- 23/04/2026 - RESEND_COOLDOWN_SECONDS = 60
- 23/04/2026 - Middleware בודק רק נוכחות cookie (אין DB hit). ולידציה ב-(app)/layout.tsx ו-API routes דרך getSession().
- 23/04/2026 - /reset-password מוחרג מ-middleware: המשתמש מגיע מ-link עם token ב-query string. ה-token הוא ה-gate היחיד.
- 23/04/2026 - reset password = invalidate כל ה-sessions של אותו user (best practice)
- 23/04/2026 - Email: stub ב-src/services/email.ts (console.log). TODO חיבור ל-Resend בפאזה ב'.
- 23/04/2026 - Google OAuth: כפתור קיים בעיצוב, מציג toast "בקרוב — ייושם בפאזה הבאה". TODO יישום OAuth2 בפאזה ב'.
- 23/04/2026 - RLS לא מוגדר: גישת DB רק דרך src/lib/db.ts בקוד שרת. אם נפתח בפאזה ב' גישה ישירה מהלקוח — נוסיף אז.
- 23/04/2026 - Production deployment: https://billing.bios.co.il (DNS wildcard *.bios.co.il → 51.195.82.57). nginx reverse proxy ל-127.0.0.1:3003, SSL מ-Let's Encrypt (certbot --nginx, HTTP→HTTPS 301). Next.js standalone output (next.config.ts `output: 'standalone'`) רץ דרך systemd unit `billing.service` (User=ubuntu, Group=devops-www, EnvironmentFile=/etc/billing/billing.env). הקונפיגים תואמים לדפוס של invoice.bios.co.il / pms.bios.co.il.
- 24/04/2026 - **Slice 2 הושלם**: Dashboard (6 KPIs + LastImportIndicator + 6 tabs + readonly DebtorsTable) + Import wizard (3-step: upload → mapping/mode → preview/progress) + Sidebar restructured (2 sections: תפריט ראשי + ניהול).
- 24/04/2026 - Schema 002: טבלאות `debtors` (apartment_number unique, סכומים numeric(10,2), legal_status nullable, is_archived) + `import_runs` (mode/status/counts/error). הוספת `is_admin boolean default true` ל-`users` (חזית: `SessionUser.is_admin`).
- 24/04/2026 - Excel parsing: `xlsx` (SheetJS) — sheet 0, row 1 = header, parse from row 2. עמודות A→apt, B→owner_name, C→phone_owner (merge: רק אם ריק), D→total_debt, E→management_fees, F→monthly_debt (text), G→hot_water_debt, H→details. שורות עם A ריק = skipped.
- 24/04/2026 - Import API: `POST /api/debtors/import` (FormData: file + mode + adminPassword?) → מחזיר {runId} מיד; runner רץ async ברקע (lifecycle של systemd Node process). polling דרך `GET /api/debtors/import/status/[runId]` כל 500ms. Batch של 50 שורות + throttle 50ms.
- 24/04/2026 - Replace mode דורש אישור כפול + bcrypt verify של סיסמת ה-user הנוכחי. Merge mode: שדות סכומים תמיד מתעדכנים, phone_owner רק אם ריק, שדות ידניים (phone_tenant, emails, tenant_name, legal_status, operator_id) לא נוגעים. דירות שלא בקובץ במצב merge → סכומים מתאפסים, טקסט נשאר.
- 24/04/2026 - LastImportIndicator: severity ok (<24h, blue) / yellow (24-48h) / red (>48h או null). כפתור "סנכרן עכשיו" קורא ל-`https://crm.bios.co.il/api/admin/jobs/syncBllinkDebt` (cross-origin, credentials:include) — מוצג רק ל-`is_admin=true`. **הקוד המקורי מ-Base44 לא הועבר; שוחזר מ-screenshot + ספק.**
- 24/04/2026 - **CVE ידוע**: ספריית `xlsx` כוללת 2 פגיעויות פתוחות (Prototype Pollution GHSA-4r6h-8v6p-xvw6, ReDoS GHSA-5pgg-2g8v-p4x9) ללא fix זמין מהמתחזקים. mitigation: רק משתמשי auth admin מעלים קבצים. TODO: מעבר ל-`exceljs` כש-`xlsx` יישאר ללא תיקון.
- 24/04/2026 - Header של App השתנה: ה-AlmogLogo עבר ל-Sidebar header ("ניהול אלמוג" + bell badge "+9"). Header נשאר רק UserMenu בצד שמאל.
- 24/04/2026 - סנכרון מ-Almog CRM דרך server-side proxy (`POST /api/sync/bllink`) עם header `x-cron-secret`. ה-endpoint מאומת ב-session של billing ודורש `is_admin=true`; ה-URL והסוד נקראים מ-`process.env.CRM_SYNC_URL` + `CRM_CRON_SECRET`. הסיבה: מפתח סוד אסור לחיות בדפדפן, וגם מאפשר ל-billing להחזיק policy משלו (admin-only, בעתיד rate-limit). LastImportIndicator קורא ל-`/api/sync/bllink` same-origin (בלי `credentials:'include'`) במקום ל-`crm.bios.co.il` ישירות.
- 24/04/2026 - **Standalone deploy gotcha**: `output: 'standalone'` ב-Next.js 16 לא מעתיק את `public/` ו-`.next/static/` לתוך `.next/standalone/`, ולכן build ללא העתקה → 404 על כל ה-CSS והנכסים הסטטיים (שרת ה-standalone מגיש רק מ-`.next/standalone/.next/static/` ו-`.next/standalone/public/`). התווסף `"postbuild"` ב-`package.json` שמריץ `rm -rf` + `cp -r` לשתי התיקיות אחרי כל build. חובה להריץ `npm run build` (ולא `next build` ישירות) כדי ש-postbuild ירוץ. nginx של billing רק proxy-pass ל-127.0.0.1:3003 — לא מגיש static בעצמו.
- 25/04/2026 - נוצר GIT_PUSH_SKILL.md ב-root: workflow ידני לדחיפה ל-origin/main. עקרונות: רק קבצים ששונו (לא git add -A), הודעות commit מנוסחות לפי תוכן ה-diff, pull --rebase ועצירה על קונפליקטים אמיתיים, אסור --force בלי אישור מפורש. מופעל ידנית כשהמשתמש מבקש ("תדחוף", "push", "commit ודחוף"). מופנה מ-CLAUDE.md כדי שייטען אוטומטית בכל שיחה.
- 25/04/2026 - **Slice 3 הושלם**: TenantDetailPanel (Sheet side=left, 55vw, 1.2s easing premium) עם Header gradient כחול-כהה + 5 סקשנים (פרטים עיקריים / מידע נוסף / פעולות מהירות 3-buttons / DebtsCard / NextAction + LegalManagement / Comments) + Footer sticky + AlertDialog ליציאה. PanelTabs (פרטי דייר active, מסמכים+היסטוריה disabled). Optimistic UI + router.refresh + toast לכל mutation. VIEWER banner + disabled fields. DESIGN.md מאסטר design system + skill `design-system` + skill מורחב `side-panel`.
- 25/04/2026 - **Slice 3.5 — Complete-action mechanism**: migration 004 (`completed_actions` table, description NOT NULL), 2 API routes (`POST /complete-action` בטרנזקציה: insert + clear next_action_* + set last_contact_date=current_date; `GET /completed-actions`), CheckCircle2 button בטאב "פעולות" עם AlertDialog ירוק, CompletedActionsCard בפאנל. Fallback `(ללא תיאור)` ב-API כש-next_action_description=null אבל יש date. ה-action מתועד עם snapshot של description+due_date+author — קישור לdebtor רק דרך FK (cascade).
- 25/04/2026 - **Tab filter logic refined**: טאב "חייבים" (active) משתמש ב-`NOT IN ('מכתב התראה','לטיפול משפטי','בהליך משפטי')` — מבטיח שכל דייר non-archived מופיע ב**בדיוק** טאב אחד. 3 הסטטוסים הפנימיים (במעקב נעמה/בניהול פתאל/לטיפול רונן) נופלים ל"חייבים". טאב "פעולות" הופעל: filter `next_action_date IS NOT NULL`, sort כפוי `next_action_date asc nulls last` (אינו תלוי בפרמטר sort של URL).
- 25/04/2026 - **Phone validation rich**: `validatePhone()` עם 3 types (mobile 10ספרות /^05[0-9]{8}$/ , landline 9-10ספרות /^0[2-9][0-9]{7,8}$/, intl /^\+972[0-9]{9}$/) ו-error messages עבריות מפורטות. EditPhoneDialog מציג ⚠️ inline (text-[12px] font-semibold text-red-500). validation range מיושר ל-formatPhoneDisplay (9-11 ספרות) — מונע "phantom saves" שבהם מספר נשמר אבל מוצג "אין".
- 25/04/2026 — **Slice 4 — Deploy pipeline**: נוצר `deploy.sh` ב-root + `GET /api/health` שעושה DB ping (`SELECT 1`). ה-script: safety check על שינויים לא-committed (read-p אינטראקטיבי, אישור y/N) → `npm run build` (כולל postbuild) → migrations מותנה (אם `scripts/run-migrations.ts` קיים — כרגע לא קיים, מורצות ידנית) → `sudo systemctl restart billing.service` → polling healthcheck ל-`https://billing.bios.co.il/api/health` (10 ניסיונות × 2 שניות + 3 שניות sleep ראשוני). Deploy מניח שהקוד כבר על השרת (אין `git pull`) — מתאים לזרימה הנוכחית של עריכה ישירה ב-`/var/www/billing/`. אסור להריץ `next build` ישירות; חובה דרך `deploy.sh` או `npm run build` כדי להפעיל postbuild.

### Slice 3 + 3.5 — סיכום מבני (25/04/2026)

**DB schema**:
- Migration 003 (`003_debtor_panel.sql`): טבלאות `statuses` (id, name unique, description, color hex, is_default, is_active, sort_order, notification_emails text[]), `legal_status_history` (audit: old/new status snapshot, changed_by, source MANUAL/IMPORT/AUTO_DEFAULT/SYSTEM_FIX), `comments` (debtor_id FK cascade, content, author snapshot). הרחבת `debtors` ב-11 שדות חדשים (legal_status_id FK, legal_status_source, legal_status_lock, legal_status_updated_at/by/by_name, notes, next_action_date, next_action_description, last_contact_date, phones_manual_override). drop של `legal_status` text הישן.
- Migration 004 (`004_completed_actions.sql`): `completed_actions` (debtor_id FK cascade, apartment_number, description NOT NULL, due_date, completed_at, completed_by, completed_by_name).
- Seed 7 סטטוסים: רגיל (default `#f3f4f6`), מכתב התראה (`#fde68a`), לטיפול משפטי (`#fecaca`), לטיפול רונן (`#bfdbfe`), במעקב נעמה (`#ddd6fe`), בניהול פתאל (`#bfdbfe`), בהליך משפטי (`#fca5a5`).

**API endpoints — Slice 3 (5)**:
- `GET /api/statuses` — כל הסטטוסים הפעילים, ממוין sort_order
- `GET /api/debtors/[id]` — tenant detail + 3 הערות אחרונות
- `PATCH /api/debtors/[id]` — admin: phones / notes / next_action / last_contact (validation rich לטלפון)
- `PUT /api/debtors/[id]/legal-status` — admin: בטרנזקציה — update + audit row + email notification (stub) ל-notification_emails של הסטטוס
- `GET /api/debtors/[id]/comments` + `POST` — admin בלבד ל-POST

**API endpoints — Slice 3.5 (2)**:
- `POST /api/debtors/[id]/complete-action` — admin: בטרנזקציה — INSERT ל-completed_actions עם snapshot (description / due_date / author) + clear next_action_* + set last_contact_date = current_date. Fallback `(ללא תיאור)` כש-description=null
- `GET /api/debtors/[id]/completed-actions` — היסטוריה מלאה ממוינת desc

**Components ב-`src/components/tenant-detail-panel/`**:
TenantDetailPanel (orchestrator), Section (card עם icon-chip), StatusBadge, KpiCard (rose/blue/violet), MainDetailsCard (Home), AdditionalInfoCard (FileText), QuickActionsCard (3 buttons grid: WhatsApp/Email/SMS — disabled עם Lock), DebtsCard (Wallet, full-width עם 3 KPIs), NextActionCard (Calendar, draft state), LegalManagementCard (Scale, Select עם dropdown צבעוני, optimistic), CompletedActionsCard (CheckCircle2 emerald, history list), CommentsSection (avatar + Send circle in textarea, Ctrl+Enter), PanelTabs (פרטי דייר active, מסמכים+היסטוריה disabled), PanelFooter (סגור / Print / FileDown / היסטוריה / שמור שינויים), EditPhoneDialog (rich validation).

**Sheet patches ב-`src/components/ui/sheet.tsx`** (לפי skill `side-panel`):
- Overlay: `bg-slate-950/40` (≈0.65 contrast feel) + duration-[400ms] ease-out
- Content: w-[55vw] sm:min-w-[720px] (lift width default), shadow-2xl shadow-slate-900/30, transition duration-[1200ms] ease-[cubic-bezier(0.16,0.84,0.26,1)]
- Translate from off-screen-left (-translate-x-full) במקום ה-2.5rem הסוביטיים שלshadcn
- Border-r physical (לא border-e שמתהפך ב-RTL)
- showCloseButton=false → custom X button בHeader

**UX patterns מרכזיים**:
- **Optimistic UI**: שינוי סטטוס/טלפון → UI מתעדכן מיד → API ברקע → rollback אם נכשל. כל success מלווה ב-toast + `router.refresh()` שמרענן את הטבלה במקביל.
- **Dirty tracking**: `hasMutated` (sticky flag — auto-saved status/phones/comment) + `nextActionDirty` (draft compare). `isDirty = hasMutated || nextActionDirty`. הכפתור "שמור שינויים" enabled כש-isDirty, לחיצה שומרת draft (אם יש) וסוגרת את הפאנל.
- **AlertDialog לאישור יציאה**: כל 3 דרכי הסגירה (X / overlay / ESC) עוברות ב-`requestClose()`. אם isDirty → AlertDialog destructive ("האם לצאת ללא שמירה?" / "צא ללא שמירה" red). אם לא → סגירה מיידית.
- **VIEWER mode**: `!isAdmin` → Alert עליון amber + כל השדות disabled + tooltip "אין הרשאה" על "שמור שינויים".

**החלטות לוגיות**:
- 3 הסטטוסים הפנימיים (במעקב נעמה / בניהול פתאל / לטיפול רונן) משוייכים לטאב "חייבים" (יחד עם רגיל + null) — לא יוצרים יתומים.
- טאב "פעולות" מוצג רק כש-`next_action_date IS NOT NULL`, ממוין `asc nulls last` כפוי (לא תלוי URL sort param).
- `completed_actions` שומר היסטוריה (אופציה ב' של schema אסרטיבי description NOT NULL + fallback ב-API).
- Status pill: ברירת מחדל ("רגיל") מוצגת תמיד בכותרת הפאנל באפור בהיר; בטבלה מוצגת כ-"—" כדי לא להבליט.
- `__clear__`: BE מקבל `status_id=null`, אבל UI לא חושף "הסר סטטוס".

**עיצוב**:
- `DESIGN.md` בשורש הפרויקט — מאסטר design system, 23 סקשנים שמכסים: צבעים, טיפוגרפיה, spacing, buttons (כולל Section 5b "Sync & Import"), form fields, validation (Section 7 — phone), cards, tables, badges, KPI, modals/sheets/dialogs, toasts, sidebar, header, tabs, empty/loading, auth, wizards, RTL, animation, disabled/loading, misc.
- Skill `~/.claude/skills/design-system/SKILL.md` — אוטו-טריגר על כל אלמנט UI חדש.
- Skill `~/.claude/skills/side-panel/SKILL.md` — מורחב עם dirty tracking, footer, VIEWER, optimistic, confirm-exit (לפי הפאטרן הסופי של TenantDetailPanel).

**קבצים חדשים ב-Slice 3 + 3.5**:
```
DESIGN.md
supabase/migrations/003_debtor_panel.sql
supabase/migrations/004_completed_actions.sql
src/types/tenant.ts
src/lib/db/statuses.ts
src/lib/db/legalStatusHistory.ts
src/lib/db/comments.ts
src/lib/db/completedActions.ts
src/lib/phone.ts
src/lib/validation.ts                 (חדש — נדרש גם ל-phone)
src/app/api/statuses/route.ts
src/app/api/debtors/[id]/route.ts
src/app/api/debtors/[id]/legal-status/route.ts
src/app/api/debtors/[id]/comments/route.ts
src/app/api/debtors/[id]/complete-action/route.ts
src/app/api/debtors/[id]/completed-actions/route.ts
src/components/tenant-detail-panel/  (14 קבצים)
src/components/ui/sheet.tsx           (patched)
src/components/ui/alert-dialog.tsx    (התקנה חדשה)
src/components/ui/textarea.tsx        (התקנה חדשה)
~/.claude/skills/design-system/SKILL.md
~/.claude/skills/side-panel/SKILL.md
```

**קבצים שעודכנו**:
```
src/lib/db.ts                         (+withTransaction)
src/lib/db/debtors.ts                 (rewrite: JOIN עם statuses, sort keys, getDebtorById, updateDebtorFields, updateDebtorLegalStatus, tab filters refined)
src/services/email.ts                 (+sendStatusChangeNotification)
src/app/(app)/dashboard/page.tsx      (sort param expanded, currentTab passed)
src/app/(app)/dashboard/components/DebtorsTable.tsx  (rewrite: sortable headers, status pill from DB hex, ₪-prefix LTR cells, conditional actions-tab columns + CheckCircle2)
src/app/(app)/dashboard/components/DebtorsTabs.tsx   (cursor-pointer, actions tab enabled)
src/app/(app)/dashboard/components/DebtorsToolbar.tsx (text-xl title, slate-400 subtitle)
src/app/(app)/dashboard/components/LastImportIndicator.tsx (Sync/Import buttons spec, white/yellow/red severity)
src/app/(app)/import/components/Step3PreviewProgress.tsx (legal_status_id in protected fields)
src/app/(app)/import/components/ReplaceConfirmDialog.tsx (AlertTriangle icon)
src/lib/import/runner.ts              (comment update)
src/components/auth/ResetPasswordForm.tsx (Section 7 validation pattern)
src/app/api/debtors/route.ts          (sort keys validation)
PROJECT_CONTEXT.md                    (decisions log + DESIGN.md instruction)
```

TODO:
- DESIGN.md compliance audit לאזורים שלא נסקרו השבוע: `app-shell/Sidebar.tsx`, `app-shell/Header.tsx`, `app-shell/UserMenu.tsx`, `auth/*` (LoginForm/Forgot/Reset/AuthLayout/FeaturesCard), `import/Step1-3*`, `dashboard/KpiGrid.tsx` + `KpiCard.tsx` + `LastImportIndicator.tsx`. הפטרנים שם תועדו ב-DESIGN.md מתוך הקוד הקיים, אבל לא בוצע fix ידני — צריך לעבור ולוודא שאין סטיות נסתרות (גובה כפתור, RTL flips, toast wiring על mutations באוט-pages, וכו')
- `npm run build` מכיל postbuild שמעתיק ל-`.next/standalone/`, אבל לא מריץ `systemctl restart billing`. התוצאה: `.next/` נדרס בזמן שה-process ישן עדיין רץ — Server Actions IDs נשברים ו/או הסכמה מתנגשת עם DB migration שעוד לא רצה. לבחור מסלול: (א) postbuild יריץ אוטומטית `sudo systemctl restart billing` (דורש sudoers rule ל-user של ה-build), או (ב) script `deploy.sh` שכופה build → migrate (אם יש) → restart בסדר הנכון. התיעוד ב-PROJECT_CONTEXT צריך לאסור `npm run build` בודד בסביבה חיה
- להגדיר SMTP אמיתי (Resend / Gmail) במקום ה-stub לפני פריסה לפרודקשן (placeholder: noreply@billing.bios.co.il)
- Rate-limiting ל-/api/auth/login ו-/api/auth/forgot-password לפני production
- Rate-limiting ל-`/api/sync/bllink` (אדמין בלבד, אבל שכבת הגנה נוספת נגד abuse / לחיצות כפולות)
- [almog — לא billing] fail-closed על `CRON_SECRET`: אם משתנה הסביבה לא מוגדר, endpoint `syncBllinkDebt` חייב להחזיר 500, לא להישאר פתוח
- Google OAuth בפאזה ב'
- Next.js 16 הציג deprecation: middleware → proxy. לעבור בעתיד הקרוב כש-API מתייצב.
- שקילת hash של reset tokens במסד (הצפנה נוספת)

## הוראות לקלוד
- ענה תמיד בעברית (למעט קוד, פקודות, ושמות טכניים)
- אל תתחיל לכתוב קוד בלי תוכנית שאושרה
- כל אלמנט UI חדש בפרויקט (כפתורים, dialogs, alerts, toasts, form validation, cards, tables, sidebar items, badges, וכו') חייב להתאים ל-DESIGN.md בשורש הפרויקט. קרא את הסקשן הרלוונטי לפני יצירת קומפוננטה ויזואלית חדשה. אם דפוס חסר — לא להמציא וריאציה; לעדכן את DESIGN.md כחלק מהשינוי.
- אל תיצור קבצי MD חדשים עם שמות אקראיים — תעדכן את 
  PROJECT_CONTEXT.md עם כל החלטה חדשה תחת Decisions Log
- BASE44_REFERENCE.md הוא חומר עזר בלבד — לא תבנה לפיו 
  בלי אישור מפורש
- לפני מסך חדש — המשתמש יעביר עיצוב מ-Claude Design. 
  חכה לעיצוב לפני שתתחיל לתכנן UI.
- אסור לגשת ל-DBs, קבצים, קונפיגורציה, או מטה-דאטה של 
  פרויקטים אחרים על השרת (proj_pms, proj_invoiceflow, 
  proj_mail_system, proj_temp, או כל פרויקט אחר שאינו 
  proj_billing). הכלל חל על כל הכלים — bash, docker, 
  psql, file read. אם אתה חושב שמידע כזה הכרחי — שאל 
  אישור מפורש לפני שאתה ניגש אליו.