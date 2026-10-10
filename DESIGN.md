# DESIGN.md — מערכת עיצוב מאסטר (ALMOG CRM)

> **מסמך זה הוא מקור האמת לכל אלמנט UI חדש בפרויקט.**
> כל קומפוננטה ויזואלית חדשה (כפתור, dialog, alert, toast,
> form, card, table, sidebar, וכו') חייבת להתאים לדפוסים
> כאן. בעת אי-ודאות — חזור למסמך, לא להמציא וריאציה חדשה.

**Stack**: Next.js 16 + Tailwind 4 + shadcn/ui + lucide-react.
**שפה**: עברית מלאה, RTL.
**פונט**: Heebo (self-hosted, `src/fonts/` — Fontsource, OFL; מ-03/10/2026 בלי Google Fonts).

---

## 1. עקרונות

1. **RTL-aware**: השתמש ב-`start-*` / `end-*` / `ms-*` / `me-*` / `pe-*` / `ps-*` — לא ב-`left-*` / `right-*` (אלא אם פיזי קריטי, למשל border על קצה הפאנל).
2. **shadcn קודם**: השתמש ברכיבי `@/components/ui/*` הקיימים. בקש להתקין רכיב חדש (`npx shadcn@latest add ...`) רק אם אין מתאים.
3. **Tailwind tokens, לא inline-style**: למעט במקרים של dynamic colors מ-DB (סטטוסים).
4. **Heebo לטקסט, Inter למספרים**: כל טקסט עברי/אנגלי ב-Heebo. **Inter** הוא פונט המספרים המאושר, חשוף דרך ה-utility **`font-num`** (מחווט ב-`layout.tsx` + `globals.css`: `--font-num: var(--font-inter)`) — לשימוש עם `tabular-nums` על סכומים, טלפונים, שעות, ו-tokens מסוג `{{var}}`. אין להחדיר פונט **אחר** (Roboto/Arial וכו').
5. **רוחב קונטיינר**: עמודים בתוך `(app)` משתמשים ב-`max-w-3xl` (טפסים) או full-width (טבלאות / dashboard).

---

## 2. Color Palette

### Semantic

| תפקיד | Token |
|---|---|
| Primary action | `blue-600` (hover `blue-700`) |
| Destructive | `red-600` / `destructive` (hover `red-700`) |
| Success | `emerald-600` (hover `emerald-700`) |
| Warning | `amber-600` |
| Info | `blue-600` / `sky-600` |
| Foreground | `text-foreground`, `text-slate-900` |
| Muted | `text-muted-foreground`, `text-slate-500` |
| Card background | `bg-white` / `bg-card` |
| Page background | `bg-background` / `bg-slate-50/60` (פנים-פאנל) |

### Skin tokens ("ניהול אלמוג" — מוגדרים ב-`globals.css @theme`)

מערכת הסקין הויזואלית. ערכים ליטרליים → Tailwind מייצר utilities (`bg-brand`, `text-ink-2`, `border-line`, `shadow-soft-md` וכו'). **זהו הברנד הקנוני** לצד ה-`blue-600` הסמנטי; השתמש בו בפאנלים מודרניים.

| קבוצה | Utility | Hex |
|---|---|---|
| **Brand** | `bg-brand` / `text-brand` | `#3d5afe` |
| | `bg-brand-dark` | `#2c44e0` |
| | `bg-brand-soft` | `#ecefff` |
| | `border-brand-border` | `#cfd7ff` |
| | `text-brand-text` | `#243bb5` |
| **Ink (טקסט)** | `text-ink` | `#1a2233` |
| | `text-ink-2` | `#5b6479` |
| | `text-ink-3` | `#8a92a6` |
| | `text-ink-ghost` (placeholder/רפאים) | `#b4bacb` |
| **Lines** | `border-line` | `#e8eaf2` |
| | `border-line-soft` | `#eff1f7` |
| | `border-line-strong` | `#d9ddea` |
| **Surfaces** | `bg-app` | `#f5f9fd` |
| | `bg-surface-2` (משטח משני) | `#fafbfe` |
| | `bg-row-hover` | `#f5f7fc` |
| **Shadows** | `shadow-soft-xs` / `shadow-soft-sm` / `shadow-soft-md` | צללים רכים בגוון כחלחל |

**Focus ring מותגי** (שדות בפאנלים מודרניים): `focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-[rgba(61,90,254,0.12)]`.
**אדום חובה/שגיאה** (כוכבית שדה): `#e5484d` (זהה ל-severity האדום ב-§5b).

### Tone Variants (עבור Status / KPI / Sections)

מבסיס Tailwind, באותו patterning של `{tone}-50/100/200/600/700`:

| Tone | bg-soft | text-strong |
|---|---|---|
| **rose** | `bg-rose-50` / `bg-rose-100` | `text-rose-600` / `text-rose-700` |
| **blue** | `bg-blue-50` / `bg-blue-100` | `text-blue-600` / `text-blue-700` |
| **violet** | `bg-violet-50` / `bg-violet-100` | `text-violet-600` |
| **purple** | `bg-purple-50` / `bg-purple-100` | `text-purple-600` |
| **amber** | `bg-amber-50` / `bg-amber-100` | `text-amber-600` / `text-amber-700` |
| **emerald** | `bg-emerald-50` / `bg-emerald-100` | `text-emerald-600` |
| **sky** | `bg-sky-50` | `text-sky-600` |
| **slate** | `bg-slate-50` / `bg-slate-100` | `text-slate-500` / `text-slate-600` |

### Status colors מ-DB (statuses table)

לסטטוסים משפטיים — צבע hex נשמר ב-`statuses.color` ונרנדר עם inline `style={{ backgroundColor: hex }}`. טקסט תמיד `text-slate-900`. **לא** מחליפים ל-Tailwind tokens.

### Category colors מ-DB (reminder_categories table)

אותו עיקרון: צבע קטגוריית תזכורת נשמר ב-`reminder_categories.color` (hex שהמשתמש בוחר) — **דאטה, לא טוקן עיצוב**. נרנדר עם inline `style={{ backgroundColor: hex }}` כנקודת-צבע ברשימת הקטגוריות וכפס-צד (side-stripe) על כרטיס התזכורת. בורר הצבע מציע פלטה מותגית (`REMINDER_CATEGORY_COLORS` ב-`@/lib/constants/userReminders`) **וגם** קלט hex חופשי. תזכורת ללא קטגוריה → פס ניטרלי `UNCATEGORIZED_COLOR` (`#e8eaf2`, תואם `border-line`). אין להמיר את צבעי הקטגוריות ל-Tailwind tokens.

---

## 3. Typography

### Page-level

| שימוש | className |
|---|---|
| Page title | `text-2xl font-extrabold` |
| Section heading (in panel) | `text-[26px] font-semibold text-slate-900` |
| Card title | `text-lg font-bold` / `text-base font-semibold` |
| Subheading | `mt-1 text-sm text-muted-foreground` |
| Toolbar title | `text-xl font-bold text-slate-800` + `text-sm text-slate-400` count |

### Body / Inline

| שימוש | className |
|---|---|
| Body | `text-sm` |
| Caption / chip | `text-xs` |
| Form label | `text-base font-medium text-muted-foreground` (פאנל) / `text-sm font-medium` (auth) |
| Numeric data | `font-num tabular-nums` (Inter — חובה לכסף, טלפונים, שעות, ו-tokens `{{var}}`) |

**Font weights**: `font-extrabold` (800) > `font-bold` (700) > `font-semibold` (600) > `font-medium` (500) > `font-normal` (400).

---

## 4. Spacing

Stack rhythms בשימוש בפרויקט: `gap-1.5` / `gap-2` / `gap-3` / `gap-4` / `gap-5` / `gap-6` / `gap-8`.
Padding nominals: `p-3` / `p-4` / `p-5` / `p-6` / `p-8` / `p-10`.
**העדף `space-y-{n}` בין סקשנים, `gap-{n}` בתוך flex/grid.**

---

## 5. Buttons

> **עודכן 15/06/2026 — מערכת הכפתורים הקנונית היא ה"מערכת השטוחה" (Flat).**
> ראה הסקשן **"כפתורים / Buttons — מערכת שטוחה (Flat System)"** בתחתית המסמך —
> הוא מקור-האמת לצבעים, גבהים, רדיוסים ו-variants של כל כפתור. הצבעים/הגבהים
> שמתוארים כאן ב-§5 (למשל `bg-blue-600`, `h-9`) **הוחלפו** על-ידי המערכת השטוחה
> (primary = `#3D5AFE` flat, גובה ברירת-מחדל 44px). הדפוסים המבניים שב-§5 (icon
> button + tooltip, floating-round send, disabled placeholder) **עדיין תקפים**.

### Primary (default Button variant)

```tsx
<Button type="submit" className="gap-2 bg-blue-600 text-white hover:bg-blue-700">
  <Save className="h-4 w-4" /> שמור שינויים
</Button>
```

- גובה default = `h-9` (sm) / Button של shadcn.
- Full-width בטפסים: `className="w-full"`.

### Secondary / Outline

```tsx
<Button variant="outline">סגור</Button>
```

### Destructive

```tsx
<Button className="bg-destructive text-white hover:bg-destructive/90">צא ללא שמירה</Button>
```

או דרך `<AlertDialogAction>`.

### Icon buttons (square, w/ tooltip)

```tsx
<Tooltip>
  <TooltipTrigger render={<span className="block" />}>
    <Button type="button" variant="outline" size="icon" disabled aria-label="הדפסה">
      <Printer className="h-4 w-4" />
    </Button>
  </TooltipTrigger>
  <TooltipContent>בקרוב</TooltipContent>
</Tooltip>
```

### Plain icon (no border, e.g. row actions)

- צבעים סמנטיים: Archive=`text-orange-500`, WhatsApp=`text-green-500`, Comment=`text-slate-400`
- Hover: גוון כהה יותר (`hover:text-orange-600`).
- Disabled: שמור צבע + `disabled:cursor-default`. תוצמד `<Tooltip>` "בקרוב".

### Special — disabled placeholder action (עתידי)

**אסור** להשתמש ב-`bg-blue-500 disabled:opacity-80` שגורם לכפתור להיראות clickable בזמן disabled. במקום:

```tsx
<button
  disabled aria-disabled
  className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-400 ring-1 ring-slate-200 cursor-not-allowed"
>
  <Send className="h-4 w-4" /> שלח ווטסאפ
  <Lock className="h-3 w-3 ms-auto opacity-70" />
</button>
```

עם Tooltip "בקרוב — Slice X".

### Floating round (Send בתוך Textarea)

```tsx
<button
  className={cn(
    'absolute bottom-2 end-2 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full shadow-sm transition-colors',
    canSend ? 'bg-blue-600 text-white hover:bg-blue-700'
            : 'bg-slate-200 text-slate-400 cursor-not-allowed',
  )}
>
  <Send className="h-4 w-4" />
</button>
```

---

## 5b. Sync & Import indicator (LastImportIndicator pattern)

אינדיקטור טריות-נתונים לדשבורד. מציג **שני טיימסטמפים מובחנים** (עודכן 11/09/2026):
**נתוני בלינק נכונים ל-** (`sync_runs.source_run_at` של הסנכרון המוצלח האחרון — הרגע
שבו בלינק נסרק בפועל; **מניע את ה-severity**) ו**סנכרון אחרון** (הריצה האחרונה מ-`sync_runs`,
עם תוצאתה: הצליח / נכשל + השלב). לעולם לא מציגים את זמן ההעתקה כאילו הוא זמן הנתון —
מ-25/08 עד 11/09/2026 המחוון הראה "סונכרן לפני דקה" על snapshot בן 17 יום.

### Container — כרטיס לבן, צל רך, צבע לפי severity

```tsx
<div className={cn('flex flex-col gap-3 rounded-2xl border px-5 py-3.5 shadow-soft-xs md:flex-row md:items-center md:justify-between', styles.wrap)}>
```

| Severity | תנאי (גיל הנתון במקור) | bg | border |
|---|---|---|---|
| `ok`     | < 24h                          | `bg-white`        | `border-line` |
| `yellow` | 24h – `BLLINK_MAX_SNAPSHOT_AGE_HOURS` (36) | `bg-[#fff6e6]` | `border-[#e08700]/30` |
| `red`    | מעל הסף / אין סנכרון מוצלח     | `bg-[#feefef]`    | `border-[#e5484d]/30` |

### באנר אדום קבוע (SyncHealthBanner) — מעל ה-KPI, לכל המשתמשים, ללא סגירה

מוצג כשהריצה האחרונה נכשלה, כשהנתון של הסנכרון המוצלח האחרון ישן מהסף, או כשלא
הצליח סנכרון מעולם (`computeSyncHealth`). פלטת danger של §8:
`rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900`, אייקון
`AlertTriangle` ב-chip `bg-white/70 text-[#e5484d]`, `role="alert"`.

**נוסח (11/09/2026) — שלוש שורות קבועות, זהות בכל המצבים (כשל / ישן / מעולם), הטקסטים
ב-`@/lib/dashboard/syncCopy`:**

1. כותרת (`font-bold`): `הסנכרון מול בלינק נכשל — הנתונים אינם מעודכנים`
2. `עדכון אחרון: <source_run_at של הסנכרון המוצלח האחרון, dd.mm.yyyy HH:mm ב-font-num>` — ואם לא היה
   סנכרון מוצלח מעולם: `עדכון אחרון: אין`
3. `אנא נסה שנית בעוד כמה דקות. אם התקלה ממשיכה להופיע, אנא פנה למנהל המערכת, רונן משולם.`

**לא מציגים למשתמש** את השלב, את מקור ההפעלה (ידני/אוטומטי) או את ההודעה הטכנית של ה-CRM —
הם נשמרים ב-`sync_runs` ומוצגים בפאנל ההיסטוריה. **admin בלבד** (`isAdmin`): מתחת לשורה 3 קישור קטן
`פרטים טכניים` — `<details>` נייטיב סגור כברירת מחדל, `<summary>` בסגנון קישור
(`text-xs font-semibold underline underline-offset-2`, `min-h-[44px]` ל-touch target, בלי marker) — שפותח
בלוק `bg-white/60 px-3 py-2 text-xs`: מתי נכשל + מקור, השלב (`SYNC_STAGE_LABELS`), וההודעה המלאה
ב-`dir="auto"` + `[unicode-bidi:plaintext]`. למשתמש שאינו admin הבלוק לא נמצא ב-HTML בכלל.

### צד ימין (start ב-RTL) — chip + שני טיימסטמפים

- chip לוח-שנה: `grid h-10 w-10 place-items-center rounded-xl {iconBg} {iconFg}` (`CalendarSync`).
- שורה ראשית (`font-semibold`): `נתוני בלינק נכונים ל-<תאריך ב-font-num>` או `טרם בוצע סנכרון מוצלח`.
- שורה משנית (`text-sm text-ink-2`): אייקון `RefreshCw` זעיר + `סנכרון אחרון: <תאריך ב-font-num> · הצליח` / `· נכשל — <שלב>` (אדום `#b01b20`) / `טרם בוצע סנכרון` (`text-ink-3`).
- הערת severity (`text-xs opacity-80`) רק כש-severity != `ok`.

### Button — "סנכרן עכשיו" (ירוק gradient, צל ירוק רך)

```tsx
<Button className="h-9 gap-2 rounded-lg bg-gradient-to-l from-[#16a34a] to-[#0c7a37] px-4 text-sm font-bold text-white shadow-[0_4px_14px_rgba(22,163,74,0.3)] hover:brightness-105">
  <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
  <span>{syncing ? 'מסנכרן…' : 'סנכרן עכשיו'}</span>
</Button>
```

קורא ל-`POST /api/sync/bllink` (same-origin, admin-only); נרשם ב-`sync_runs`; בכל תוצאה — מרענן מ-`GET /api/sync/status` + `router.refresh()` (כדי שהבאנר יופיע/ייעלם). הצלחה: `toast.success('סונכרנו N דירות')`. כישלון: `toast.error(SYNC_FAILURE_TITLE)` — אותה כותרת כמו הבאנר, בלי טקסט טכני; לעולם לא "הופעל בהצלחה" על כשל.

### Button — "היסטוריה" (admin בלבד)

`<Button variant="secondary" size="sm" className="h-9 gap-2 rounded-lg px-4 text-sm">` עם `History` — פותח את
`SyncHistorySheet` (Sheet §12, `side="left"`): טבלה §9 של 30 הריצות האחרונות ב-4 עמודות שנכנסות ב-55vw בלי גלילה —
זמן + מתחתיו מי הפעיל (מייל / "סנכרון אוטומטי", `text-xs text-slate-500`), תוצאה (pill emerald/rose + מתחתיו
השלב שנכשל או "N דירות" שנכתבו), הודעה (`line-clamp-2` + `title`, `dir="auto"` + `[unicode-bidi:plaintext]` כי טקסט ה-CRM מעורב
עברית/אנגלית), נתון נכון ל-. פאנל קריאה-בלבד: footer עם "סגור" יחיד.

### Button — "ייבוא נתונים" (כחול brand)

```tsx
<Button className="h-9 gap-2 rounded-lg bg-brand px-4 text-sm font-bold text-white hover:bg-brand-dark">
  <Upload className="h-4 w-4" /> <span>ייבוא נתונים</span>
</Button>
```

- מוצג **רק** כש-`isAdmin && severity != 'ok'`. במצב OK אין צורך לדחוף את המשתמש לייבוא.

---

## 5c. Toolbar export / print buttons (Printer · Excel · PDF)

כפתורי-אייקון מרובעים (34px) בטולבר טבלה לייצוא/הדפסה של **כל הסט המסונן הנוכחי**
(טאב + חיפוש + מיון), לא רק העמוד הנראה. בנויים על `Button variant="outline"
size="icon"` עם override של גודל ו-tone, עטופים ב-`Tooltip`, ומציגים `Loader2`
מסתובב בזמן עבודה.

| פעולה | אייקון (lucide) | Tone |
|---|---|---|
| הדפסה | `Printer` | ניטרלי `text-ink-2 hover:bg-row-hover hover:text-ink` |
| ייצוא Excel | `FileSpreadsheet` | ירוק `text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700` |
| ייצוא PDF | `FileText` | אדום `text-red-600 hover:bg-red-50 hover:text-red-700` |

```tsx
<Tooltip>
  <TooltipTrigger render={<span />}>
    <Button type="button" variant="outline" size="icon" onClick={onClick}
      disabled={busy} aria-label={label}
      className={cn('h-[34px] w-[34px] rounded-lg border-line bg-surface-2', tone)}>
      {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
    </Button>
  </TooltipTrigger>
  <TooltipContent>{label}</TooltipContent>
</Tooltip>
```

- **Excel** = ExcelJS (`exceljs`; החליף את SheetJS); כספים כ-numbers אמיתיים (לסיכום באקסל), טלפון כ-string; שם גיליון "חייבים"; קובץ `debtors_YYYY-MM-DD.xlsx`. **באקסל בלבד** (לא ב-PDF/הדפסה) שתי עמודות טקסט נוספות, כל אחת מיד אחרי עמודת הסכום שלה: "חודשים שלא שולמו — דמי ניהול" (אחרי "דמי ניהול") ו-"חודשים שלא שולמו — מים חמים" (אחרי "מים חמים") — נגזרות מ-`monthly_debt` ומפריטי "מים חמים" ב-`details` (`src/lib/export/unpaid-months.ts`), תא ריק כשאין; `numFmt '@'` כדי ש-"01-02/26" לא יהפוך לתאריך.
- **PDF** = `jspdf` + `jspdf-autotable` + **Heebo מוטמע** (`src/lib/pdf-heebo.ts`, base64 subset). jsPDF ללא bidi → היפוך תווי-עברית ידני (מחרוזת שמכילה עברית בלבד) + היפוך סדר העמודות ל-RTL; מספרים/תאריך כ-LTR (התאריך ב-`text()` נפרד כדי לא להתהפך). קובץ `debtors_YYYY-MM-DD.pdf`.
- **הדפסה** = `@media print` (`app/styles/print.css`) שמסתיר `body > *:not(#debtors-print-root)` ומציג רק קומפוננטת print (portal ל-`document.body`); כותרת "טבלת חייבים" + "סה״כ N רשומות" + תאריך + טבלה נקייה (עמודות §6 ללא "פעולות"), `₪` + `tabular-nums`, A4 landscape.
- `toast.success('הקובץ יוצא')` / `toast.error` בכל ייצוא.

## 6. Form Fields

### Input (default size)

- Default: `h-8` (shadcn). **בפאנלים מודרניים השתמש ב-`h-10`** (40px) לאחידות עם Select.
- Number/phone: `dir="ltr"` + `tabular-nums`.
- Padding for icons: `pe-9` (icon end) או `ps-9` (icon start). **חובה לרפד את הצד של האייקון** — אחרת הטקסט/placeholder יושב מתחת לאייקון. אייקון ב-`start-3` ⇒ `ps-9`; אייקון ב-`end-3` ⇒ `pe-9`.
- Focus state: ירש מ-shadcn (ring blue).
- Error state: `border-red-400 bg-red-50 focus:ring-red-200`.

### Clearable search input (חיפוש עם X)

שדה חיפוש עם אייקון `Search` ב-start וכפתור ניקוי `X` ב-end שמופיע **רק כשיש ערך**.
ריפוד משני הצדדים כשה-X נוכח כדי שהטקסט לא יחפוף לאף אלמנט.

```tsx
<div className="relative">
  <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
  <Input value={value} onChange={(e) => onChange(e.target.value)}
    className={cn('ps-9', value && 'pe-9')} />
  {value && (
    <button type="button" aria-label="נקה חיפוש" onClick={() => onChange('')}
      className="absolute end-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
      <X className="h-4 w-4" />
    </button>
  )}
</div>
```

- `ps-9` תמיד (אייקון החיפוש); `pe-9` רק כשיש ערך (כפתור ה-X).
- ניקוי מאפס את הסינון של אותו שדה (מחזיר לתצוגה לא-מסוננת לפיו).

### Select (shadcn)

```tsx
<SelectTrigger className="w-full data-[size=default]:h-10">
  <SelectValue placeholder="...">
    {(value) => /* render label, not raw value */}
  </SelectValue>
</SelectTrigger>
```

**חובה**: `SelectValue` עם children-function כשה-`SelectItem` מכיל JSX (לא רק string), אחרת ה-trigger יציג את ה-value הגולמי (UUID).

### Textarea

- shadcn default `min-h-16`.
- אם יש כפתור absolute בפינה (Send) — תוסיף padding בכיוון מתאים: `pb-14` (כפתור תחתון).

### Date Input

- `<Input type="date">`.
- **חובה**: `onClick` שקורא ל-`showPicker()` כדי שלחיצה על כל השדה תפתח את ה-picker (לא רק על האייקון הזעיר):

```tsx
onClick={(e) => {
  const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
  try { el.showPicker?.(); } catch { /* fallback to native icon click */ }
}}
className="h-10 cursor-pointer"
```

### Label

```tsx
<Label htmlFor="..." className="text-base font-medium text-muted-foreground">
  תיאור פעולה
</Label>
```

---

## 7. Validation — מספרי טלפון

### Source of truth

- `src/lib/validation.ts` → `validatePhone(input)` (תוצאה עשירה)
- `src/lib/phone.ts` → `formatPhoneDisplay`, `getPrimaryPhone`, `phoneTelHref` (lenient — מעבד גם נתוני import legacy)

### Rules

| Type | Pattern | דוגמה |
|---|---|---|
| Mobile | 10 ספרות, `/^05[0-9]{8}$/` | `0541234567` |
| Landline | 9–10 ספרות, `/^0[2-9][0-9]{7,8}$/` | `031234567` / `0721234567` |
| International | `/^\+972[0-9]{9}$/` | `+972541234567` |

### `validatePhone(input)` returns

```ts
{ valid: boolean; normalized: string; type: 'mobile'|'landline'|'international'|null; error?: string }
```

Error messages (עברית):

- `'שדה טלפון ריק'`
- `'מספר בינלאומי לא תקין'`
- `'מספר הטלפון קצר מדי'`
- `'מספר הטלפון ארוך מדי'`
- `'מספר טלפון חייב להתחיל ב-0'`
- `'מספר טלפון לא תקין'`

### UI Pattern (in EditPhoneDialog וכל טופס דומה)

```tsx
<Input
  value={phoneInput}
  onChange={(e) => setPhoneInput(e.target.value)}
  placeholder="052-1234567"
  inputMode="tel"
  autoComplete="tel"
  className={cn(error && 'border-red-400 focus-visible:ring-red-200 bg-red-50')}
/>
{error && (
  <p className="mt-1 text-[12px] font-semibold text-red-500 text-right">
    ⚠️ {error}
  </p>
)}
```

### Storage

- ב-DB תמיד **normalized** (digits בלבד, או `+972...` אם בינלאומי).
- ב-UI תמיד דרך `formatPhoneDisplay`.
- בתאי טבלה: `<TableCell dir="ltr" className="tabular-nums">`.

### Validation scope mismatch — נמנע

**אין** ליצור פער בין `isValidPhone` (אישור שמירה) לבין `formatPhoneDisplay` (אישור הצגה). פער כזה גורם לטלפונים שנשמרים ב-DB אך מוצגים כ-"אין", ויוצר רושם של באג שמירה.

---

## 8. Cards & Sections

### Generic Card (shadcn)

```tsx
<Card className="ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
  ...
</Card>
```

- Border עדין: `ring-1 ring-slate-200/70` (לא `border` מובהק).
- Shadow מינימלי: `shadow-[0_1px_2px_rgba(15,23,42,0.04)]` — לא `shadow-lg`/`shadow-2xl`.
- Radius: `rounded-xl` (Card default).

### Section עם אייקון בפינה (פאנלים)

ראה `src/components/tenant-detail-panel/Section.tsx` — אייקון-chip בפינה, headerSlot אופציונלי.

```tsx
<div className="flex items-center justify-between gap-2 px-4">
  <h3 className="text-[26px] font-semibold text-slate-900">{title}</h3>
  <div className="flex items-center gap-2">
    {headerSlot}
    <span className={cn('inline-flex h-8 w-8 items-center justify-center rounded-lg', ICON_TONES[iconTone])}>
      <Icon className="h-4 w-4" />
    </span>
  </div>
</div>
```

### Auth-style center card

```tsx
<Card className="w-full max-w-md justify-self-center p-8 md:p-10 shadow-xl">
```

### Info / hint banner (in import wizard)

```tsx
<div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">...</div>
```

פלטה: `border-{tone}-200 bg-{tone}-50 text-{tone}-900` עם tone מתאים (blue=info, emerald=success, amber=warning, red=danger).

---

## 9. Tables

מבנה אמיתי מ-`DebtorsTable.tsx`:

### Wrapper

```tsx
<div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
  <Table>...</Table>
</div>
```

### Header row

- `<TableHeader>` עם `[&_tr]:border-b [&_tr]:border-slate-200`
- `<TableRow className="bg-slate-50 hover:bg-slate-50">`
- `<TableHead className="h-11 px-4 text-{align} text-sm font-semibold text-slate-500">`
  - Sort active / hover: `text-slate-700`
  - Special tone (נושא הראשי): `text-orange-500 hover:text-orange-600`

### Sortable header

כפתור `inline-flex items-center gap-1` בתוך `<TableHead>`. אייקון `ArrowUp` / `ArrowDown` עם `opacity-0 group-hover:opacity-40` כשלא פעיל, `opacity-100` כשפעיל.

### Body rows

```tsx
<TableRow className="cursor-pointer border-b border-slate-100 hover:bg-slate-50 h-12">
```

- Border בין שורות: `border-slate-100` (דק יותר מהheader).
- Hover: `bg-slate-50`.

### Cells

- `px-4 py-3 text-{align} text-sm`
- Numeric: `tabular-nums dir="ltr"` + `text-{tone}-{600/700} font-bold`
- Text bold: `font-bold text-slate-900` (apartment number) / `font-medium text-slate-800` (name)
- Muted: `text-slate-500`
- Action cell: `onClick={(e) => e.stopPropagation()}` כדי שמלחיץ אייקון לא יפתח את ה-row click

### Numeric format (₪)

```tsx
const numFmt = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });
const ils = (v: number) => `₪ ${numFmt.format(v)}`;
```

תא: `dir="ltr" className="text-center text-sm font-bold text-{tone}-{600/700} tabular-nums"`.

### Pagination row

- מתחת לטבלה: `flex items-center justify-between text-sm`.
- כפתורי "הקודם / הבא" עם `<ChevronRight />` ו-`<ChevronLeft />` (לוגי-RTL).

---

## 9b. Entity List Cards

תצוגת רשימה של ישויות (משתמשים, ספקים, וכו') בקלפי-שורה במקום
טבלה. השתמש כשיש metadata עשיר (avatar + badges + status) שלא
מתאים לעמודות של טבלה.

### Container

```tsx
<div className="space-y-2">
  {items.map((item) => <Card key={item.id} {...} />)}
</div>
```

### Single card (clickable row)

```tsx
<button
  type="button"
  onClick={() => onSelect(item.id)}
  className="w-full rounded-lg border border-slate-200 bg-white p-4 text-start
             hover:bg-slate-50 transition-colors cursor-pointer
             flex items-center gap-3"
>
  {/* Avatar — sect 23 */}
  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full
                   bg-blue-100 text-blue-700 text-xs font-bold">
    {initials}
  </span>

  {/* Details — center, takes remaining space */}
  <div className="min-w-0 flex-1">
    <div className="text-base font-semibold text-slate-900 truncate">
      {primaryText}
    </div>
    <div dir="ltr" className="text-sm text-muted-foreground tabular-nums truncate text-start">
      {secondaryText}
    </div>
  </div>

  {/* Status dot + label (sect 23 active-dot) */}
  <div className="flex items-center gap-1.5 text-xs text-slate-600 shrink-0">
    <span className={cn('h-1.5 w-1.5 rounded-full',
      isActive ? 'bg-emerald-500' : 'bg-slate-400')} />
    {isActive ? 'פעיל' : 'מושבת'}
  </div>

  {/* Role/category badge */}
  <span className="inline-flex items-center rounded-full px-2.5 py-0.5
                   text-xs font-medium bg-{tone}-100 text-{tone}-700 shrink-0">
    {roleLabel}
  </span>
</button>
```

### Non-clickable variant

אם הקלף אינו לחיץ (למשל הזמנה ממתינה — רק כפתורי inline פעולה
פעילים), השתמש ב-`<div>` במקום `<button>`, וסיר את `cursor-pointer` /
`hover:bg-slate-50`. הצמד את האייקונים ב-cell ייחודי עם
`onClick={(e) => e.stopPropagation()}`.

### Action variant (with inline icon buttons)

בקלף שדורש פעולות inline (resend / cancel וכו'), הוסף את האייקונים
בקצה השמאלי (end ב-RTL) ב-cell עם `stopPropagation`:

```tsx
<div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
  <Tooltip>
    <TooltipTrigger render={<button type="button" className="p-1.5 rounded
                                     text-blue-600 hover:text-blue-700
                                     hover:bg-blue-50 transition-colors" />}>
      <RotateCw className="h-4 w-4" />
    </TooltipTrigger>
    <TooltipContent>שלח שוב</TooltipContent>
  </Tooltip>
  {/* X icon similar with rose tone */}
</div>
```

### Loading state

‏5×–10× שורות `h-20 rounded-lg bg-muted/60 animate-pulse` כתחליף לקלפים
הריאליים (גובה תואם בערך לקלף 1-line של avatar 9×9 + padding 4).

---

## 10. Badges & Pills

### Status pill (config-driven, hex from DB)

```tsx
<span
  className="inline-flex items-center rounded-full px-3 py-0.5 text-xs font-semibold text-slate-900"
  style={{ backgroundColor: status.color ?? '#e5e7eb' }}
>
  {status.name}
</span>
```

- Default ("רגיל") → `bg-slate-100 text-slate-500` + טקסט "—" אם לא רוצים להבליט.

### Status badge עם אייקון (Header pill)

ראה `StatusBadge.tsx`: `gap-1.5` + `<Scale className="h-3.5 w-3.5" />` אם `showIcon`.

### Counter badge (next to a tab/icon)

```tsx
<span className="inline-flex items-center justify-center text-xs font-bold px-1.5 py-0.5 rounded-full {tone}">
  {count}
</span>
```

### Notification dot (sidebar bell)

```tsx
<span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
  +9
</span>
```

ספירת unread: מציגים את המספר; כש-`unread > 9` מציגים `+9`.

### Notification row (פעמון + דף /notifications)

שורת התראה אחידה — אייקון-chip לפי **`type`** (לא לפי priority), כותרת bold + הודעה
muted + זמן יחסי, ונקודת unread. ה-`type → icon/tone` מגיע **אך ורק** מה-registry
המרכזי `@/lib/notifications/registry` (`getNotificationVisual`) — אין למפות אייקונים/צבעים
ידנית בקומפוננטה. ה-tone ממופה ל-tokens של §2 דרך `TONE_ICON`
(`info`→blue, `warning`→amber, `danger`→rose, `default`→slate); עדיפות → pill דרך
`PRIORITY_PILL` (§10). זמן יחסי דרך `formatRelativeTime` (date-fns + locale `he`).
השורה היא `<li>` flex עם **שני אחים** (אסור button בתוך button): כפתור-תוכן ראשי
(`flex-1`, לחיצה → מסמן נקרא + ניווט) וכפתור **מחיקה** (`Trash2`) בקצה הלוגי. ה-hover
וה-`bg-blue-50/40` עוברים ל-`<li>` עצמו (`group`) כדי שכל השורה תידלק יחד.

```tsx
const v = getNotificationVisual(n.type); const Icon = v.icon;
<li className={cn('group flex items-stretch transition-colors hover:bg-slate-50', !n.is_read && 'bg-blue-50/40')}>
  <button onClick={...} className="flex min-w-0 flex-1 items-start gap-2.5 px-4 py-3 text-start">
    <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', v.toneClass, n.is_read && 'opacity-60')}>
      <Icon className="h-4 w-4" />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-semibold text-slate-900">{n.title}</span>
      <span className="block truncate text-xs text-slate-500">{n.message}</span>
      <span className="mt-0.5 block text-[11px] text-slate-400">{formatRelativeTime(n.created_at)}</span>
    </span>
    {!n.is_read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-500" />}
  </button>
  {/* מחיקה (soft-clear שורה בודדת) — touch target w-11, danger tone ב-hover */}
  <button type="button" aria-label="מחק התראה" onClick={() => clearOne(n.id)}
    className="grid w-11 shrink-0 place-items-center text-slate-300 hover:text-rose-600 focus-visible:text-rose-600">
    <Trash2 className="h-4 w-4" />
  </button>
</li>
```

- שורה **נקראה** מוצגת מעומעמת וללא הנקודה הכחולה: כותרת `text-slate-500`, הודעה
  `text-slate-400`, ה-icon-chip `opacity-60`. רקע `bg-blue-50/40` רק ללא-נקראה.
- **לחיצה על שורה = מסמנת נקרא** (`is_read=true`, השורה נדלקת מעומעמת **במקום**); ניווט
  ל-`action_url` + סגירת הפאנל **רק אם יש** url, אחרת הפאנל נשאר פתוח כדי שהחיווי ייראה.
- **מחיקת שורה בודדת** = soft-clear (`PATCH /api/notifications/[id]/clear` → `cleared_at=now()`),
  אופטימי (השורה נעלמת מיד) + עדכון badge מה-`unreadCount` שחוזר. אייקון `Trash2` בגוון
  `text-slate-300` שהופך `rose-600` ב-hover (גוון danger §2). **אין מחיקה קשה** — עקבי עם "נקה הכל".
- בטבלת `/notifications` (§9) אותו `getNotificationVisual` מזין את עמודת "סוג"
  (icon-chip `h-7 w-7` + תווית), המקור הוא pill ניטרלי `bg-slate-100 text-slate-600`,
  והעדיפות `PRIORITY_PILL`. שורה לא-נקראה → `bg-blue-50/40`. עמודת **"מחיקה"** אחרונה
  (`w-16`, מיושרת מרכז) — כפתור `Trash2` (`h-9 w-9 rounded-md`, `stopPropagation` כדי לא
  להפעיל את בחירת השורה) → אותו `/[id]/clear` + toast "ההתראה נמחקה".

### Notification panel (פאנל הפעמון — Popover עם טאבים + 2 פעולות)

ה-Popover של הפעמון הוא ה**חריג המאושר** למוסכמת ה-Side Panel (§12) — נשאר Popover,
רק עשיר יותר. רוחב `w-[380px]`, `dir="rtl"`, `align="end"`, `p-0`. מבנה אנכי:

1. **כותרת + 2 פעולות** (`flex justify-between border-b px-4 py-3`): "התראות" (start);
   ב-end שתי פעולות טקסטואליות — **"סמן הכל כנקרא"** (`text-blue-600`, אייקון `CheckCheck`,
   מוצג כש-`unread>0` → `/read-all`) ו-**"נקה הכל"** (`text-slate-500`, אייקון `Eraser`,
   מוצג כשיש פעילות → `/clear-all`). שתי הפעולות **נפרדות**: read ≠ clear.
2. **רצועת טאבים** (`flex flex-wrap items-center gap-1.5 border-b px-2 py-2`) —
   **גולשת ל-2 שורות** (לא גלילה אופקית) כדי שכל 7 הטאבים יישארו גלויים ב-`w-[380px]`:
   הכל · לא נקראו `[badge unread]` · משימות · תקלות · יומן · וואטסאפ · צ׳אט פנימי.
   ברירת מחדל "הכל". טאב נבחר `bg-blue-50 font-semibold text-blue-700`, אחר
   `text-slate-500 hover:bg-slate-50`; כל טאב = `rounded-md px-3 py-1.5 text-xs whitespace-nowrap`.
   תוויות המודולים מגיעות מ-`SOURCE_MODULE_LABEL`; כל טאב טוען מ-`/api/notifications?tab=<value>`.
3. **רשימה** (`max-h-96 overflow-y-auto`) — שורות לפי הדפוס למעלה; ריק → "אין התראות חדשות"
   (טאב לא-נקראו) / "אין התראות" (אחר).
4. **Footer** (`border-t px-4 py-2.5`): קישור מרוכז "צפה בכל ההתראות" → `/notifications`.

- **סמנטיקת אופציה א'** (ראה Decisions Log): לחיצה/סימון-נקרא → `is_read=true` (השורה נשארת
  בפעיל, יוצאת מטאב "לא נקראו"); "נקה הכל" → `cleared_at=now()` (soft-clear, נעלם מכל
  הטאבים, השורה נשמרת ב-DB); **מחיקת שורה בודדת** (פח בכל שורה) → אותו `cleared_at=now()`
  לשורה אחת (`/[id]/clear`). אין מחיקה קשה בשום מסלול.

---

## 11. KPI Cards

מבנה (`KpiCard.tsx` בDashboard):

```tsx
<Card className="p-5">
  <div className="flex items-start justify-between gap-3">
    <div className="min-w-0">
      <div className="text-sm text-muted-foreground">{title}</div>
      <div className="mt-2 text-2xl font-extrabold tracking-tight">{value}</div>
      {subtitle && <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>}
    </div>
    <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full', toneBgFg)}>
      <Icon className="h-5 w-5" />
    </span>
  </div>
</Card>
```

**Tone variants**: `bg-{tone}-50 text-{tone}-600`. ראה רשימה ב-Section 2.

### KPI Mini-cards בתוך פאנל (פירוט חובות)

שונה — gradient + ring inset + `tabular-nums text-2xl font-bold`. ראה `tenant-detail-panel/KpiCard.tsx`.

---

## 12. Modals / Sheets / Dialogs

### When to use Sheet vs Dialog

**Project rule (overrides side-panel skill triggers)**: any **CREATE or
EDIT** operation on an entity (user, debtor, supplier, task, status,
etc.) opens in a **Sheet (side panel)** — not a Dialog — even if the
form is simple.

| Pattern | Use |
|---|---|
| **Sheet (side panel)** | All CRUD on entities: create / edit / details / list-of-related |
| **Dialog (modal)** | Confirmation prompts (Confirm/Alert) — destructive actions • Single-field quick edits (e.g. `EditPhoneDialog`) • Static info (about / help) |

This rule supersedes the side-panel skill's "trigger" criteria around
form complexity. Consistency of CRUD UX wins over the cost of a
heavier panel for a 3-field create form. If you find yourself
reaching for `<Dialog>` to build a Create/Edit form, stop and use
`<Sheet>` instead — even for trivial 2-field forms.

### Sheet (full-side panel)

דפוס מלא ב-skill `~/.claude/skills/side-panel/SKILL.md`. עיקרי:

- `<SheetContent side="left" dir="rtl" showCloseButton={false} className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white">`
- **סולם הרוחב (responsive)** — ‏`55vw` נשאר התנהגות **הדסקטופ**, אבל רק מ-`lg` ומעלה:

  | רוחב מסך | רוחב הפאנל | למה |
  |---|---|---|
  | `<640` | `w-full` | בטלפון הפאנל **הוא** המסך |
  | `640–767` | `92vw` | רמז של backdrop — עדיין נקרא כפאנל, לא כעמוד |
  | `768–1023` | `80vw` | ‏614px ב-768. ‏`min-w-[720px]` כאן היה נותן 94% מהמסך |
  | `≥1024` | `55vw`, רצפה `720px` | התנהגות הדסקטופ המקורית, ללא שינוי |

  הרצפה בפיקסלים (`min-w`) יושבת מאחורי `lg:` בכוונה — ב-`md:` היא הייתה גדולה
  מהמסך עצמו. `max-w-full` מבטיח שהפאנל לעולם לא חורג מה-viewport.
- Header gradient: `bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white`
- Custom X: `h-11 w-11 rounded-lg border border-white/25 bg-white/5 hover:bg-white/15`
- Body scroll: `flex-1 overflow-y-auto bg-slate-50/60 p-5`
- Footer sticky: `flex-none border-t border-slate-200 bg-white px-5 py-3` + ריווח תחתון
  `pb-[max(0.75rem,env(safe-area-inset-bottom))]`, ובמובייל שתי קבוצות הפעולות
  נערמות (`flex-col-reverse` → שמירה למעלה, ליד האגודל) וחוזרות לשורה אחת מ-`sm`.

### Sheet animation params (in `src/components/ui/sheet.tsx`)

- Overlay: `bg-slate-950/40 transition-opacity duration-[400ms] ease-out`
- Content: `shadow-2xl shadow-slate-900/30 transition duration-[1200ms] ease-[cubic-bezier(0.16,0.84,0.26,1)]`
- Translate: `-translate-x-full` (full off-screen entrance)
- Opacity: `0.4 → 1`

### Dialog (modal centered)

shadcn defaults — `sm:max-w-md` for forms.

```tsx
<Dialog open={...} onOpenChange={...}>
  <DialogContent dir="rtl" className="sm:max-w-md">
    <DialogHeader><DialogTitle>...</DialogTitle></DialogHeader>
    <div className="space-y-3">...</div>
    <DialogFooter className="gap-2">
      <Button variant="outline">ביטול</Button>
      <Button>שמור</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### AlertDialog (confirm דרך destructive)

```tsx
<AlertDialog open={...} onOpenChange={...}>
  <AlertDialogContent dir="rtl">
    <AlertDialogHeader>
      <AlertDialogTitle>האם לצאת ללא שמירה?</AlertDialogTitle>
      <AlertDialogDescription>...</AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>ביטול</AlertDialogCancel>
      <AlertDialogAction onClick={...} className="bg-destructive text-white hover:bg-destructive/90">
        צא ללא שמירה
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

---

## 13. Toasts (Sonner)

mounted ב-`src/app/layout.tsx`: `<Toaster richColors position="top-center" />`.

```tsx
import { toast } from 'sonner';
toast.success('הסטטוס עודכן');
toast.error(`שמירה נכשלה: ${msg}`);
toast.info('...');
```

- **תמיד** עברית קצרה (2-4 מילים).
- **תמיד** ב-success/error אחרי async mutations (PATCH/PUT/POST).
- **אסור** לשלוח `toast.success` בתוך פונקציה שגם יכולה לזרוק — תמיד `try/catch` + ערכים ידועים.

---

## 14. Sidebar

`src/components/app-shell/Sidebar.tsx` — תפריט צד ימני (RTL), **collapsible**. הקונפיג (`SECTIONS`/`SETTINGS_ITEM`), פונקציית הסינון `filterNav(role, can)`, והרינדור (`NavBrand`/`Section`/`NavLink`/`FooterButton`) חיים ב-**`src/components/app-shell/nav.tsx`** ונצרכים גם ע״י ה-drawer במובייל (§15) — **מקור אמת אחד לרשימה ולסינון**, אסור שתי רשימות שעלולות להיפרד.

- **Container**: `relative hidden shrink-0 flex-col border-l border-line bg-white transition-[width] duration-200 md:flex`. רוחב מתחלף: `w-[266px]` פתוח ↔ `w-[80px]` מכווץ.
- **Collapse state**: עצמאי בתוך הסיידבר בלבד (`useState` + `localStorage` key `almog:sidebar-collapsed`, נקרא ב-`useEffect` אחרי mount → SSR-safe, בלי hydration mismatch). הסיידבר מצר/מתרחב והתוכן זורם דרך `flex` — **אין נגיעה ב-AppShell / `<main>`**.
- **Edge toggle**: כפתור עגול `h-7 w-7` שרוכב על הקצה הפנימי (`absolute top-1/2 left-0 -translate-x-1/2`). אייקון `ChevronRight` יחיד שמסתובב `rotate-180` במצב מכווץ.
- **Brand block** (ראש הסיידבר): מיכל `flex h-16 shrink-0 items-center gap-3 border-b border-line` (`px-5`; מכווץ → `justify-center px-0`). **גובהו זהה ל-Header (`h-16`) וה-`border-b` תואם**, כך שהקו התחתון שלו והקו התחתון של ה-Header מתיישרים לקו רציף אחד לאורך ראש המסך (ראה §32). תוכן: לוגו-גרדיאנט `grid h-11 w-11 rounded-[13px] bg-gradient-to-br from-brand to-brand-dark text-white` + `Building2`, וכותרת `text-[22px] font-black tracking-tight text-ink` = "ניהול אלמוג". מכווץ → רק הלוגו, ממורכז.
- **רשימה אחידה** (ללא כותרות-סקשן): כל פריטי הניווט ברשימה שטוחה אחת — עבודה יומיומית + תקשורת קודם, אחריהם הגדרות-המערכת (סטטוסים, תבניות, אזורים, משתמשים). תמיכת הסקשנים נשמרה בקוד (`title` ריק → לא מרונדרת כותרת/קו): כדי לפצל שוב, מוסיפים entry ל-`SECTIONS` עם `title`. כל פריט עם ה-route + module שלו → RBAC 1:1 (פריט לא-מורשה פשוט מוסתר). **שני פריטים לפי תפקיד ולא לפי מודול** (`visible`, גובר על בדיקת ה-module): „לוח מחוונים” (`/overview`, כל תפקיד פרט לצופה) ו**„משתמשים”** (`/settings/users`, אדמין + סופר אדמין — `canOpenUsersScreen`, אותו predicate שסוגר את העמוד; 07/10/2026). שורת `users_management` במטריצה **לא** מציגה אותו.
- **קבוצות עם כותרת** (כמו „שקיפות כספית”, „פורטל בעלי דירות”): **„תפוצה”** (09/10/2026) — „תפוצה חדשה” (`/broadcasts/new`) · „תבניות” (`/whatsapp-templates`, עבר מהרשימה הראשית; ה-route לא השתנה) · „היסטוריה” (`/broadcasts/history`, כולל הפירוט `/broadcasts/history/[id]`). פריט יכול לדרוש פעולה אחרת מ-`view` דרך `action` — „תפוצה חדשה” מוצג רק עם `whatsapp_chat:edit`, אותו שער כמו העמוד וה-route.
- **Item**: `group flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors`. מכווץ → `justify-center px-0`.
  - **Active**: `bg-gradient-to-l from-brand-dark to-brand text-white shadow-[0_10px_20px_-9px_rgba(61,90,254,0.6)]` (אייקון `text-white`).
  - **Idle**: `text-ink-2 hover:bg-row-hover hover:text-ink` (אייקון `text-ink-3 group-hover:text-brand`).
  - **Disabled (בקרוב)**: `cursor-not-allowed text-ink-ghost` + Tooltip "בקרוב".
  - אייקון: `h-5 w-5 shrink-0`.
- **Badge** (אופציונלי, על פריט): `grid h-[21px] min-w-[21px] rounded-full px-1.5 text-[11.5px] font-extrabold`. וריאנטים: `default` (`bg-[#eef1f6] text-[#64748b]`), `warn` (`bg-[#fdecec] text-[#dc2626]`), `green` (`bg-[#e7f7ee] text-[#16a34a]`); על פריט active → `bg-white/25 text-white`. **חוק**: badge מוצג רק כשיש מקור נתונים אמיתי (`item.badge.count`). אסור מספר demo — היכולת קיימת אך רדומה עד שמחווט מקור.
- **Tooltip**: כל פריט במצב מכווץ (וכל פריט "בקרוב") עטוף ב-`Tooltip side="left"` עם ה-label.
- **Footer**: `border-t border-line-soft px-3.5 py-3` — `הגדרות` (פריט רגיל, מגודר במודול `settings`) + `התנתק` (`text-[#b91c1c] hover:bg-[#fdecec]`, אייקון `LogOut` `text-[#dc2626]`, קורא ל-`signOut()` מ-`useAuth`).
- **גריד**: `nav` עם `flex-1 overflow-y-auto overflow-x-hidden px-3.5`, פריטים `space-y-1`.

---

## 15. Header (Top bar)

`src/components/app-shell/Header.tsx` — סרגל עליון מלא-רוחב.

- **Container**: `flex h-16 shrink-0 items-center gap-4 border-b border-line bg-white/90 px-6 backdrop-blur`. יושב **בתוך אזור התוכן בלבד** — לא חוצה מעל הסיידבר (§32). הגובה `h-16` תואם לגובה ה-brand block בראש הסיידבר (§14) → הקווים התחתונים מתיישרים.
- **חיפוש** (RTL start / ימין): `<GlobalSearch />` בתוך `flex w-full max-w-[440px] items-center`. ה-slot הוא **טריגר ויזואלי** — `button` `h-11 rounded-[13px] border border-line bg-surface-2 pr-11 pl-2.5` עם אייקון `Search` ב-`absolute right-3.5 text-ink-3`, placeholder `text-ink-3`, ו-`kbd` `⌘K`/`Ctrl K` בקצה (מ-`sm:` ומעלה). לחיצה (או `⌘/Ctrl+K` גלובלי) פותחת את ה-Command Palette — ראה **§31 Global Search**. במובייל (`<md`) ה-slot **מוסתר** (`hidden md:flex`) כדי שההמבורגר יישאר נגיש ולא ייווצר צפיפות — ראה ניווט המובייל למטה.
- **`<div className="flex-1" />`** דוחף את הצד השני לקצה.
- **אזור פעולות** (RTL end / שמאל) `flex items-center gap-2.5`:
  - `NotificationBell` (הרכיב הקיים, badge אדום אמיתי מ-`/api/notifications/unread-count`) — מוצג רק כש-`role !== 'viewer'`.
  - אייקוני quick-link `צ׳אט פנימי` (→ `/chat`) ו-`צ׳אט וואטסאפ` (→ `/messages`), מגודרים ב-`can('internal_chat'|'whatsapp_chat','view')`. סגנון זהה לפעמון: `grid h-[38px] w-[38px] rounded-[10px] border border-line bg-surface-2 text-ink-2 hover:bg-row-hover`. **בלי badge** — אין מקור unread בהדר (החוק: בלי מקור → בלי badge).
  - מפריד `h-[30px] w-px bg-line` (רק אם יש אייקונים).
  - **User-pill**: `Popover`. Trigger = `flex h-[44px] items-center gap-2.5 rounded-[13px] border border-line bg-white` עם avatar `h-[34px] w-[34px] rounded-[10px] bg-brand-soft text-brand-text` (אות ראשונה), שם `text-[13px] font-extrabold` + תפקיד `text-[10.5px] text-ink-3`, ו-`ChevronDown` שמסתובב כשפתוח. הנתונים מהמשתמש המחובר (`useAuth`); התפקיד מ-`roleLabel(user.role)` (לעולם לא מהשם). תוכן ה-Popover: שם + badge תפקיד (`ROLE_STYLES`) + אימייל + כפתור `התנתק` אדום (`signOut`).
- ה-Brand עבר לסיידבר (§14); ההדר אינו מציג לוגו.
- **ניווט מובייל (drawer)**: `MobileNav` — כפתור המבורגר ב-RTL-start (לפני החיפוש), **`md:hidden` בלבד** (בדסקטופ הסיידבר מכסה; אפס כפילות). סגנון זהה לאייקוני ההדר: `grid h-[38px] w-[38px] rounded-[10px] border border-line bg-surface-2 text-ink-2 hover:bg-row-hover`, אייקון `Menu`. לחיצה פותחת `Sheet` עם **`side="right"`** (`w-[280px]`, `bg-white`, `showCloseButton={false}`) — נפתח מהקצה הפיזי הימני, **אותו צד של הסיידבר** (ב-`ui/sheet.tsx`, מבוסס base-ui, ה-`side` ממומש בתכונות CSS פיזיות `right-0`/`left-0` ולכן **אינו מתהפך לפי dir** — `side="right"` דטרמיניסטי). תוכן ה-drawer = אותם פריטים כמו הסיידבר דרך `nav.tsx`: `NavBrand` + `Section`/`NavLink` (active/disabled זהים) + פוטר `הגדרות`/`התנתק`. קליק על פריט קורא ל-`onNavigate` → סוגר את ה-Sheet. הסיידבר הדסקטופי נשאר `hidden md:flex`.

---

## 16. Tabs (DebtorsTabs pattern)

תאי-נווט בצורת כפתור-עם-counter. גריד רספונסיבי `grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2`.

- Active: `bg-{tone}-600 text-white` + counter `bg-white/25 text-white`
- Idle: `bg-white text-slate-700 border border-slate-200 hover:bg-slate-50` + counter `bg-{tone}-100 text-{tone}-700`
- Disabled: `cursor-not-allowed opacity-60`
- **חובה**: `cursor-pointer` על הכפתור (לפני ה-disabled CSS) כדי שהיד תופיע על טאבים פעילים.
- **ה-counter = הטבלה (06/10/2026).** המונה של כל טאב סופר בדיוק את השורות שהטאב מציג **תחת החיפוש הנוכחי**
  (`q` / `apt` של סרגל הכלים, שנשארים בכתובת גם במעבר טאב). בלי חיפוש — סך השלב כמו תמיד; עם חיפוש — המונים
  מראים באיזה טאב נמצא מי שחיפשו. אסור להחזיר מצב שבו המונה סופר את כל הבניין בזמן שהטבלה מסוננת
  (`getTabCounts(search)` ו-`listDebtors` חולקים predicate אחד).

---

## 17. Empty / Loading states

### Empty

```tsx
<div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
  אין נתונים להצגה. ייבוא ראשון יבצע אכלוס של הטבלה.
</div>
```

### Inline-empty (בתוך section)

```tsx
<p className="text-xs text-slate-400 py-2 text-center">אין הערות עדיין.</p>
```

### Skeleton card variants

- **KPI / section card**: `h-40 rounded-xl bg-muted/60 animate-pulse`
- **Entity list row** (sect 9b): `h-20 rounded-lg bg-muted/60 animate-pulse`
- **Inline thin line**: `h-4 w-{width} rounded bg-muted animate-pulse`

### Spinning icon (sync button)

```tsx
<RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
```

---

## 18. Auth screens

### AuthLayout

- Outer: `auth-gradient` (CSS class) + `flex min-h-screen w-full items-center justify-center px-4 py-10`
- Two-column desktop: `grid w-full max-w-6xl items-center gap-12 lg:grid-cols-2` (FeaturesCard ראשון = visual right ב-RTL)

### Forms

- Card: `w-full max-w-md justify-self-center p-8 md:p-10 shadow-xl`
- Form: `flex flex-col gap-5`
- Heading: `text-2xl font-extrabold` + subtitle `mt-1 text-sm text-muted-foreground`
- Input field group: `space-y-2` (Label + Input)
- Submit: `Button type="submit" className="w-full"`
- Separator with text: `relative` wrapper + `absolute inset-x-0 -top-2.5 mx-auto w-fit bg-card px-2 text-xs text-muted-foreground`

### FeaturesCard

- Headline: `text-3xl font-extrabold leading-snug`
- Feature item: `space-y-4` עם icon-circle `grid h-10 w-10 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-600`

### Password requirements list

- Container: `space-y-1`
- Valid: `text-emerald-600` + `<Check className="h-3.5 w-3.5" />`
- Invalid: `text-muted-foreground` + `<Circle className="h-3 w-3" />`

---

## 19. Wizards (Import / multi-step flows)

### Container

- `mx-auto max-w-3xl space-y-6`
- Page heading: `text-2xl font-extrabold` + subtitle

### Step cards

- Card: `Card className="p-8"` (או `p-10` לפעולה מרכזית)
- Header גרידא: `flex items-center gap-2 text-primary` + Icon + label

### File upload step

- Center column: `flex flex-col items-center gap-3 text-center`
- Icon circle big: `grid h-16 w-16 place-items-center rounded-full bg-muted text-muted-foreground`
- CTA: `Button className="mt-2 gap-2"`

### Mode selector (2 options)

- Grid: `grid grid-cols-1 gap-3 md:grid-cols-2`
- ModeOption כפתור:
  - Selected: `border-{tone}-500 bg-{tone}-50`
  - Unselected: `border-{tone}-200 bg-{tone}-50/50 hover:bg-{tone}-50`
  - Radio circle: `grid h-5 w-5 place-items-center rounded-full border-2 border-{tone}-500`

### Stat boxes (preview)

- `rounded-md border p-4 text-center {tone}` עם value `text-2xl font-extrabold`.

### Progress bar (running)

```tsx
<div className="rounded-md border bg-blue-50 p-4">
  <div className="flex items-center justify-between text-sm">
    <span className="font-medium text-blue-900">מעבד...</span>
    <span className="text-blue-900 font-semibold">{pct}%</span>
  </div>
  <Progress value={pct} className="mt-3" />
  <div className="mt-2 text-xs text-center text-blue-800">{processed}/{total}</div>
</div>
```

### Step navigation

- `flex items-center justify-between`
- Back: `variant="outline"` + `<ArrowRight />` (RTL → ימין = "חזור")
- Next: Primary + `<ArrowLeft />` (RTL → שמאל = "הבא")

### Replace confirmation (destructive flow)

- 2-stage Dialog (confirm prompt → admin password input)
- Icon circle: `grid h-12 w-12 place-items-center rounded-full bg-red-100 text-red-600` + AlertTriangle
- Confirm button: `bg-red-600 hover:bg-red-700 text-white`

---

## 20. RTL conventions

- **Logical positioning**: `start-*`, `end-*`, `ms-*`, `me-*`, `pe-*`, `ps-*`.
- **Text alignment**: `text-start` / `text-end` עדיף על `text-right` / `text-left` ברוב המקרים.
- **Icons direction**: לא להשתמש ב-`<ChevronRight>` כשמתכוונים ל"הבא" — ב-RTL "הבא" = שמאל = `<ChevronLeft>`.
- **Numbers / phones**: תמיד עוטפים ב-`dir="ltr"` + `tabular-nums`. כך גם `₪ 9,280` — `dir="ltr"` על התא כדי שה-₪ ישב לפני המספר.
- **Sheet side**: לפי המוסכמה הנוכחית — `side="left"` עם רוחב `sm:w-[55vw]` ואנימציה מ-off-screen-left.

---

## 21. Animation guidelines

- Sheets: 1200ms עם `cubic-bezier(0.16,0.84,0.26,1)` (premium feel).
- Backdrops: 400ms `ease-out` (מהיר, מוכן לאינטראקציה).
- Hover transitions: `transition-colors` בלבד (לא transform).
- Spinners: `animate-spin` רק על אייקון בודד באקטיביות (sync, loading).
- Skeletons: `animate-pulse` על placeholders.
- **לא**: `shadow-2xl` קופצני ב-hover, gradients זוהרים, micro-interactions מוגזמות.

---

## 22. Disabled & Loading states

| מצב | UI |
|---|---|
| Button disabled (Tooltip "בקרוב") | shadcn default או neutral gray (לא צבעוני) |
| Form field disabled | shadcn default `disabled:opacity-50 disabled:bg-input/50` |
| Save button בלי dirty | `disabled` + tooltip אופציונלי |
| Loading button | טקסט "שומר…" + disabled |
| Input loading | spinner ב-`absolute end-3 top-1/2 -translate-y-1/2` |

---

## 23. Misc patterns

- **`<kbd>`** keyboard shortcut: `rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-500`
- **Avatar** with initials: `h-9 w-9 rounded-full bg-blue-100 text-blue-700 text-xs font-bold` + 2-letter initials
  - **WhatsApp messages variant** (`messages/components/ChatAvatar.tsx`): `h-10 w-10` עם פלטת ה-WhatsApp הירוקה (`bg-emerald-100 text-emerald-700`); קבוצה → `bg-sky-100 text-sky-600` + אייקון `Users`. כשיש תמונת פרופיל מ-Green API מציג `<img object-cover>` עם `onError` שנופל חזרה לראשי-התיבות (קישורי ה-CDN פגים). זוהי וריאציה מכוונת של מודול ה-WhatsApp — לא להחליף לכחול.
- **Tooltip on disabled button**: לעטוף עם `<TooltipTrigger render={<span className="block" />}>` כדי שה-`disabled` button לא יבלע את ה-pointer events.
- **Active dot** (status indicator): `inline-flex items-center gap-1.5 text-xs text-slate-600` עם `<span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />` (פעיל) או `bg-slate-400` (מושבת/לא פעיל). הצמד טקסט "פעיל"/"מושבת" אחרי הנקודה. בשימוש ב-Entity List Cards (sect 9b).

---

## 24. Email templates

מיקום: `src/templates/email/<name>.ts`. כל template הוא פונקציה שמקבלת
ארגומנטים ומחזירה `{ subject, html, text }`. כל template חייב להיות
רשום ב-`src/lib/email-templates.ts` תחת `renderTemplate()` עם טיפוס
`EmailTemplateName` מורחב.

### כללי HTML למייל

- **inline CSS בלבד** — אין `class`, אין `<style>`, אין Tailwind. רוב
  קליינטי המייל מתעלמים או חוסמים את אלה.
- **hex equivalents** במקום Tailwind tokens (Tailwind לא קיים בקונטקסט
  של המייל):

  | Token | Hex |
  |---|---|
  | `blue-600` | `#2563eb` |
  | `blue-700` | `#1d4ed8` |
  | `slate-900` | `#0f172a` |
  | `slate-500` | `#64748b` |
  | `slate-400` | `#94a3b8` |
  | `slate-200` | `#e2e8f0` |
  | `slate-100` | `#f1f5f9` |
  | `slate-700` | `#334155` |

- `<body dir="rtl" style="font-family:'Heebo',Arial,sans-serif;">` חובה
  על תג ה-body. גם על `<a>` של ה-CTA — חלק מהקליינטים לא יורשים
  font-family לתוך לינקים.
- **Heebo לפי שם בלבד, בלי `<link>` לפונט חיצוני** (מ-03/10/2026 — אין
  תלות ב-Google Fonts בשום מקום בפרויקט). קליינט שיש בו Heebo יציג
  אותו; האחרים נופלים ל-Arial וזה בסדר (Gmail/Outlook web ממילא לא
  טענו את ה-link).
- **Layout**: outer `<table width="100%">` + inner `<table width="600">`
  ממורכז. **לא** `<div>` — Outlook (במיוחד desktop) לא מבין flex/grid.
  ה-Tables משתמשות ב-`role="presentation"` כדי לא לבלבל screen readers.
- **CTA button**: `<a>` עם `display:inline-block` + `background:#2563eb`
  - `color:#ffffff` + `padding:12px 32px` + `border-radius:8px` +
  `font-weight:700` + `text-decoration:none`. אין `<button>` — לא נתמך
  בקליינטים רבים.
- **לוגו = טקסט בלבד** ("אלמוג", `font-size:28px; font-weight:800;
  color:#0f172a`). אין `<img>` — Gmail חוסם תמונות מ-senders לא
  מאומתים, פחות נקודות כשל ופחות סיכון להיכנס לספאם.
- **escape ל-HTML** של כל מחרוזת user-supplied (`userName` וכד') לפני
  הזרקה לתבנית — ראה `escapeHtml()` ב-`reset-password.ts`.

- **מייל של תפוצה** (`src/templates/email/broadcast.ts`, 09/10/2026): הטקסט של המפעיל כמו שהוא — escape מלא,
  שבירות שורה → `<br>`, בתוך אותה מסגרת (לוגו טקסט, טבלה 600, footer) — בלי פנייה ובלי CTA. התבנית **טהורה**
  (מקבלת `site` במקום `appUrl()`), כי ה-worker מרנדר אותה מחוץ ל-Next; ה-footer שלה מ-`footer-core.ts`.

### Plain-text version (חובה)

כל template מחזיר **גם** `text` (גרסת plaintext) ולא רק `html`. סיבה:
deliverability — קליינטי spam-filters מורידים את ה-score לרסיברים שלא
שולחים `text/plain` במקביל ל-`text/html` ב-multipart. ה-`text` חייב
לכלול את ה-`resetUrl` (או כל לינק רלוונטי) במלואו, גלוי לקריאה.

### Sending mechanics

`sendWithRetry({ to, subject, html, text })` מ-`src/lib/email/send.ts`:

- Pool דרך `getTransporter()` ב-`src/lib/email/transporter.ts` (singleton
  על `globalThis` עם hash-cache של user+pass+fromName).
- 3 ניסיונות סך הכל (initial + 2 retries) עם backoff `1s, 2s` רק על
  שגיאות transient (`ETIMEDOUT/ECONNRESET/ECONNREFUSED/ESOCKET/EDNS/
  EHOSTUNREACH` או SMTP 4xx). Auth failures (`EAUTH`) ו-SMTP 5xx →
  throw מיידי.

### Settings

הגדרות ה-SMTP נטענות מ-DB (`app_settings.smtp`); אם אין רשומה — fallback
ל-env (`SMTP_USER` / `SMTP_PASS` / `SMTP_FROM_NAME`). `SMTP_HOST=smtp.gmail.com`
ו-`SMTP_PORT=587` קבועים בקוד (Gmail-only). App Password נשמר ב-DB
מוצפן AES-256-GCM עם `SETTINGS_ENC_KEY`.

---

## 25. Permissions model

המערכת משתמשת ב-2 רמות הרשאה למודול: **צפייה** (view) ו-**עריכה** (edit).

- **צפייה** — פתיחת המודול, קריאת נתונים, ייצוא בסיסי לתצוגה.
- **עריכה** — כל פעולת mutation במודול: יצירה, עדכון, מחיקה, שליחת
  הודעות חיצוניות (WhatsApp/SMS/Email), ייצוא נתונים גולמי. אם
  המשתמש יכול לערוך — הוא יכול לעשות את כל מה שניתן לעשות במודול.

**אין רמת "מחיקה" נפרדת**. ההפרדה הקודמת (view/edit/delete) נמצאה
overengineered — כל מודול מטופל יחידה, וההבחנה בין "עורך טקסט" ל-
"מוחק שורה" לא מצדיקה שדה DB נפרד.

### UI implications

- ב-`PermissionMatrix` יש 2 עמודות בלבד: "צפייה" / "עריכה".
- כפתורי delete/destructive בתוך מודול נפתחים תחת אותו gate של edit.
- ה-Sidebar מסונן לפי view (מודולים ללא view מוסתרים), פרט לפריטים לפי תפקיד (§14: לוח מחוונים, משתמשים).

### Checkbox vs Switch in the matrix

המטריצה משתמשת ב-**תיבות סימון (Checkbox)** ולא ב-Switch. Checkbox
מתאים לבחירה של הרשאה (selection — האם להעניק את ההרשאה הזו), Switch
מתאים להגדרה דחופה (state toggle — האם תכונה פעילה כעת). הרשאות הן
configuration שנקבעת לפני submit / שמירה — ולכן Checkbox.

### Code shape

- `Action = 'view' | 'edit'`
- `ModulePermission = { module, canView, canEdit }`
- `hasPermission(role, perms, module, action)` — super_admin: true תמיד;
  admin: true פרט ל-`SUPER_ADMIN_ONLY`; manager/viewer/cleaner/maintenance (`isMatrixRole`): לפי המטריצה.
  `PUT /api/users/[id]/permissions` שומר לכל תפקיד מטריצה — גם לעובד שטח (עד 10/10/2026 רק מנהל וצופה,
  והמטריצה של עובד בפאנל ענתה 400 על כל סימון).
- `canGrantModule(actorRole, module)` (07/10/2026) — מי רשאי לקבוע מודול במטריצה של
  משתמש אחר (הענקה **וגם** שלילה): סופר אדמין — הכול; אדמין — הכול פרט ל-
  `MATRIX_MANAGEMENT_MODULES` (`users_management`, `roles_management`, `settings` —
  קבוצת הניהול נקבעת לפי תפקיד); כספים ופורטל (`finance`, `portal_*`) נשארים פתוחים
  לאדמין. נאכף ב-`PUT /api/users/[id]/permissions` וב-`permissions` של
  `POST /api/users` (403), ובמטריצה עצמה (שורות נעולות).
- `canOpenUsersScreen(role)` — מסך המשתמשים לפי תפקיד (אדמין + סופר אדמין), לעמוד ולתפריט.

### Matrix component modes

ה-`PermissionMatrix` תומכת בשני מצבים:

- **Auto-save** (UserSidePanel): רק `userId` + `permissions` + `onMutated`.
  כל toggle שולח `PUT /api/users/{userId}/permissions` ומציג toast.
- **Controlled** (InviteUserPanel): `value` + `onChange`. הקומפוננטה לא
  מבצעת קריאת API ולא מציגה toast — ה-parent מחזיק state ושולח כשהוא
  מוכן (למשל יחד עם invite creation).

בשני המצבים `actorRole` (חובה) — מי עורך. מודול ש-`canGrantModule(actorRole, …)` שולל
(לאדמין: משתמשים / הרשאות / הגדרות) מוצג **נעול**: הערך הנוכחי נשמר, שתי תיבות הסימון
`disabled`, ובתא שם המודול — `flex flex-wrap items-center gap-x-2`, השם ולצידו
`text-xs font-normal text-slate-500` „סופר אדמין בלבד”. בלי tooltip ובלי צבע חדש.

### כרטיס הזמנה ממתינה — פעולות לפי סמכות (07/10/2026)

אייקוני „שלח שוב” / „בטל הזמנה” ב-`InviteCard` מוצגים רק כש-`canManage`
(`canManageRole(currentUserRole, invite.role)`): סופר אדמין — כל הזמנה; אדמין — הזמנה למנהל /
צופה / עובד ניקיון / עובד אחזקה. הזמנה לאדמין או לסופר אדמין מוצגת לאדמין **לקריאה בלבד** —
אותו כרטיס בלי אייקוני הפעולה (ה-routes עונים 403 בכל מקרה).

### בחירת תפקיד — אין ברירת מחדל, ושינוי תפקיד לכל תפקיד שבסמכות (10/10/2026)

- **„צור משתמש” (`InviteUserPanel`) נפתח בלי תפקיד:** אף כרטיס ב-`RoleSelector` לא מסומן
  (`value={null}`; כרטיס נבחר = `aria-pressed="true"`), מתחת לכרטיסים `text-xs text-slate-500`
  „בחר תפקיד — אין ברירת מחדל. המשתמש יישמר בדיוק בתפקיד שבחרת.”, ומטריצת ההרשאות / הודעת
  „אינו משתמש במטריצה” מוצגות רק אחרי הבחירה. „צור משתמש” מושבת עד שנבחר תפקיד.
  **למה:** עד 10/10 הטופס נפתח על „מנהל”, ולחיצה שלא נקלטה שלחה `manager` — כך עובד אחזקה
  חדש נכנס ב-09/10 כמנהל עם מטריצת מנהל מלאה.
- **ה-toast נוקב בתפקיד שהשרת שמר** (ה-route מחזיר `role`): „המשתמש נוצר — עובד אחזקה” /
  „המשתמש נוצר והוזמן — עובד אחזקה”; ובשינוי תפקיד בפאנל המשתמש: „התפקיד עודכן — עובד אחזקה”.
- **רשימת התפקידים = מה שהעורך רשאי להקצות** (`canManageRole`): סופר אדמין — כל השישה; אדמין —
  מנהל / צופה / עובד ניקיון / עובד אחזקה. `PATCH /api/users/[id]` מקבל כל תפקיד אמיתי
  (`ROLE_VALUES`) ומשאיר את ההחלטה מי רשאי ל-`canManageRole` — עד 10/10 רשימה קשיחה מיוני
  ענתה 400 „תפקיד לא תקין” לכל מעבר לעובד ניקיון / אחזקה.

### פאנל משתמש מחוץ לסמכות — הודעה וקריאה בלבד (10/10/2026)

כשהעורך פותח משתמש שאינו בסמכותו (`!canManageRole(currentUserRole, user.role)` — אדמין על אדמין,
על סופר אדמין או על עצמו), מעל הטאבים מוצג באנר אזהרה לפי §8
(`role="note"`, `mb-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900`):

- על משתמש אחר: „אין לך הרשאה לנהל משתמש בתפקיד „<תפקיד>”. אדמין מנהל רק משתמשים בתפקידים
  שמתחתיו: <הרשימה, מ-`canManageRole`>. הפרטים מוצגים לקריאה בלבד.”
- על החשבון של עצמו (אדמין): „זה החשבון שלך. את הפרטים, התפקיד והסטטוס של חשבון אדמין משנה רק
  סופר אדמין.”

השדות „שם מלא” ו„טלפון” `disabled` כמו שאר הפעולות (תפקיד, השבתה, Google), כך ש„שמור שינויים”
נשאר מושבת — במקום 403 שהגיע רק אחרי שמירה. ה-routes עונים 403 בכל מקרה.

### מחיקת משתמש לצמיתות (`UserSidePanel`, 06/10/2026)

פעולה נפרדת ומובחנת מהשבתה, בטאב „פרופיל” של פאנל המשתמש, **לסופר אדמין בלבד**
(`canDeleteUsers` — allowlist `USER_DELETE_ROLES`, לא מודול במטריצה; אדמין לא רואה אותה):

- **Section** משלה אחרי „כניסה עם Google”: כותרת „מחיקה לצמיתות”, אייקון `Trash2`, `iconTone="rose"`.
  שורת הסבר `text-xs text-slate-500`: „בלתי הפיך — בניגוד להשבתה. תוכן שהמשתמש כתב יישאר במערכת עם שמו.”;
  על החשבון של עצמך: „אי אפשר למחוק את החשבון שלך.” והכפתור מושבת.
- **הכפתור:** `Button variant="destructive"` (אדום מלא `#e5484d` — לא ה-outline האדום של „השבת”),
  `Trash2 h-4 w-4` + „מחק לצמיתות”, `min-h-11` (Touch Target).
- **האישור:** `AlertDialog` לפי §12 — „למחוק את המשתמש לצמיתות?”, התיאור אומר במפורש: הפעולה בלתי
  הפיכה, החשבון יימחק והמשתמש לא יוכל להתחבר, ותוכן שכתב יישאר עם שמו. „חזור” / „מחק לצמיתות” (destructive,
  „מוחק…” בזמן הבקשה). ESC סגור בזמן המחיקה.
- **אחרי:** toast „המשתמש נמחק לצמיתות”, הפאנל נסגר, `router.refresh()` — הרשימה ומוני טאבי התפקידים
  מתעדכנים מה-props. שגיאת שרת (403/409) מוצגת כ-toast עם הנוסח מהשרת.
- בטאב „ממתינים” ההסרה לצמיתות היא „בטל הזמנה” הקיים (מוחק את שורת ההזמנה; סופר אדמין — וגם אדמין,
  להזמנה לתפקיד שבסמכותו, מ-07/10/2026).

---

## 26. WhatsApp template editor (composer panel)

דפוסי ה-UI של חלונית עריכת/יצירת תבנית WhatsApp
(`whatsapp-templates/components/WhatsAppTemplateSheet.tsx`). אזור התוכן
של הפאנל בנוי כ-2 עמודות עם **container query**: טופס מימין, תצוגה
מקדימה חיה משמאל. `<div className="@container">` עוטף
`grid gap-6 @2xl:grid-cols-[minmax(0,1fr)_19rem]` (מתחת לרוחב הזה — נערם).
רקע הגוף: `bg-surface-2`. מרווח בין שדות: `space-y-6`.

### Field label (variant פאנל מותגי)

תווית מודגשת לפאנלי composer: `text-[13.5px] font-bold text-ink-2`, כוכבית
חובה `<span className="text-[#e5484d]">*</span>`. (וריאציה ל-§6; ה-label
הסטנדרטי נשאר `text-base font-medium text-muted-foreground`.)

### שדות מותגיים (Input / Textarea)

`border-[1.5px] border-line bg-white text-sm placeholder:text-ink-ghost`
- focus ring מותגי (§2). Textarea: `min-h-[184px] resize-none leading-[1.85]`.

### Variable insert chips (pills מעל ה-textarea)

כפתורי הזרקת `{{var}}` למיקום הסמן (הלוגיקה ב-`insertPlaceholder`). pill
מלא רדיוס:

```tsx
<button className="inline-flex items-center gap-1 rounded-full border border-brand-border bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand-text transition-colors hover:border-brand hover:bg-brand hover:text-white hover:shadow-soft-sm disabled:opacity-50">
  <span>{label}</span> <Plus className="h-3 w-3 opacity-70" />
</button>
```

Hover = מילוי מותג מלא + טקסט לבן + צל רך. **ללא transform/lift** (כלל §21).

### שורת "משתנים נתמכים"

`flex flex-wrap items-center gap-1.5 rounded-[7px] border border-line-soft bg-surface-2 px-3 py-2`,
טקסט `text-xs text-ink-3`, וכל token כתג: `rounded-[5px] border border-line bg-white px-1.5 py-0.5 font-num text-[11px] text-ink-2` עם `dir="ltr"`.

### Active toggle card + Switch גדול

כרטיס מתג סטטוס: `rounded-xl border p-4`. פעיל = `border-[#beedcf] bg-gradient-to-bl from-[#e9fbf0] to-white`; כבוי = `border-line bg-white`. כותרת `text-sm font-bold text-ink` + הסבר `text-xs text-ink-2`.
ה-`Switch` תומך ב-`size="lg"` (52×30, ידית 24px) — תוספת additive ל-
primitive (`ui/switch.tsx`); ברירת המחדל ללא שינוי. כאן עם `className="data-checked:bg-[#16a34a]"` (ירוק = פעיל).

### WhatsApp message preview (תצוגה מקדימה חיה)

render טהור של תוכן ה-textarea — ללא interpolation; `{{var}}` מודגשים. כותרת `<Eye/> תצוגה מקדימה`. כרטיס טלפון: `overflow-hidden rounded-xl border border-line shadow-soft-md`.
פלטת WhatsApp (tokens חדשים, ייחודיים לפריוויו זה):

| חלק | ערך |
|---|---|
| פס עליון (gradient) | `from-[#075e54] to-[#054c44]` + `text-white`, אווטאר `bg-white/15` |
| רקע צ'אט | `#e5ddd5` + טקסטורת נקודות (`radial-gradient` inline, `14px`) |
| בועה | `bg-[#dcf8c6]`, רדיוס 12 עם פינה תחתונה-מובילה חדה (`rounded-es-[3px]`), `me-auto max-w-[88%]` |
| טקסט בועה | `text-[14px] leading-[1.7] text-[#111b21]` |
| highlight של `{{var}}` | `rounded bg-brand-soft px-1 font-num font-semibold text-brand-text` |
| חותמת + ✓✓ | `text-[#667781]`, שעה ב-`font-num`, `<CheckCheck/>` |

---

## 26b. קבצים מצורפים לתפוצה (טאב „תפוצה חדשה” — בשני הערוצים; במייל סה״כ 25MB, ראה §26e)

מתחת ל„תוכן ההודעה” — **גם בטופס התפוצה וגם במסך „שליחת הודעת WhatsApp” לנמען בודד**
(`components/whatsapp/AttachmentPicker.tsx`, קומפוננטה אחת משותפת: `maxFiles` ו-`uploadUrl`
הם props — 10 קבצים ל-`/api/whatsapp/campaigns/attachments` בתפוצה, 5 ל-
`/api/whatsapp/messages/attachments` בהודעה בודדת).
מבנה זהה לפאנל העלאת המסמכים (`documents/UploadPanel.tsx`) — **לא וריאציה חדשה**:

- **תווית** `text-base font-medium text-muted-foreground` („קבצים מצורפים”).
- **Dropzone** = כפתור מלא-רוחב `rounded-xl border-2 border-dashed px-6 py-6 text-center`;
  מנוחה `border-line-strong bg-surface-2`, hover/drag `border-brand bg-brand-soft/…`;
  עיגול-אייקון `h-11 w-11 rounded-full bg-brand-soft text-brand` (`CloudUpload`), כותרת
  `text-sm font-semibold text-ink` עם `Paperclip` („צרף קבצים” — **לשון רבים**: הכפתור
  היחיד בצ׳אט (`messages/ChatThread.tsx`) נקרא „צרף קובץ” ומעלה קובץ אחד, ומשתמשים בלבלו
  ביניהם), רמז `text-xs text-ink-3`.
  מתחתיו שורת עזר `text-xs text-muted-foreground` עם הסוגים והמגבלות מ-`WHATSAPP_ATTACHMENT_LIMITS`
  (`src/lib/constants/whatsappAttachments.ts` — מקור-האמת היחיד למגבלות, משותף ללקוח ולשרת).
- **שורת קובץ** (staged): `flex items-center gap-3 rounded-lg border border-line bg-white p-3`;
  אייקון-קובץ `h-9 w-9 rounded-lg` בטון לפי MIME (`fileMeta` מ-`documents/helpers`), שם `text-sm font-medium`
  (truncate), גודל `font-num tabular-nums text-xs text-slate-500`; בזמן העלאה `<Progress>` + אחוז;
  שגיאה = error state של §6 (`border-red-400 bg-red-50`) + הודעה `text-[12px] font-semibold text-red-500`;
  הצלחה = „הועלה” ירוק. **X להסרה** — `h-11 w-11` (Touch Target).
- **מונה** `N/10` (`font-num tabular-nums text-xs text-muted-foreground`) בשורת התווית מרגע
  שיש קובץ; ב-10 קבצים ה-dropzone מושבת והרמז מתחלף ל„הגעת למקסימום 10 קבצים…”.
- כפתור השליחה מושבת בזמן העלאה ומציג „מעלה קבצים…” עם spinner (§22).
- **בתצוגה המקדימה** של ההודעה הבודדת: שורת `Paperclip` + שם לכל קובץ, מתחת לטקסט.
- **בהיסטוריה / בפרטים** (`components/whatsapp/AttachmentLinks.tsx` — משותף לתפוצה
  ולהיסטוריית ה-WhatsApp של הדייר): chips `rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs`
  עם אייקון-MIME קטן (`h-5 w-5 rounded`), שם (truncate `max-w-[160px]`) וגודל `font-num text-slate-400`;
  כל chip הוא `<a target="_blank">` ל-proxy המאומת `/api/files/whatsapp-attachments/<key>`. לפני הרשימה
  תג ספירה `Paperclip` + „N קבצים”. מוצג מתחת לשם התפוצה (שורת טבלה / כרטיס מובייל) ומתחת לכותרת הפרטים.

## 26c. תזכורת — תיאור וקבצים מצורפים (פאנל „תזכורת חדשה” / „עריכת תזכורת”, 05/10/2026)

מקור: `ref/Reminder Dialog (standalone).html` (מתוחזק על הדיסק, `ref/` ב-.gitignore). שני השדות
יושבים ב-Section „פרטי התזכורת”, **מיד מתחת ל„כותרת”** ולפני שורת תאריך/שעה.
קוד: `components/user-reminders/ReminderFormPanel.tsx` + `ReminderAttachments.tsx`; מנוע ההעלאה
משותף עם §26b (`lib/hooks/useStagedUploads.ts`) — **מראה אחר, אותו מנוע**.

- **שורת תווית** (לשני השדות): `flex items-baseline justify-between` — התווית הרגילה (§6) ומשמאל
  `text-xs text-muted-foreground` „רשות”; בקבצים, מרגע שיש קובץ, „רשות” מתחלף במונה `N / 10`
  (`font-num tabular-nums`).
- **תיאור:** `Textarea` `min-h-[110px] rounded-[10px] px-3.5 py-2.5 leading-relaxed`, focus מותגי
  (`focus-visible:border-brand ring-[3px] ring-[rgba(61,90,254,0.12)]`), `maxLength` 1000,
  placeholder „פרטים נוספים, הקשר, מה צריך לעשות…”. מתחתיו שורת עזר `text-xs text-slate-400`
  `justify-between`: „יוצג גם למשתמש המשויך” (רק כשיש טקסט) ↔ מונה `N / 1000` (`font-num`).
- **Dropzone (אופקי — שונה מ-§26b בכוונה, לפי ה-ref):** כפתור מלא-רוחב
  `flex items-center gap-3.5 rounded-xl border-[1.5px] border-dashed border-brand-border bg-surface-2 p-4`;
  גרירה מעל = `border-solid border-brand bg-brand-soft`. אייקון `Paperclip` ב-`h-10 w-10 rounded-[10px]
  bg-brand-soft text-brand`; כותרת `text-sm font-semibold text-slate-700` + `small text-xs text-slate-400`;
  בקצה pill „בחירת קבצים” (`Plus`, `h-[38px] rounded-[9px] border-brand-border bg-white text-brand-text`)
  — **span בתוך הכפתור**, לא כפתור מקונן (כל האזור לחיץ ⇒ Touch Target מתקיים).
  **Mobile:** `flex-wrap` + טקסט `min-w-40 flex-1` + pill `w-full sm:w-auto` — מתחת ל-`sm` ה-pill יורד
  לשורה משלו ברוחב מלא (אחרת הרמז נדחס לעמודה של ~120px וה-dropzone מגיע ל-220px גובה ב-390px);
  מ-`sm` ומעלה שורה אחת כמו ב-ref.
  טקסטים: רשימה ריקה „גררו קבצים לכאן” + „PDF, תמונות, Word, Excel · עד 10 קבצים, 20MB לקובץ”;
  יש קבצים „הוספת קבצים נוספים” + „גררו לכאן או בחרו מהמחשב”; 10 קבצים = מושבת, „הגעת למקסימום 10 קבצים”.
- **שורת קובץ:** `flex items-center gap-3 rounded-lg border border-line bg-white p-3` (p-3 = מינימום
  List Item, גובר על 9/12px של ה-ref). תג סוג `h-9 w-9 rounded-lg font-num text-[10.5px] font-bold`
  עם הסיומת (PDF / JPG / DOCX): PDF `bg-rose-50 text-rose-700`, תמונה `bg-emerald-50 text-emerald-600`,
  שאר המסמכים `bg-brand-soft text-brand-text`. שם `text-sm font-semibold text-ink truncate`;
  מטא `text-xs text-slate-400`: `284 KB · הועלה 18/06`.
  - **בהעלאה:** פס `h-1 rounded-sm bg-line` עם מילוי `bg-brand` + „מעלה… 62%”; פעולה X „ביטול”.
  - **נדחה (סוג / גודל):** error state של §6 (`border-red-400 bg-red-50`, גובר על הוורוד הבהיר של
    ה-ref) + `text-[12px] font-semibold text-red-500` „הקובץ גדול מ-20MB · לא הועלה”; **X בלבד**.
  - **כשל רשת:** אותה שורה אדומה + `RotateCw` „ניסיון חוזר” לפני ה-X — **רק** בכשל רשת.
  - **שמור:** `Download` („הורדה”, `<a target="_blank">` ל-proxy `/api/files/reminder-attachments/<key>`)
    + `Trash2` אדום („מחיקה”, AlertDialog „למחוק את הקובץ?” — מוחק מיד, כמו §26b/finance).
  - כפתורי הפעולה `h-11 w-11` (Touch Target — גובר על 36px של ה-ref).
- **צופה (בלי `user_reminders:edit`):** הרשימה עם הורדה בלבד — בלי dropzone ובלי מחיקה; אין קבצים =
  `text-sm text-muted-foreground` „אין קבצים מצורפים”.
- **משויך שאינו היוצר (06/10/2026):** הפאנל נפתח **לקריאה בלבד חוץ מהסטטוס** — כל שדה `disabled` מלבד ה-Select
  של הסטטוס; הקבצים כמו אצל צופה (הורדה בלבד, בלי dropzone ובלי מחיקה); תת-כותרת „תזכורת ששותפה איתך — רק
  היוצר עורך אותה. אפשר לעדכן את הסטטוס.”; „שמור שינויים” פעיל רק כשהסטטוס השתנה (אחרת `saveDisabledReason`
  „רק הסטטוס ניתן לשינוי — שאר השדות של היוצר”) ושולח `{status}` בלבד. **בכרטיס:** „סמן כהושלם” נשאר, **הפח
  מוסתר** (`canDelete` = יוצר בלבד). הכלל: `lib/userReminders/access.ts` (`reminderRole`) — אותו predicate
  בשרת ובלקוח; `forbidden` מהשרת → „אין הרשאה לפעולה הזו — רק יוצר התזכורת עורך ומוחק אותה”.
- **כותרת הפאנל / footer:** תת-כותרת „כותרת, תיאור, קבצים, מועד, סטטוס, קטגוריה ושיוך.”; placeholder
  הכותרת „למשל: לחזור לדייר בנושא חוב”; כפתור יצירה „יצירת תזכורת” עם `Plus` (`PanelFooter saveIcon`),
  עריכה „שמור שינויים”; בזמן העלאה „מעלה קבצים…” ומושבת. רמז השיוך: „…כולל התיאור והקבצים.”

---

## 26d. רשימת התזכורות — סדר אישי בגרירה (06/10/2026)

ההכרעה על ה-HARD STOP מ-06/10: **הסדר הוא של כל משתמש לעצמו** (`public.user_reminder_order`, שורה לכל
משתמש×תזכורת), לא של התזכורת — גרירה אצל משתמש א׳ לא מזיזה כלום אצל ב׳ גם בתזכורת משותפת.
קוד: `components/user-reminders/ReminderList.tsx` (הרשימה), `lib/userReminders/order.ts` (החשבון),
`PUT /api/user-reminders/order`.

- **איפה גוררים:** בטאבים „שלי” ו„משותף איתי” בלבד. „פתוחים” / „הושלמו” מציגים את **אותו** סדר (הם
  מערבבים את שני הטאבים) ואינם נגררים.
- **הסדר:** המוצבים קודם לפי `position`, אחריהם מי שאין לו שורה **לפי `remind_at` כמו עד היום**, ולבסוף לפי
  `id` (בלי ריצוד בזמנים שווים). תזכורת חדשה נופלת לסוף, יהיה מועדה אשר יהיה. בשחרור הטאב **כולו** מקבל
  `0..n-1`; כשמסנן קטגוריה מסתיר חלק מהכרטיסים, הנחיתה מחושבת על הטאב המלא (`reorderIds`): הכרטיסים
  המוסתרים שומרים את מקומם, ו„תחתית” = מתחת לכרטיס **הנראה** האחרון.
- **מראה ותנועה — זהים לקנבן התקלות (§37):** כרטיס נגרר `cursor-grab select-none active:cursor-grabbing
  [-webkit-touch-callout:none]`; **פס אחיזה** (`components/dnd/DragGrip.tsx` — אותו רכיב בקנבן: רצועת 26px
  עם 2×3 נקודות `bg-slate-50`/`bg-slate-300`, `group-hover` מכהה) צמוד לפס הצבע של הקטגוריה לכל גובה
  הכרטיס (`-my-4 -ms-3.5 self-stretch`); בזמן גרירת עכבר הכרטיס `opacity-50`; הכרטיס שמעליו ינחת
  `ring-2 ring-blue-300`; נחיתה בתחתית — פס `h-1 rounded-full bg-blue-300` מתחת לכרטיס האחרון; שחרור
  במקום הנוכחי — בלי סימון ובלי בקשה לשרת. גרירה לא פותחת את הפאנל; לחיצה פותחת.
- **מגע:** לחיצה ארוכה (~500ms, סבילות ~10px, `useLongPressDrag`) מרימה את הכרטיס — `relative z-30
  scale-[1.02]` + צל ה-hover, `transition-none` — והוא עוקב אחרי האצבע אנכית; ליד קצה אזור הגלילה הרשימה
  נגללת לבד; שחרור מחוץ לרשימה = ביטול. אותו `lib/dnd/landing.ts` (`landingAboveIn`, `scrollParent`) לעכבר,
  למגע ולקנבן.
- **כשל שמירה:** toast „שמירת הסדר נכשלה: …”, הרשימה חוזרת לסדר הקודם ונטענת מחדש מהשרת.
- **הרשאה:** `user_reminders:view` + מעורבות בכל תזכורת שנשלחה (יוצר או משויך) — הסדר הוא תצוגה אישית,
  לא עריכה של התזכורת; `404` למזהה לא קיים/בארכיון, `403` לתזכורת של מישהו אחר, ואז לא נכתב כלום.

## כפתורים / Buttons — מערכת שטוחה (Flat System)

> **מקור-האמת לכל כפתור בפרויקט (מ-15/06/2026).** מחליף את צבעי/גבהי §5.
> מימוש: React דרך `@/components/ui/button` (cva, Tailwind) + CSS נייד דרך
> `src/app/styles/buttons.css` (`.btn .btn-*`, מיובא ב-`globals.css`). שתי
> ההטמעות מיישמות **אותה** מערכת — יש לשמור אותן מסונכרנות.

### עקרונות

כפתורים **שטוחים לחלוטין** — בלי gradients, בלי צללים, בלי הרמה ב-hover. צבעים
מלאים אחידים, מעבר צבע חלק ב-hover בלבד. פונט Heebo, RTL. `:active` = `brightness(.96)`
(בלי translate). Focus = `outline` 2px מותג, offset 2px. Disabled = `opacity .5`.

### מידות בסיס (אחיד לכל הכפתורים)

| מאפיין | רגיל | קטן (sm) | גדול (lg) |
|---|---|---|---|
| גובה | 44px | 36px | 52px |
| רדיוס פינות | 11px | 9px | 13px |
| Padding אופקי | 22px | 16px | 28px |
| גודל טקסט | 14.5px | 13px | 16px |
| מרווח אייקון (gap) | 9px | 7px | 11px |

- טקסט: משקל **700** · אייקונים 16–17px (`size-4`) · גבול **1.5px**.
- Icon-only: ריבוע 44px (`size="icon"`) · 36px (`size="icon-sm"`).
- Block: `className="w-full"` (או `.btn.block`).

### וריאנטים

| # | שם (React `variant`) | רקע | גבול | טקסט | hover |
|---|---|---|---|---|---|
| 1 | **`default`** (Primary) | `#3D5AFE` | — | לבן | `#2C44E0` |
| 2 | **`secondary`** / `outline` | `#FFFFFF` | `#D9DDEA` | `#1A2233` | רקע `#F5F7FC` + גבול `#B4BACB` |
| 3 | **`approve`** (אישור) | `#16A34A` | — | לבן | `#0F9040` |
| 4 | **`newfolder`** (תיקייה חדשה) | `#ECEFFF` | `#CFD7FF` | `#243BB5` | רקע `#E0E6FF` + גבול `#3D5AFE` |
| 5 | **`delete`** (מחק — עדין) | `#FFFFFF` | `#F8D2D3` | `#B01B20` | רקע `#FEEFEF` + גבול `#E5484D` + טקסט `#C9353A` |
| 5s | **`destructive`** (מחק — מלא) | `#E5484D` | — | לבן | `#C9353A` |
| 6 | **`ghost`** | שקוף | — | `#5B6479` | רקע `#F5F7FC` + טקסט `#1A2233` |

> צבעי ה-brand (`#3D5AFE`/`#2C44E0`/`#ECEFFF`/`#CFD7FF`/`#243BB5`) זהים ל-skin
> tokens הקיימים ב-`@theme` (§2), ולכן ה-`Button` משתמש ב-utilities `bg-brand`,
> `bg-brand-dark`, `border-line-strong`, `text-ink`, `bg-row-hover` וכו'.

### היררכיה בשורת פעולות (RTL)

ראשי (`default`) הכי ימינה, אחריו משני/ביטול (`secondary`); `delete`/`newfolder`
בצד הנגדי (שמאל). תואם §12 (PanelFooter: "סגור" ב-start, "שמור" primary ב-end).

### React (`<Button>`)

```tsx
<Button>שמור</Button>                       {/* primary, 44px */}
<Button variant="secondary">ביטול</Button>
<Button variant="approve">אישור</Button>
<Button variant="newfolder">תיקייה חדשה</Button>
<Button variant="delete">מחק</Button>        {/* soft */}
<Button variant="destructive">מחק</Button>   {/* solid */}
<Button variant="ghost" size="icon"><X /></Button>
```

**אין** להוסיף `bg-blue-600 text-white hover:bg-blue-700` ל-`<Button>` — ה-`default`
כבר primary שטוח. ל-CTA ירוק/אדום השתמש ב-`variant` ("approve"/"destructive"),
לא ב-class צבע ידני. כפתורי **אישור ב-`AlertDialog`** (מחיקה/יציאה) ממשיכים
להשתמש ב-`bg-destructive text-white` ב-className (הם `AlertDialogAction`, לא `<Button>`)
— אדום מלא שטוח, עקבי עם variant 5s.

### CSS נייד (`.btn`) — `src/app/styles/buttons.css`

לשימוש ב-markup שאינו React (`<a class="btn btn-primary">`). מקור-אמת זהה
ל-`<Button>`. מחלקות: `.btn` + `.sm`/`.lg`/`.icon`/`.block` + `.btn-primary` /
`.btn-secondary` / `.btn-approve` / `.btn-newfolder` / `.btn-delete`(`.solid`) /
`.btn-ghost`. הקובץ מכיל את ה-`:root` vars וה-CSS המלא (verbatim מהמפרט).

---

## 26e. תפוצה מאוחדת — ערוץ וואטסאפ / מייל (קטגוריית „תפוצה”, 09/10/2026)

ערוץ הוא מאפיין של התפוצה, לא מסך נפרד. **אותם מסכים** (`src/app/(app)/broadcasts/**`) משרתים את שני הערוצים —
ובחלון „תפוצות” של הצ׳אט הם נעולים לוואטסאפ (`channelLock="whatsapp"`), בלי בורר ובלי עמודת ערוץ: הצ׳אט לא השתנה.

- **בורר ערוץ** (ראש כרטיס „תפוצה חדשה”, מעל „שם התפוצה”): תווית רגילה (§6) „ערוץ” + `role="radiogroup"` עם שני
  כפתורי pill — `inline-flex h-11 items-center gap-2 rounded-full border px-5 text-sm font-semibold`, אייקון
  `MessageCircle` / `Mail` `h-4 w-4`. פעיל = `border-emerald-300 bg-emerald-50 text-emerald-700` (כמו pills קהל היעד),
  לא פעיל = `border-slate-200 bg-white text-slate-600 hover:bg-slate-50`. `h-11` = Touch Target.
- **רק במייל:**
  - **„נושא המייל”** (חובה) — Input `h-10` מתחת ל„תבנית”, לפני „תוכן ההודעה”; error state של §6. מתמלא מ-`subject`
    של התבנית כשבוחרים תבנית. צ׳יפי המשתנים מוסיפים לשדה האחרון שהיה בפוקוס (נושא או תוכן).
  - **המונה**: `נמענים עם אימייל: X · ללא אימייל: Y` (`text-xs text-slate-500`, X `font-bold text-slate-700`,
    Y `font-bold text-amber-700`). מתחתיו כפתור טקסט `min-h-11 text-xs font-semibold text-amber-700` עם `ChevronDown`
    („הצג/הסתר את מי שאין לו אימייל (Y) — לא יקבלו את התפוצה”) שפותח רשימה
    `max-h-56 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900`,
    שורה לכל אחד: `דירה 1210 · בעלים · שם` / `ספק · שם`. **בוואטסאפ אין מונה כזה** — שם נשאר „נמענים עם טלפון תקין”
    בלבד (החלטת רונן 21/09: בלי אבחונים במסך הוואטסאפ).
  - **קבצים**: אותו `AttachmentPicker` עם `EMAIL_BROADCAST_ATTACHMENT_POLICY` (שורת העזר אומרת „סה״כ עד 25MB”);
    חריגה אחרי מעבר ערוץ = הודעה `text-[12px] font-semibold text-red-500` מתחת לבורר וכפתור השליחה מושבת.
- **היסטוריה**: עמודת „ערוץ” אחרי „שם התפוצה” + Select „כל הערוצים / וואטסאפ / מייל” בסרגל הכלים (`h-10 lg:w-44`).
  התג — `ChannelBadge` (`_components/StatusBadge.tsx`, `rounded-full px-2.5 py-0.5 text-xs font-semibold` + אייקון
  `h-3.5 w-3.5`): וואטסאפ `bg-emerald-50 text-emerald-700`, מייל `bg-blue-50 text-blue-700` (`CHANNEL_META` ב-`_lib/status.ts`).
  בכרטיס המובייל — התג בשורת המטא.
  **מבנה הטבלה (10/10/2026) — נכנסת ב-1440 בלי גלילה אופקית:** `table-fixed` + `<colgroup>` (התבנית של טבלאות
  הכספים, §35) — `COL_PX` ב-`BroadcastsHistoryClient.tsx`: **ערוץ 124 · נוצרה 148 · סטטוס 184 · נשלחו / נכשלו /
  בוטלו / סה״כ 72 כל אחת · פעולות 124**; „שם התפוצה” לוקחת את השאר (מינימום 200), ומתחת לסכום עטיפת ה-`Table`
  (`overflow-x-auto`) גוללת — **ב-1280 זו גלילה של 107px (1068 מול 961 זמינים; 56px לפני שה-gutter של §32 חזר
  ב-10/10/2026), ולפי רונן (10/10/2026) נשארת כמו שהיא; לא לצמצם עוד.** מאז החזרת ה-gutter גם 1366 גולל 21px
  (1068 מול 1047) — גם היא נשארת לפי רונן (10/10/2026); ב-1440 נכנסת (1121 זמינים). **אין עמודה שרוב השורות שלה „—”**: קהל + תבנית בשורה משנית מתחת לשם
  (`mt-0.5 truncate text-xs text-slate-500`, „בעלי נכסים · כתיבה חופשית”), „נוצר על ידי” מתחת לתאריך באותו סגנון,
  ופס ההתקדמות (`Progress h-1.5` + „X מתוך Y · Z%”) מתחת לתג הסטטוס — רק בתפוצה פעילה. תאים `px-4 py-3 text-sm`
  וכותרות `h-11 px-4` (§9); המספרים `dir="ltr" tabular-nums font-bold` בגוון (נשלחו `emerald-700`, נכשלו
  `red-600`, סה״כ `slate-700`; בוטלו `text-slate-600` רגיל). שם/שורה משנית `truncate` + `title` לשם המלא.
- **פירוט**: אותו מסך. התג ליד הכותרת; במייל שורת `נושא: …` מתחת לשורת „נוצר על ידי”, עמודת הכתובת נקראת
  „אימייל” ומציגה כתובת ממוסכת (`ro•••@example.com`, נבנית ב-SQL — הכתובת המלאה לא יוצאת ל-UI, כמו הטלפון),
  והמדדים/הטאבים „נמסרו” / „נקראו” לא מוצגים (אין אות כזה ב-SMTP — לא מציגים 0 מזויף).
  עמודת **„נמען”** (בשני הערוצים, 10/10/2026) מציגה את מי שההודעה נשלחה אליו בפועל — `recipient_name` שנשמר ביצירה
  (בעלים / שוכר / בעלים או שוכר נוסף / ספק); אדם בלי שם בכרטיס = „—”, לעולם לא שם של מישהו אחר. בתפוצות שנוצרו
  לפני כן (`NULL`) — הבעלים הראשי של הדירה, כמו שהיה.
- **עורך התבנית** (§26) במסך „תבניות” של הקטגוריה (`showSubject`): שדה „נושא למייל (אופציונלי)” בין „שם התבנית”
  ל„תוכן”, באותו סגנון שדה מותגי, עם עזר `text-[11.5px] text-ink-3`. בטאב התבניות של הצ׳אט השדה לא מוצג.

## 27. Combobox (searchable select)

כש-`Select` רגיל (§6) לא מספיק כי הרשימה ארוכה וצריך **חיפוש בתוך הרשימה** —
משתמשים ב-`Combobox` (`@/components/ui/combobox`). בנוי על `Popover` (base-ui) +
שדה חיפוש + רשימה מסוננת **client-side** (ללא תלות `cmdk`). single-select.

```tsx
<Combobox
  value={id}                         // string | null
  onChange={(v) => setId(v)}         // (string | null) => void
  options={items.map((x) => ({ value: x.id, label: x.name, keywords: x.extra, trailing: <Badge/> }))}
  placeholder="בחר דירה"
  searchPlaceholder="חיפוש..."
  emptyText="לא נמצאו תוצאות"
  disabled={disabled}
/>
```

- **Trigger**: כפתור בגובה `h-10` (אחיד עם `Select`), `border-input`, צ'בון `ChevronsUpDown`
  בקצה הלוגי; placeholder ב-`text-ink-ghost`. focus ring מותגי (§2).
- **Popup**: `PopoverContent` ברוחב ה-trigger (`w-(--anchor-width) min-w-72 p-0`),
  `dir="rtl"`. בראש — שדה חיפוש עם אייקון `Search` ב-start (`autoFocus`); מתחת —
  רשימה גלילה `max-h-64`. כל פריט: `Check` (גלוי לנבחר) + תווית + `trailing` אופציונלי
  (badge). הנבחר `bg-blue-50 text-blue-700`.
- **חיפוש**: סינון client-side על `label`+`keywords` (כבר טעון בזיכרון). `Enter` בוחר
  את התוצאה הראשונה. ריק → `emptyText`.
- **RTL (קריטי)**: `dir="rtl"` + `flex-row` רגיל. **אסור** `flex-row-reverse` בתוך
  אב RTL (היפוך כפול).
- **אופציונלי/ניקוי**: `value=null` = לא נבחר. ניקוי בחירה דרך ה-parent (לדוגמה
  `TargetField` עם כפתור "נקה" + בורר-סוג של 2 אופציות בדפוס Mode selector §19).

---

## 28. Suppliers design language — Section A (standard)

> **זהו ה-design-language הסטנדרטי החדש של המערכת.** הטוקנים נגזרו פיקסל-אחר-פיקסל
> מ-5 מוקאפי הרפרנס של מודול הספקים (`ref/_decoded/{table,new,view,docs,history}.html`;
> מקור מלא: `ref/SUPPLIERS_REDESIGN_SPEC.md`). **כל מודול חדש נבנה לפי הסטנדרט הזה.**
> דיוק מוחלט — בכל פער בין קוד לרפרנס הרפרנס מנצח; משתמשים ב-arbitrary values מדויקים
> (`h-[42px]`, `rounded-[14px]`, `bg-[#16308a]`) כשאין טוקן Tailwind מדויק. מיישמים
> per-instance על קומפוננטות הספקים (לא נוגעים ב-`Section`/`Tabs`/`PanelFooter`/`Button`
> המשותפים — הם עדיין משרתים מודולים שלא הוסבו).

### 28.1 gradient-CTA (פעולה ראשית מודגשת)

`bg-gradient-to-l from-[#1d4ed8] to-[#2563eb] text-white font-bold` + hover
`from-[#1e40af] to-[#1d4ed8]`. צל לפי הקשר: top-bar `shadow-[0_10px_22px_-8px_rgba(37,99,235,0.6)]`
(`h-[46px] rounded-[13px]`); footer DETAIL `shadow-[0_8px_18px_-6px_rgba(37,99,235,0.5)]`.
**יוצא דופן — CREATE:** "צור ספק" **שטוח** `bg-[#2563eb] hover:bg-[#1d4ed8] shadow-[0_6px_16px_rgba(37,99,235,0.28)]`.

### 28.2 entity dark-header — שתי משפחות

**CREATE** (`new.html`, כחול-בהיר אופקי): `bg-[linear-gradient(to_left,#142a63_0%,#1d4ed8_70%,#2563eb_100%)]
px-[26px] py-[18px]`; כותרת `text-[21px] font-extrabold`; תת `text-[12.5px] text-[#c7dbff]/[0.78]`;
סגירה `h-[38px] w-[38px] rounded-[11px] bg-white/[0.14] hover:bg-white/[0.26]` (בלי border), X 19px stroke 2.2.
**DETAIL** (`view/docs/history`, נייבי אלכסוני): `bg-[linear-gradient(120deg,#0e1f4d_0%,#16308a_55%,#1d4ed8_100%)]
px-8 py-5`; כותרת `text-[26px] font-extrabold`; תת `text-[13.5px] text-[#c7dbff]/80` (קטגוריה + אייקון 15px);
סגירה `h-[46px] w-[46px] rounded-[13px] bg-white/[0.14] hover:bg-white/[0.26]` (בלי border).

### 28.3 in-sheet tab-bar

container `rounded-[14px] border border-[#e9edf4] bg-white p-[6px] gap-[8px]`; טאב `h-[42px] rounded-[10px] text-[14.5px]`;
פעיל `bg-[#2563eb] text-white font-bold`, לא-פעיל `text-[#64748b] font-semibold`.

### 28.4 activity timeline

כותרת-מקטע: אייקון 34×34 `rounded-[10px] bg-[#eef2ff] text-[#4f46e5]` + h2 18px/800 + תת 13px/#94a3b8.
פס אנכי בקצה-התחלה: `right-[21px] w-0.5 top-[10px] bottom-[30px] bg-[linear-gradient(#dbe2ec,#eef1f6)]`.
צומת 44×44 `rounded-[13px] border-[3px] border-[#f4f6fb]` (svg 19), גוון לפי פעולה (edit `bg-[#e8f0ff] text-[#2563eb]`,
upload `bg-[#fff3e6] text-[#ea8a18]`, create `bg-[#e7f7ee] text-[#16a34a]`, delete `bg-[#ffe4e6] text-[#e11d48]`); gap לכרטיס 18px.
כרטיס `rounded-[14px] border border-[#e9edf4] px-[18px] py-[15px] shadow-[0_1px_2px_rgba(15,23,42,0.04)]`;
כותרת 15.5px/700/#0f172a; פירוט 13.5px/#475569 (`mt-[5px]`); שחקן 12.5px/#94a3b8 + user-icon 13px/#cbd5e1; תאריך 12.5px/#94a3b8 `dir=ltr`.

### 28.5 upload dropzone

`border-2 border-dashed border-[#d8e0ec] rounded-[14px] bg-[#fafbfd] p-[26px]` hover `border-[#93b4f0] bg-[#f5f9ff]`;
אייקון 48×48 `rounded-[13px] bg-[#e8f0ff] text-[#2563eb]` (svg 22); כותרת 14px/600/#334155; רמז 12.5px/#94a3b8.
שדות העלאה (select/קובץ) `h-[46px] rounded-[11px]`; כפתור "העלה מסמך" = gradient-CTA `h-[46px] rounded-[12px]`.

### 28.6 document row

`rounded-[13px] border border-[#eef1f6] bg-[#fafbfd] px-4 py-[14px]` hover `border-[#dbe2ec] bg-white`;
אייקון-קובץ 44×44 `rounded-[11px]` tone-לפי-MIME (PDF `bg-[#fef2f2] text-[#dc2626]`, תמונה blue, גיליון emerald, אחר slate);
שם 15px/700/#0f172a; מטא 12.5px/#94a3b8 בסדר **תאריך • גודל [badge]** (dot 3px #cbd5e1);
badge `rounded-full bg-[#e8f0ff] text-[#2563eb] px-[9px] py-[3px] 11.5px/600`; פעולות צפייה/שינוי-שם/מחיקה
`h-9 rounded-[9px]` בגווני `#2563eb`/`#64748b`/`#dc2626` (hover `#eff5ff`/`#eef2f7`/`#fef2f2`).

### 28.7 entity section-card — שתי משפחות (קומפוננטה `SupplierSection`)

**CREATE:** `rounded-[14px] border border-[#e7ebf1] px-5 py-[18px]`; אייקון 30×30 `rounded-[9px]` (svg 16); h2 16px/700.
**DETAIL:** `rounded-[18px] border border-[#e9edf4] px-[26px] py-[22px]`; אייקון 34×34 `rounded-[10px]` (svg 17); h2 18px/800.
גווני אייקון: blue `bg-[#e8f0ff] text-[#2563eb]`, amber `bg-[#fff3e6] text-[#ea8a18]`, emerald `bg-[#e7f7ee] text-[#16a34a]`,
slate `bg-[#eef2f7] text-[#475569]`, violet `bg-[#eef2ff] text-[#4f46e5]`. מיושם ב-`SupplierSection.tsx` (variant `create`/`detail`).

### 28.8 entity form-field

label 12.5px/600/#64748b (`text-xs`), `mb-1.5`; כוכבית חובה `text-red-500`.
input editable: `h-[42px] rounded-[10px] border-[#e2e8f0] px-[13px] text-[14px] text-[#0f172a]`,
focus `focus-visible:border-[#2563eb] focus-visible:ring-[3px] focus-visible:ring-[#2563eb]/[0.12]`, error `border-red-400 bg-red-50`.
ה-`SelectTrigger` בטפסים = `h-[42px] rounded-[10px]` (בלי פער מול input).
**readonly box (צפייה):** `min-h-[44px] rounded-[10px] border border-[#e7ebf1] bg-[#f8fafc] px-[13px] py-[10px]
text-[14px] font-medium text-[#0f172a]`; ריק → `text-[#94a3b8]` "—"; אימייל/אתר → `text-[#2563eb]`.

### 28.9 suppliers table + toolbar

top-bar: icon-chip 48×48 `rounded-[14px] bg-[#e8f0ff] text-[#2563eb]` (Truck 24) + כותרת `text-[27px] font-black` +
תת `text-[13.5px] text-[#94a3b8]` עם ספירה inline; כפתורים "ספק חדש" (gradient, ימין) + "ניהול קטגוריות" (outline `h-[46px] rounded-[13px]`, שמאל).
קארד יחיד `rounded-[18px] border border-[#e9edf4] bg-white overflow-hidden`: toolbar (`border-b border-[#eef1f6] px-[22px] py-4`) → טבלה.
toolbar: pills (start) + dropdown-pill קטגוריה, search (end) `h-10 w-[300px] rounded-[11px] bg-[#fafbfd] border-[#e7ebf1]` אייקון 17px start.
pill: `h-9 rounded-full px-4 text-[13.5px]`, פעיל `bg-[#2563eb] text-white font-bold`, idle `border border-[#e2e8f0] bg-white text-[#475569] font-semibold`.
טבלה = CSS grid `grid-cols-[1.6fr_1.3fr_1.1fr_1fr_1.3fr_1.6fr_0.9fr] gap-3`; כותרות `12.5px/700 #94a3b8 bg-[#fafbfd] px-6 py-[14px]`;
שורות `px-6 py-[18px] border-b border-[#f1f4f8] hover:bg-[#fafbfd]`; שם=ימין 14.5px/700, השאר=center; טלפון/נייד/אימייל `#2563eb dir=ltr`; em-dash `#cbd5e1`.
status pill `rounded-full px-[11px] py-[4px] gap-[5px] text-xs font-semibold` (active `bg-green-100 text-green-700` dot 6px `bg-green-500`).
category badge **צבע-לפי-קטגוריה** (hash→פלטה; `rounded-full px-[11px] py-[4px] text-xs font-semibold`). מודל-הנתונים חסר `color` — מומלצת מיגרציה additive `supplier_categories.color`.

### 28.10 category-management sheet

Side panel (`side="left"`) — header DETAIL (`§28.2`) אך כותרת `text-[23px]`, תת `text-[13px]`, סגירה `h-11 w-11 rounded-[13px]`.
body `bg-[#f4f6fb] p-6` → `SupplierSection` (detail) "קטגוריות" אייקון `Folder` blue.
add-row: input `h-[46px] flex-1 rounded-[11px] border-[#e2e8f0] px-[14px]` + "הוסף" gradient-CTA `h-[46px] rounded-[11px] px-[22px]` (mb-2).
row: `flex items-center justify-between px-[6px] py-[14px] border-b border-[#f1f4f8]`; שם=ימין 15px/700/#0f172a; controls=שמאל (gap-[6px]):
count badge `rounded-full bg-[#eef2f7] text-[#64748b] px-[10px] py-[4px] 12px/600`,
toggle 42×24 `rounded-full` (on `bg-[#2563eb]` knob 18 left-[3px] / off `bg-slate-300` knob right-[3px]),
rename `34×34 rounded-[9px] text-[#64748b] hover:bg-[#eef2f7]`, delete `34×34 rounded-[9px] text-[#dc2626] hover:bg-[#fef2f2]` (נעול=`text-[#d4dbe6]` ללא פעולה כשמשויכים ספקים).

### 28.11 אנשי קשר נוספים — כרטיס חוזר בתוך טופס (04/10/2026, אושר ע״י רונן)

קומפוננטה `SupplierContacts.tsx` (`SupplierContactsEditor` ליצירה/עריכה, `SupplierContactsView` לצפייה).
**מיקום:** ילדים ישירים של הגריד הקיים של המקטע (`grid-cols-1 sm:grid-cols-2`; ביצירה/עריכה `gap-[14px]`, בצפייה `gap-4`), אחרי שדות איש הקשר הראשי —
ביצירה/עריכה אחרי "אימייל" ב"פרטי הספק", בצפייה אחרי "אתר" ב"פרטי קשר". כל כרטיס `sm:col-span-2`; ה-gap של הגריד מרווח (בלי margin).
**כרטיס** = מעטפת §28.6: `space-y-[14px] rounded-[13px] border border-[#eef1f6] bg-[#fafbfd] px-4 py-[14px]`, `role="group"` + `aria-label` = הכותרת.
כותרת `text-[15px] font-bold text-[#0f172a]` — "איש קשר נוסף N", N מ-2 (הראשי = 1, כמו "בעל דירה נוסף N" בכרטיס הדירה).
שלושה שדות בלבד: `SupplierField` (§28.8) בגריד פנימי `grid-cols-1 sm:grid-cols-2 gap-[14px]` — שם · טלפון נייד (`dir=ltr`, tabular) · אימייל (`dir=ltr`);
בצפייה `ReadonlyField` ב-`gap-4`, טלפון דרך `formatPhoneDisplay`, אימייל accent. שגיאה מוצגת מיד (לא אחרי blur) — כפתור השמירה disabled כל עוד יש שגיאה.
**הסרה:** פעולת danger של §28.6 בגודל מגע — `grid h-[44px] w-[44px] place-items-center rounded-[9px] text-[#dc2626] hover:bg-[#fef2f2]`, Trash2 16px, `aria-label="הסר <כותרת>"`. בצפייה אין.
**הוספה:** שורה `flex justify-start sm:col-span-2` מתחת לכרטיס האחרון (RTL start = מתחת לעמודת "איש קשר"); כפתור
`inline-flex h-[44px] items-center gap-2 rounded-[10px] border border-[#e2e8f0] bg-white px-4 text-[14px] font-semibold text-[#2563eb] hover:bg-[#eff5ff]` + Plus 16px
(מ-§28.9 נלקחו רק הגבול והרקע של ה-outline — לא הגובה 46px וה-`rounded-[13px]`: הגובה 44px והפינה 10px כמו שדות §28.8; הגוון וה-hover מ-§28.6).
מוצג רק במצב יצירה/עריכה, כלומר רק ל-`suppliers:edit`.

---

## 29. Calendar (יומן) design language

עיצוב 4 מסכי היומן (חודש/שבוע/יום/טופס אירוע) — 1:1 עם `ref/עמוד יומן`, `ref/יומן שבועי`, `ref/יומן יומי`, `ref/אירוע חדש`. רקע עמוד `#f4f6fb`, כרטיס תוכן לבן `border-[#e9edf4] rounded-[18px] overflow-hidden`.

### 29.1 כותרת + toolbar

- כותרת: אריח אייקון `h-11 w-11 rounded-[13px] bg-[#e8f0ff] text-[#2563eb]` (CalendarDays) + "יומן" `text-[27px] font-black text-[#0f172a]`; כפתור "אירוע חדש" = gradient-CTA `h-[46px] rounded-[13px] bg-gradient-to-l from-[#1d4ed8] to-[#2563eb] shadow-[0_10px_22px_-8px_rgba(37,99,235,.6)]` (§28.1 precedent).
- toolbar: מתג segmented `rounded-[12px] border-[#e9edf4] bg-white p-1`, כפתורים `h-9 px-[18px] rounded-lg` (פעיל `bg-[#2563eb] text-white font-bold`, לא-פעיל `text-[#475569] font-semibold`); כותרת תקופה `text-[19px] font-extrabold`; "היום" `h-[38px] rounded-[10px] border-[#e2e8f0]`; חצי ניווט `38×38 rounded-[10px] border-[#e2e8f0]` (RTL: הקודם=ChevronRight, הבא=ChevronLeft).

### 29.2 ארבעה סוגי פריטים — הבחנה בצבע בלבד (`chipTone` ב-`constants/calendar.ts`)

כל הפריטים חולקים מבנה chip זהה; נבדלים רק בצבע + אייקון. נקודה מובילה (חודש) / accent `border-s-[3px]` בקצה ההתחלה (שבוע/יום):

| סוג | רקע | accent/נקודה | טקסט | אייקון |
|-----|-----|------|------|--------|
| אירוע | `bg-{color_key}-100` | `-600` | `-700` | נקודה (Repeat אם חוזר) |
| משימה | `bg-green-100` `#dcfce7` | `green-500` `#22c55e` | `green-700` `#15803d` | CheckSquare |
| תקלה | `bg-red-100` `#fee2e2` | `red-500` `#ef4444` | `red-700` `#b91c1c` | AlertTriangle |
| תזכורת | `bg-slate-100` `#f1f5f9` | `slate-400` `#94a3b8` | `slate-600` `#475569` | Bell |
אירוע משתמש בצבע שנבחר בטופס (פלטת 7 הגוונים §2). legend בתחתית עם 4 הסוגים.

### 29.3 סימון "היום"

- חודש: מספר בעיגול `h-6 w-6 rounded-full bg-blue-600 text-white` + תא `bg-[#f5f9ff]`.
- שבוע: עמודה `bg-[#eef5ff]` + שם יום `text-blue-600` + מספר בעיגול `h-[26px] w-[26px] rounded-full bg-blue-600 text-white`.
- יום: אין סימון בגריד (נמסר ב-toolbar + טאב פעיל).

### 29.4 גריד התצוגות

- חודש: גריד `grid-cols-7`, header ימים `bg-[#fafbfd] text-[13px] font-bold text-slate-500`; תא `min-h-[116px] border-[#eef1f6] p-2`; חוץ-לחודש `bg-[#fafbfd]` מספר `text-slate-300`; עד 3 chips + "עוד N…".
- שבוע + יום: **גריד שעתי 08:00–20:00** (שעות עבודה — חריג מוצהר מ-ref 07:00). שורת שעה `min-h-[58px]`(שבוע)/`min-h-[60px]`(יום) `border-[#f1f4f8]`; עמודת זמן `dir=ltr text-slate-400` (`w-[72px]` שבוע / `w-[84px]` יום). שורת "כל היום" לפריטים ללא שעה (יום=תמיד, שבוע=band עליון כשיש). פריט מחוץ לחלון → **clamp** לשורת הקצה (לפני 08:00→08:00, אחרי 20:00→20:00), לעולם לא מוסתר.

### 29.5 טופס אירוע (Side Panel)

`Sheet side="left" sm:w-[55vw]`. header gradient כהה `bg-[linear-gradient(120deg,#0e1f4d,#16308a_55%,#1d4ed8)]`. 4 sections (`Section` משותף, iconTone: פרטי=blue, חזרתיות=violet, משתתפים=emerald, תזכורות=amber). בורר צבע: 7 עיגולים `h-[34px] w-[34px]`, נבחר `ring-2 ring-[#2563eb] ring-offset-2`. שדות בגובה **44px** (`h-11`) — ראה חריגים מוצהרים.

## 30. מחזוריות (משימות חוזרות) — מודל „מופע אחד”

**עיקרון־יסוד (migration 067):** משימה מחזורית היא **שורה אחת בלבד**. `due_date` שלה הוא **המופע הנוכחי**, ובסימון „בוצע” היא לא נסגרת אלא מתקדמת למופע הבא (ההשלמה נרשמת ב-`task_occurrence_completions`). אין מופעים ממומשים, אין `is_recurring_instance`, אין „מופע בסדרה”.

### 30.1 אינדיקטור

אייקון `Repeat` (lucide) בגוון **`blue-500`** — מקור־אמת יחיד: `src/components/recurrence/RecurringBadge.tsx` (Iron Rule #8 — DRY).

- **שורת טבלה / כרטיס קנבן**: `RecurringBadge` (= `Repeat h-3.5 w-3.5 text-blue-500`, עטוף ב-`<span title="משימה חוזרת">` ל-tooltip+a11y), מיד אחרי הכותרת. מוצג כאשר `task.recurrence !== null`.
- **chip ביומן** (§29.2): אותו glyph בגודל chip `Repeat h-2.5 w-2.5 opacity-70`, אחרי אייקון הסוג. נדלק מ-`item.recurring` (`recurrence_id is not null`).
- **כותרת פאנל המשימה** (header כהה): chip translucent `border-white/25 bg-white/10 px-2.5 py-0.5 rounded-full text-xs` עם `Repeat h-3.5` + „משימה מחזורית”.

### 30.2 שורת המחזוריות (`CadenceStrip`) — מקור־אמת יחיד

`src/components/recurrence/CadenceStrip.tsx`. תצוגה בלבד; בשימוש בכרטיס הקנבן, שורת הטבלה, טאב „מחזוריות” ותצוגה־מקדימה בטופס — כדי ששני משטחים לא יציגו מחזוריות אחת בשתי צורות.

**התווית + הצ'יפים נגזרים מהעוגן + `interval`** (`src/lib/recurrence/cadence.ts`) — **אין עמודות `bymonth` / `bymonthday`**:

| תווית | מאוחסן | צ'יפים | דוגמה |
|---|---|---|---|
| כל יום | `daily/1` | 7 ימים דלוקים | — |
| כל שבוע | `weekly/1` | `byweekday` (ריק → יום העוגן) | ג׳, ה׳ |
| כל חודש | `monthly/1` | „ב-N לחודש” מיום העוגן | עוגן 15 → `ב-15 לחודש` |
| כל רבעון | `monthly/3` | 12 צ'יפי חודשים, דלוקים מחודש העוגן | עוגן 10 → 1, 4, 7, 10 |
| כל חצי שנה | `monthly/6` | כנ״ל | עוגן 09 → 3, 9 |
| כל שנה | `yearly/1` | חודש בודד | — |
| כל N ימים/שבועות | interval אחר | ללא צ'יפים (תווית בלבד) | — |

**3 מצבי צ'יפ (חובה, ללא חריגה):**

- `on` (מתוכנן) — `border-blue-600 bg-blue-50 text-blue-600`
- `done` (בוצע בתקופה הנוכחית) — `border-emerald-600 bg-emerald-50 text-emerald-700`
- `off` (לא מתוכנן) — `border-slate-200 bg-white text-slate-300`

**גדלים:** `sm` = `h-5 min-w-5 rounded text-[10px]` (כרטיס/טבלה) · `md` = `h-7 min-w-7 rounded-md text-xs` (תצוגה־מקדימה בטופס). הצ'יפים האינטרקטיביים בטופס (`RecurrenceSection`) נשארים `h-11 w-11` — Touch Target (כלל ברזל #6).

**פריסה:** ימי־שבוע / יום־בחודש → שורה אחת, `Repeat`+תווית מימין והצ'יפים משמאל. 12 חודשים → התווית בשורה נפרדת מעל, והצ'יפים ב-`flex-wrap` בתוך `rounded-lg border border-slate-100 bg-slate-50/60 p-2`, כדי לא לשבור את רוחב הכרטיס במובייל.

**בכרטיס קנבן:** בתחתית הכרטיס, מעל/אחרי ה-`AssigneePills`, בתוך `border-t border-dashed border-slate-200 pt-2.5`. מוסתר כש-`chips.type === 'none'`.

### 30.3 תג התקדמות (`CadenceProgress`)

`1/3 השבוע` + `Check` — `bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-md text-[11px] font-bold`, בשורת הכותרת ליד badge העדיפות.

**כלל הצגה (מחייב):** מוצג **רק** כאשר `expected_count > 1 && done_count > 0`. `expected` = 7 ליומי, מספר הימים הנבחרים לשבועי, 4 לרבעוני, 2 לחצי־שנתי — ו-1 לחודשי/שנתי, ולכן `1/1 החודש` לא מוצג לעולם.

**התקופה** (`cadenceWindow`): שבוע ראשון–שבת ליומי/שבועי · חודש קלנדרי לחודשי · שנה קלנדרית לרבעון/חצי־שנה/שנה.

**חישוב server-side בלבד** — `expected`/`done`/`chips` נפתרים ב-`lib/db/tasks.attachRecurrenceViews`, כי הם תלויים ב„היום” לפי Asia/Jerusalem; חישוב בצד הלקוח יגרום לאי־התאמה בין SSR ל-hydration (אותו נימוק כמו סימון האיחור).

### 30.4 טאב „מחזוריות”

מסך משימות, שלישי אחרי „פעילות”/„הושלמו”. טבלה (`RecurringSeriesList`) — שורה לכל סדרה פעילה, **ממוינת לפי המופע הבא (עולה)**. עמודות: כותרת (glyph + `CadenceProgress`) · מחזוריות (`CadenceStrip`, `min-w-[220px]`) · המופע הבא (תאריך+שעה, `CalendarClock`). לחיצה → פתיחת משימת הסדרה. ה-toolbar מוסתר בטאב זה. המופע הבא מחושב ב-`listRecurringSeries` דרך `computeOccurrences` (אופק `SERIES_LOOKAHEAD_DAYS`=400, מכבד exceptions).

### 30.5 טופס המחזוריות (`RecurrenceSection`)

בורר התדירות מציג **presets** (יומי / שבועי / חודשי / רבעוני / חצי־שנתי / שנתי) ולא את ה-`frequency` המאוחסן, כי „רבעוני”/„חצי־שנתי” הם `monthly` עם interval 3/6. „כל כמה” מוצג רק ל-יומי/שבועי (`PRESETS_WITH_INTERVAL`). מתחת לשדות — תצוגה־מקדימה `CadenceStrip size="md"` של מה שיופיע על הכרטיס. פעולות הסדרה: „דלג על מופע זה” · „ערוך רק את המופע הזה” (יוצר משימה עצמאית ומקדם את הסדרה) · „סיים סדרה”.

---

## 31. Global Search (Command Palette)

חיפוש גלובלי מהיר בסגנון ⌘K. מקור-אמת: `src/components/app-shell/GlobalSearch.tsx` (UI) + `src/app/api/search/route.ts` (endpoint) + פרימיטיב `src/components/ui/command.tsx` (**dependency-free**, ללא `cmdk` — תואם לדפוס ה-`Combobox` של §27).

**טריגר (בהדר)**: ה-slot של החיפוש ב-§15 הוא `button` ויזואלי בלבד (לא `input`). לחיצה פותחת את הפלטה; קיצור גלובלי `⌘K` (mac) / `Ctrl+K` מחליף מצב פתוח/סגור מכל מקום במסך. ה-`kbd` מוצג מ-`sm:` ומעלה.

**פלטה (Dialog)**: `CommandDialog` עוטף את `DialogContent` הקיים (§12) עם override: `top-[12vh] -translate-y-0 max-w-[600px] p-0 gap-0` (ממורכז אופקית RTL, מעוגן לראש). `showCloseButton={false}`; `DialogTitle` ב-`sr-only` ל-a11y. ESC / קליק-רקע סוגרים (התנהגות base-ui).

**מבנה הפלטה**:

- `CommandInput`: שורה עם אייקון `Search` + `input` `h-[52px]`, `border-b border-line`, `autofocus` בפתיחה, `debounce ~250ms` + `AbortController` (מבטל בקשות ישנות).
- `CommandList`: `max-h-[60vh] overflow-y-auto p-2`.
- תוצאות **מקובצות לפי סוג** (`CommandGroup` עם `heading`), בסדר קבוע: **דיירים → ספקים → תקלות → מסמכים**. קבוצה מוצגת רק אם יש לה תוצאות.
- `CommandItem`: avatar-chip `h-9 w-9 rounded-[10px] bg-brand-soft text-brand-text` עם אייקון הסוג (`Users`/`Truck`/`AlertTriangle`/`FileText`), כותרת `text-[13.5px] font-bold` + subtitle `text-[12px] text-ink-3`. שורה פעילה: `bg-row-hover`.
- **ניווט מקלדת**: `↑`/`↓` מזיזים active על פני כל הקבוצות (index שטוח), `Enter` → `router.push(href)`. גם hover (`onMouseMove`) מסמן active.
- **מצבים** (עברית קצרה): „הקלד לפחות 2 תווים לחיפוש” (פחות מ-2 תווים) · „מחפש…” + spinner (טעינה) · „לא נמצאו תוצאות עבור «…»” (ריק).

**Result shape** (מערך שטוח אחיד, מקובץ ב-client):

```ts
{ type: 'debtor' | 'supplier' | 'issue' | 'document'; id: string; title: string; subtitle: string; href: string }[]
```

`href` נבנה מ-routes קיימים בלבד (לא ממציאים): דייר → `/dashboard?apt=<מס׳ דירה>&open=details` (deep-link קיים, נופל ל-`/dashboard` ללא מס׳ דירה) · תקלה → `/issues?issue=<id>` · ספק → `/suppliers` · מסמך → `/documents` (לשני האחרונים אין deep-link לפריט בודד).

**RBAC (נאכף ב-endpoint, לא רק ב-UI)**: `GET /api/search?q=` דורש session (`getCurrentActor` → אין session → 401); `q` קצר מ-2 תווים → `[]` בלי פנייה ל-DB. כל מקור נשאל **רק** אם למשתמש יש הרשאת `view` אליו — מקור לא-מורשה לא נשאל כלל:

| מקור | טבלה | הרשאה נדרשת |
|------|------|-------------|
| דיירים | `debtors` | `dashboard` **או** `contacts` (זהה ל-`/api/debtors`) |
| ספקים | `suppliers` | `suppliers` |
| תקלות | `issues` | `issues` |
| מסמכים | `documents` | `documents` |

תוצאה: `viewer` (יש לו `dashboard:view`) → דיירים בלבד; `admin`/`super_admin` → כל המקורות; `manager` → לפי `user_permissions`. שאילתות `ILIKE '%q%'` פרמטריות (wildcards של המשתמש עוברים escape), `LIMIT 5` לכל מקור, מסננות פריטים מאורכבים (`is_archived=false` / `deleted_at is null`). ללא DDL; `pg_trgm` = שדרוג עתידי, לא צורך נכון לעכשיו.

---

## 32. App Shell (שלד ה-layout)

מקור-אמת: `src/components/app-shell/AppShell.tsx`. השלד הוא **flex ROW מלא-גובה ב-RTL** (ה-`dir="rtl"` הגלובלי מציב את הילד הראשון בצד ימין) — **לא** `flex-col` עם header חוצה למעלה.

```tsx
<div className="h-shell flex bg-app">         {/* row, RTL → סיידבר בימין */}
  <Sidebar />                                  {/* עמודה מלאת-גובה בקצה ימין, brand בראשה */}
  <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
    <Header />                                 {/* בתוך אזור התוכן בלבד */}
    <main className="flex-1 overflow-auto overscroll-contain bg-app">
      <div className="mx-auto max-w-[1640px] p-[18px]
                      pr-[max(18px,env(safe-area-inset-right))] pb-[max(18px,env(safe-area-inset-bottom))]
                      pl-[max(18px,env(safe-area-inset-left))]
                      md:p-6 md:pr-[max(1.5rem,env(safe-area-inset-right))] md:pl-[max(1.5rem,env(safe-area-inset-left))]">
        {children}
      </div>
    </main>
  </div>
</div>
```

**עקרונות (מה שמנע את הסטייה):**

- **הסיידבר הוא עמודה מלאת-גובה בקצה ימין** — נמתח מ-`top` ל-`bottom` של המסך (הילד הראשון ב-row, `align-items: stretch`). ה-brand block בראשו עולה עד הקצה העליון ממש.
- **ה-Header יושב רק מעל אזור התוכן** — הוא ילד של עמודת התוכן (`flex-1 flex-col`), ולכן **נעצר בגבול הסיידבר ולא חוצה מעליו**. זו הנקודה הקריטית: header אסור שיהיה אח (sibling) של הסיידבר ברמת ה-row.
- **יישור הקווים התחתונים**: ה-brand block (§14) וה-Header (§15) חולקים `h-16` + `border-b border-line` → שני הקווים התחתונים מתלכדים לקו רציף אחד לרוחב ראש המסך.
- **ריפוד התוכן (gutter)**: `18px` מתחת ל-`md`, `md:p-6` (1.5rem = 25.5px — ה-root הוא 17px) מ-`md` ומעלה, בארבעת הצדדים. הצדדים = `max(ה-gutter, env(safe-area-inset-left/right))` בכל רוחב, והתחתית כך מתחת ל-`md` — בטלפון לרוחב התוכן לא נכנס מתחת ל-notch, ובכל מקום אחר הריפוד הוא ה-gutter עצמו. **safe-area כותבים בתוך ה-utility עצמו (`max(…, env(safe-area-inset-*))`), לא במחלקה נפרדת, ולא שמים מחלקה מ-`responsive.css` על אלמנט שיש לו גם utility של padding:** הקובץ לא בתוך layer, ולכן כל כלל שבו גובר על כל utility של Tailwind (סדר ה-layers נקבע לפני ה-specificity). כך `.safe-px` העלים את הריפוד הצדדי בכל הדפים מ-13/08 עד 10/10/2026; הוא וחמש מחלקות ה-`safe-*` האחרות (`safe-pt`/`safe-pb`/`safe-mb`/`safe-pb-3`/`safe-pb-4`, שלא היו בשימוש) נמחקו ב-10/10/2026. שומר רגרסיה: `e2e/app-shell-padding.spec.ts`.
- **Scroll**: רק `<main>` גולל (`overflow-auto`); הסיידבר וההדר קבועים. עמודת התוכן היא `overflow-hidden` כך שה-`<main>` הוא המשטח הגולל היחיד.
- **רספונסיביות**: הסיידבר `hidden md:flex` — במובייל הוא מוסתר, אזור התוכן תופס את כל הרוחב, וההדר נמתח על פניו (אין סיידבר לחצות מעליו). התנהגות ה-collapse נשמרת בתוך הסיידבר עצמו (§14).
- **גבול שינוי**: עורכים כאן את **מבנה ה-wrapper בלבד** — לא את `{children}`, לא את ה-`<main>` הפנימי, ולא את לוגיקת הניווט/ההרשאות.

---

## 33. התראות ותזכורות בטופס תקלה/משימה

מקור-אמת: `src/components/notify/ChannelCards.tsx`, `src/components/reminders/RemindersSection.tsx`, `src/lib/notify/selection.ts`, `src/lib/validation/tasks.ts`. משותף לטופס **תקלה** ובטופס **משימה** (אותם רכיבים) — כל שינוי חל על שניהם.

### 33.1 כרטיסי ערוץ גלובליים (`ChannelCards`) — מחליף את `NotifyMatrix`

מטריצת נמען×ערוץ בוטלה. במקומה **שני כרטיסי ערוץ גלובליים** — וואטסאפ / מייל — הגלויים **תמיד** בכרטיס „התראה ותזכורות” (בטופס התקלה) / „שליחת התראה” (בטופס המשימה), **בלי תלות בתזכורות**. הערוץ הנבחר נשלח **לנמענים שנבחרו** — גורם מטפל ו/או „אליי” (הרחבה דרך `channelsToSelection` ב-submit → אותו `body.notify` שה-routes כבר צורכים; ה-routes לא משתנים). בחירת ערוץ **בלי תזכורת** = שליחה מיידית לנמענים אלו — מסלול עצמאי משל עצמו.

- **פריסה**: גריד `sm:grid-cols-3` — וואטסאפ · מייל · „שלח גם אליי”. כרטיס נבחר `border-blue-600 bg-blue-50`; לא-נבחר `border-slate-200 bg-white hover:bg-slate-50`.
- **ולידציית ערוץ**: ערוץ **disabled + רמז ענבר** כשלאף נמען נבחר (כולל self) אין את הפרט (מייל / `users.notification_phone` / ספק `email` / `mobile‖phone`). ערוץ שנבחר ואז נפסל — נמחק אוטומטית (`useEffect`). השרת בודק שוב וממילא מדלג בשקט על פרט חסר.
- **שורת סיכום** בתחתית: ירוקה (`emerald-50`) „יישלח (…) ל<גורם מטפל + אליי>” כשיש ערוץ + נמען; אחרת ניטרלית „לא נבחר כלום — לא תישלח התראה מיידית”.

### 33.2 „שלח גם אליי” (self) — גלוי ועצמאי

הטוגל השלישי **גלוי ופעיל תמיד**, בלי תלות בתזכורת (סאב-טקסט קבוע „גם למשתמש הנוכחי”). כשמסומן, המשתמש הנוכחי מתווסף כנמען — ה-submit מוסיף את המפתח `'me'` ל-selection (`channels, self ? [...assigneeKeys,'me'] : assigneeKeys`), וה-route שולח לו **מייל/וואטסאפ מיידי** בערוצים שנבחרו (כמו גורם מטפל). ולידציית הערוץ חלה גם עליו (אין לו טלפון/מייל → הערוץ המתאים לא זמין). **בנוסף** — כשקיימת תזכורת מתוארכת, ה-self גם דוחף אותה למשתמש דרך `reminders.notify_owner` (מיגרציה **065**) + פעמון in-app „נקבעה תזכורת שתגיע גם אליך” (`reminder_self:<id>:<user>`). שני המסלולים בלתי-תלויים: self בלי תזכורת = שליחה מיידית בלבד; self עם תזכורת = מיידי **וגם** תזכורת. אין פעמון in-app מיידי לשליחה בלי תזכורת (החלטה מודעת — יצרת את הפריט בעצמך).

### 33.3 אזור תזכורות — reminders-first, default „עכשיו”, חסימת עבר

צ׳יפי-זמן (מיידי/מחר/…) בוטלו. „הוסף תזכורת” פותח שורה עם **default = עכשיו** (מעוגל מעלה ל-5 הדקות הבאות, tz של הדפדפן); שדה התאריך `min=today`. התזכורות **יורשות את הערוץ הגלובלי** (`channelsFromGlobals` → הערוצים שנבחרו, אחרת `['in_app']`). **תזכורת בעבר חסומה** בקליינט (`hasNewPastReminder`) ובשרת (`reminderInPast`, grace 60ש׳) — אך תזכורות שכבר נשמרו פטורות (עריכה של רשומה עם תזכורת ישנה לא נחסמת; רק תזכורת **חדשה** בעבר נדחית → 400 `reminder_in_past`).

### 33.4 „גורם מטפל” — 50/50

שני בוררי `AssigneeSplitFields` (משתמשים פנימיים · ספקים חיצוניים) יושבים בשורה אחת `sm:grid-cols-2` (`gap-4`), בלי מפריד ביניהם.

---

## 34. באנר התקנת PWA (מובייל בלבד)

`src/components/app-shell/InstallPrompt.tsx`, ממוקם פעם אחת ב-root layout ליד ה-`Toaster`. לא Sheet-צד ולא Dialog — באנר תחתון לא-מודאלי, בהתאם לכלל ש-Sheet/Dialog שמורים ל-CREATE/EDIT ולאישורים.

- **מעטפת:** `fixed inset-x-0 bottom-0 z-40` (מעל השלד, מתחת לכל overlay ב-z-50) · `border-t border-line bg-white p-4` · תחתית safe-area ‏`pb-[max(1rem,env(safe-area-inset-bottom))]` · צל עדין כלפי מעלה בלבד · כניסה `slide-in-from-bottom` עם easing הבית (`cubic-bezier(0.16,0.84,0.26,1)`) + ‏`motion-reduce:animate-none` · ‏`roomy:hidden` (נסתר בדסקטופ אמיתי, נשאר בטלפון-לרוחב).
- **תוכן:** אייקון האפליקציה `/icons/icon-rounded.svg` ‏44px · כותרת `text-sm font-bold text-ink` · תת-שורה `text-xs text-ink-2` · CTA ‏`Button` ברירת-מחדל (44px) · ‏X ‏`ghost icon-sm` עם `hit-44 relative`.
- **מדריך iOS/דפדפנים בלי `beforeinstallprompt`:** ‏`Sheet side="bottom"` ‏(`rounded-t-2xl`) עם שלושה צעדים — צ'יפ-אייקון `h-10 w-10 rounded-xl bg-brand-soft text-brand-text` + טקסט `text-sm text-ink`.
- **תיאום FAB:** הבאנר וה-FAB חולקים את אותה פינה; כל עוד הבאנר מוצג ה-FAB מוסתר דרך `body:has([data-install-banner]) [data-agent-fab]` ‏(responsive.css).
- **תדירות:** פעם ב-session ‏(`sessionStorage`), השתקה 7 ימים אחרי סגירה, לעולם לא ב-standalone/אחרי התקנה. מפתחות: `almog:pwa-install:*`.

---

## אם משהו חסר כאן

לפני שאתה מנחש — בדוק שתי קומפוננטות קיימות באותה משפחה (טבלאות, קלפים, וכו'). אם אין דפוס קיים — שאל את המשתמש לפני שאתה ממציא וריאציה חדשה. עדכון ל-DESIGN.md הוא חלק מ-MR — לא משאיר decision לא-מתועד.

---

## חריגים מוצהרים

מסך /messages (צ'אט וואטסאפ) — חריג מאושר. מעוצב ירוק-וואטסאפ (#16a34a) כ-primary במקום blue-600, 1:1 עם ref/whatsapp.html, כדי לשמר זהות ויזואלית של וואטסאפ. אין להחיל עליו את כלל primary=blue. כל שאר המערכת ממשיכה כחול.

טופס אירוע יומן (`event-form-panel`) — חריג מאושר. שדות בגובה **44px (`h-11`)** במקום `h-10` הסטנדרטי בפאנלים, לפי החלטת המשתמש להתאמה פיקסלית ל-`ref/אירוע חדש`. חל **רק** על טופס האירוע ביומן; שאר הפאנלים (משימות/תקלות/ספקים) נשארים `h-10`.

גריד שבוע/יום ביומן — חריג מאושר. חלון השעות הוא **08:00–20:00** (שעות עבודה) במקום 07:00–20:00 שב-ref, לפי החלטת המשתמש. פריט מחוץ לחלון עובר clamp לשורת הקצה.

חיווי נוכחות בצ׳אט הפנימי (`/chat`) — חריג מאושר. ה**ירוק** (`emerald-500` נקודה, `text-emerald-600` לטקסט „מחובר עכשיו”) הוא חיווי **online/presence** בלבד — נקודה על האווטאר ב-header וברשימה, ושורת „● מחובר עכשיו” ב-header של שיחת 1:1. תואם את ה-Active-dot המוצהר (sect 9b). זה **אינו** primary — כל שאר הצ׳אט נשאר blue-600 (בועות נשלח, badge, כפתורים). הנוכחות נגזרת מ-`users.last_seen_at < 60s`, מתעדכנת חי דרך ה-SSE (`/api/chat/stream`).

### מסך כניסת פורטל הבעלים (`/portal/login`) — חריג מוצהר (28/09/2026)

**מקור-האמת העיצובי:** `/var/billing-proof/tenant-portal-login.md` + `Tenant Portal (standalone).html` (≥901px), הכלל ≤900 של `ref/Tenant Portal.html` **בטווח 601–900px** (עמודה אחת; פאנל המותג = פס עם הלוגו בלבד, `28px 24px`; שדות וכפתור בגדלי הדסקטופ; `.pane` = `40px 20px` — מ-28/09/2026 ערב), ו-`/var/billing-proof/tenant-login-mobile.md` + `Tenant Login Mobile (standalone).html` (**≤600px**). **ה-HTML גובר על מסמך זה בכל התנגשות, בהיקף המסך הזה בלבד** (החלטת מוצר 28/09/2026). הקבצים: `src/app/portal/login/page.tsx`, `src/components/portal/PortalLoginForm.tsx`, `src/components/portal/PortalLoginBrand.tsx`. אסור לייבא את הערכים למסכים אחרים, ו-`/login` של הצוות (`(auth)`, `components/auth`) אינו חלק מהחריג.

ערכים בלי טוקן, כ-arbitrary values במכוון:
- **פלטת slate של הרפרנס** במקום טוקני הסקין: `#0F172A` ink · `#334155` label · `#64748B` muted · `#94A3B8` soft/placeholder · `#E2E8F0` border · `#CBD5E1` border-strong · `#F5F7FB` field.
- **פאנל מותג:** gradient `linear-gradient(160deg,#0E1F5C 0%,#1633A8 55%,#2A55E8 100%)` (דסקטופ) / `165deg … 60% …` (מובייל); dot grid: `radial-gradient(rgba(255,255,255,.09) 1px,transparent 1px)` בשני הרפרנסים — תא 22px בדסקטופ, תא 20px במובייל (ההגדלה של המובייל מאותו יום בוטלה, החלטה 28/09/2026 ערב); טקסטים `#C9D3FF` / `#D6DEFF` / `#AFBDF5`; תיבת לוגו `rgba(255,255,255,.14)` + גבול `rgba(255,255,255,.25)`. כרטיס ה-preview (₪48,320 · 87% · 10 עמודות) מרונדר **כאיור סטטי** עם `aria-hidden`, בדסקטופ בלבד, בלי נתונים ובלי לוגיקה (החלטה 28/09/2026, מבטלת את ההסתרה מאותו בוקר).
- **שדות:** 48px / רדיוס 11 (דסקטופ), **54px / רדיוס 12** (מובייל), גבול 1.5px, focus ring מותגי — ולא `h-10` של הפאנלים. שגיאה = גבול `#E5484D` על רקע לבן (ולא `border-red-400 bg-red-50`); תיבת התראה `#FDECEC` / `#B03A3E`. קלט במובייל 17px (בלי zoom ב-iOS).
- **CTA:** `<Button>` של המערכת השטוחה עם override של **48px / רדיוס 11** (דסקטופ) ו-**54px / רדיוס 14 / 17px** (מובייל). ה-hover וה-disabled נשארים של המערכת (`#2C44E0`, `opacity-50`) ולא של הרפרנס (`#3149E0`, `#C9D3FF`).
- **תיבות קוד:** 56px / 22px (דסקטופ), 60px / 26px (מובייל), Inter 700, ריווח 10px / 8px.
- **מובייל:** sheet לבן ברדיוס `28px 28px 0 0` שחופף את ה-hero ב-28px; padding-top של ה-hero = `24px + env(safe-area-inset-top)` (ה-74px שברפרנס כוללים 50px של status bar שאינו חלק מה-viewport); padding-bottom של ה-sheet = `env(safe-area-inset-bottom)`.
- **קישורי "שינוי מספר" / "שליחה חוזרת":** `min-h-[44px]` (כלל ברזל 6) בתוך שורת ה-hint של הרפרנס.

#### שלב 2 — מסך הזנת הקוד: 16 המצבים (29/09/2026)

**מקור-האמת:** `ref/OTP States.html` + `ref/otp-states.md` (דיסק בלבד, מחוץ לגיט). הקובץ: `src/components/portal/PortalOtpStep.tsx`. שלב 1 (הטלפון) נשאר כפי שהיה מ-PR #43; כל מה שמתחת לכותרת "הזנת קוד" נבנה מחדש לפי הרפרנס.

- **תיבות (`.b`):** 58px / רדיוס 12 / Inter 700 26px, ריווח 8px, `dir="ltr"`. ריק `#F5F7FB`+`#E2E8F0` · מלא לבן+`#CBD5E1` · פוקוס `--brand` + `ring 4px rgba(61,90,254,.12)` · **שגיאה** `#E5484D` על `#FFF8F8` עם ספרה `#B03A3E` ורעידה `±4px` פעמיים (`portal-otp-shake` ב-`portal.css`, תחת `motion-safe:`) · הצלחה `#12A150` על `#E7F6EE` · נעול/פג-תוקף `#F1F5F9` עם ספרה `#94A3B8` · מאמת `opacity .55`.
- **שורת ההודעה:** אייקון 18px + טקסט 14.5px/500, בארבעה טונים — `err #B03A3E` · `warn #A15C07` על `#FEF4E2` · `ok #0B7A3B` · `info #64748B` על `#F5F7FB`. **קופסה צבעונית רק כשנדרשת פעולה** מהדייר (ניסיון אחרון, פג תוקף, אין חיבור).
- **כפתור ראשי:** 54px / רדיוס 14 / 17px. `dis #DCE2FF` עד שש ספרות · `on --brand` · `load` ספינר + "מאמת…" · `ok #12A150` + וי + "מחובר" · `sec` לבן עם גבול כשהפעולה היחידה אינה כניסה.
- **כרטיס שליחה חוזרת (state 09):** מופיע כשהטיימר מתאפס, במקומו. **פעולה אחת בלבד — "שלח שוב בוואטסאפ".** אין SMS במערכת ולכן הכפתור השני של הרפרנס לא נבנה.
- **חלונות:** חסימה = bottom sheet **שלא נסגר בהקשה על הרקע**, עם ספירה חיה; שגיאת מערכת = דיאלוג ממורכז עם `ERR-<status> · HH:MM` (הניסיון לא נספר, הקוד נשמר); מספר לא מזוהה = bottom sheet ענבר.
- **נגישות:** `aria-label="ספרה i מתוך 6"` לכל תיבה · `role="alert"` לשגיאה ו-`role="status"` לשאר · ספירת החסימה מוכרזת **פעם בדקה** (טקסט `sr-only` עם `aria-live="polite"`) בעוד המספר הנראה מתקתק כל שנייה · מטרות מגע 44px.
- **חריגות מוצהרות מהרפרנס:** 5 ניסיונות ולא 3 · אין SMS בשום מקום · state 16 מציע "הזנת מספר אחר" (ל"שליחת בקשת הצטרפות" אין זרימה במערכת).
- **`theme-color` לבן** מוגדר ב-`viewport` של `src/app/portal/layout.tsx` — `/portal` בלבד; אפליקציית הצוות שומרת את `#3D5AFE` של ה-root layout.
- **"פנייה לחברת הניהול"** (מצבים 12 ו-14) מחייג ל-`NEXT_PUBLIC_PORTAL_SUPPORT_PHONE`. **בלי ערך — הפעולה לא מצוירת.**

### פורטל בעלי הדירות (`/portal`) — חריג מוצהר (28/09/2026)

**מקור-האמת העיצובי:** `ref/Tenant Portal.html` (המסך `#scrPortal`) + `ref/tenant-portal-responsive.md`. **ה-HTML/CSS של הרפרנס גובר על מסמך זה בכל התנגשות, בהיקף `/portal` בלבד.** הקבצים: `src/app/portal/page.tsx`, `src/components/portal/Portal{Shell,Overview,Transactions,CategoryTrend,Reports,FundView,TxTable,BarChart,Soon,Icons}.tsx`, `src/lib/portal/{ui,blocks,export}.ts`, `src/app/styles/portal.css`.

- **סקין סקופי:** כל ה-CSS של הרפרנס הועתק כמו שהוא (ערכי px, צבעים, רדיוסים, צללים) לקובץ `portal.css` תחת `.portal-skin` — משתני ה-`:root` של הרפרנס מוגדרים על האלמנט הזה בלבד ולא נוגעים בטוקני ה-`@theme`. שמות שהתנגשו עם Tailwind או עם `buttons.css` קיבלו קידומת `p` (`.pgrid`, `.pring`, `.pbtn*`); כללי הטבלה תקפים רק בתוך `.tw`, כך שטאב הקרן (`FundTab` של `finance/*`, ללא שינוי) מרונדר כמו ב-`/finance?view=resident`.
- **Inter למספרים** (`.num` = `--font-inter` + `tnum` + `direction:ltr; unicode-bidi:isolate`), ו**gradient בפאנל המותג בכניסה** — שני החריגים ל"Heebo בלבד" ול"שטוח בלבד" בפורטל. Inter נטען פעם אחת ב-root layout (`--font-inter`) ולא נטען שוב ב-layout של הפורטל.
- **מבנה:** תוכן `max-width:1280px`, grid של 12 עמודות (`gap:20px`, 14 במובייל), כרטיסים ברדיוס 16 (`22px 24px`, 18 במובייל), top bar 68px בשורה אחת מעל 1180 · ≤1180 הטאבים בשורה נפרדת עם גלילה אופקית בלי scrollbar · ≤600 אווטאר בלבד. Breakpoints של הרפרנס: 1180 → 900 → 600 (`max-width`).
- **Top bar (סטייה מתועדת):** עם שם הבניין המלא ("מגדלי חוף הכרמל — בניין אלמוג, חיפה") ושישה טאבים שורת הרפרנס לא נכנסת ב-1280px (נמדד: 307 + 697 + 212 + מרווחים > 1216). ההחלטה: הטאבים ובלוק המשתמש **לא מתכווצים** (`flex:none`), ושם הבניין הוא שמתקצר ב-ellipsis (המנגנון של הרפרנס עצמו, `.bld b`). ב-≤1180 בלוק הבניין `flex:1 1 0` כדי שהמשתמש יישאר בשורה הראשונה.
- **גרף:** SVG ידני לפי `drawChart` (padding 28/44, `bw=min(18, gw×.28)`, תווית כל חודש שני כשהקבוצה צרה מ-34px, redraw ב-`ResizeObserver`, tooltip `.tip` על hover, לחיצה על חודש → טאב "הכנסות והוצאות" של אותו חודש). בלי ספריית גרפים. ציר Y ב-`niceAxis` (4 מדרגות "יפות") — הרפרנס השתמש במקסימום קבוע.
- **טבלאות:** 5 עמודות (תיאור · קטגוריה · תאריך · סכום · מסמך) ב-`.tw`; ≤600 list rows לפי ה-MD. תגית `t-green` להכנסה / `t-gray` להוצאה; סכום `+` ב-`green-ink` (`.amt.in`) / `−` ב-`red-ink` (`.amt.out`); **תאריך: הוצאה `DD.MM.YYYY`, הכנסה `MM.YYYY`** (להכנסה אין תאריך — רק חודש). אין שורת `.sb` (הרפרנס מציג שם צד-נגדי, ושם ספק לעולם לא יוצא לפורטל). כפתור `.doc` רק כשמתג "הצג מסמכים לדיירים" דלוק.
- **בלוקים כבויים (`PORTAL_BLOCKS`, `src/lib/portal/blocks.ts`):** "היתרה שלך לתשלום", "יתרת קופת הבניין", "שיעור גבייה" + "X מתוך Y דירות שילמו" — כבויים; ה-markup וכללי ה-grid נשמרים, הדלקה משחזרת את הרפרנס. כשהם כבויים: שני KPI ב-`c6` בדסקטופ, **שניים זה לצד זה במובייל** (הכלל "הראשון על שתי העמודות" חל רק ב-`data-count="3"`).
- **פורמט סכום של הרפרנס:** `₪8,820` (סימן צמוד, קיבוץ en-US) — `fmtIls`.
- **עיגול לתצוגה (28/09/2026 ערב):** כל סכום כספי בפורטל ובתצוגת הדייר של האדמין מוצג ב**שקלים שלמים, בלי אגורות**, בעיגול חשבוני רגיל (0.5 מעלה, על הערך המוחלט: `1,240.60 → ₪1,241`, `−2.5 → −₪3`) — דרך פונקציה אחת, `fmtIls` (`roundShekels`) ב-`src/lib/portal/ui.ts`; אין עיצוב סכום אחר בפורטל, וגם טאב הקרן (`FundTab` ב-`residentMode`) מקבל אותה דרך `format`. **סכומים מסכמים** (סה״כ, ממוצע, הפרש, אחוזים, שינוי מול חודש קודם) מחושבים תמיד מהסכומים המדויקים (`sumExact`, ה-totals של השרת) ומעוגלים רק בתצוגה — הפרש של ₪1 בין סכום השורות המעוגלות לסה״כ תקין. הסימן של הפרש/מאזן נקבע **אחרי** העיגול (`fmtSigned`: `₪0`, לא `−₪0`; `fmtDelta`: `₪0`, לא `+₪0`). **לא משתנה:** ה-DB, החישובים בשרת, מסכי ההזנה ב-`/finance` (`ils()`), והייצוא לאקסל — הסכום המדויק כמספר עם `numFmt '#,##0.00'`.
- **צבעי הכנסות והוצאות (28/09/2026 ערב):** כל סכום של הכנסה ב-`--green-ink` (`#0B7A3B`), כל סכום של הוצאה ב-`--red-ink` (`#B03A3E`), הסימנים `+`/`−` נשארים — המחלקות `.in`/`.out` על `.amt`, `.kpi .v`, `.cat .a` ו-`.tip` (portal.css — ב-`.tip` אותן מחלקות, אך בטוקנים הבהירים; ראה החריג שמתחת), ובטאב הקרן `amountTones(residentMode)` (`table-shared.tsx`: `text-(color:--green-ink)` / `text-(color:--red-ink)`; באדמין נשארים emerald/rose). חל על שורות טבלאות ו-list rows, המספר הגדול ב-KPI "הכנסות"/"הוצאות", סכומי קטגוריות, סה״כ וממוצע בדוחות, שורות ה-tooltip של הגרף, וההכנסות/הוצאות/מאזן בקרן. **חריגים:** הפרש/מאזן/עודף — ירוק כשחיובי, אדום כשלילי, נייטרלי ב-0 (`signClass` לפי הערך המעוגל); יתרת בנק והכרטיס הכהה — נייטרליים; "החשבון שלי" — חוב מעל 0 ב-`red-ink` (`.v.red`); שורת `.d` ב-KPI — ירוק/אדום שם = "טוב"/"רע", לא הכנסה/הוצאה, ללא שינוי; עמודות הגרף — 1:1 לרפרנס (כחול להכנסות, ורוד/אדום להוצאות).
- **ניגודיות ה-tooltip של הגרף (29/09/2026):** ה-tooltip הוא המשטח **הכהה** היחיד שסכום נוחת עליו (רקע `--ink` `#0F172A`), ושם טוקני ה-ink כהים מדי: `--green-ink` `#0B7A3B` = **3.28:1**, `--red-ink` `#B03A3E` = **2.99:1** — שניהם מתחת ל-**4.5:1** של WCAG AA. לכן **בתוך `.tip` בלבד** אותן מחלקות `.in`/`.out` מקבלות את הטוקנים הבהירים של הסקין: `--green` `#12A150` = **5.30:1**, `--red` `#E5484D` = **4.56:1**. **אין החלפה גלובלית** — על הכרטיסים הלבנים הזוג הבהיר דווקא **נכשל** (`--green` 3.37:1, `--red` 3.91:1), ולכן השורות, ה-KPI, הקטגוריות, סה״כ/ממוצע בדוחות והקרן נשארים ב-`green-ink`/`red-ink` בדיוק כפי שהיו. ערך נייטרלי (`signClass` מחזיר `''` ב-0) אינו נושא מחלקה ונשאר בלבן של ה-tooltip, והפרש לפי סימן מקבל את אותו טיפול. חל על שני הגרפים שמשתמשים ב-`PortalBarChart` (סקירה + שורת קטגוריה נפתחת בדוחות). בלי hex חדש ובלי טוקן חדש. נאכף ב-`e2e/portal-numbers.spec.ts` — הצבע המחושב של שורת הכנסה ושל שורת הוצאה ב-tooltip, רקע ה-tooltip (הבסיס שעליו נמדדה הניגודיות), ובאותה בדיקה עצמה גם השורות וה-KPI, כך שהחלפה שתזלוג מחוץ ל-`.tip` תיפול.
- **URL:** `?tab=ov|tx|fund|rep|acc|dec`, `m=YYYY-MM|YYYY-Qn|YYYY-Hn|YYYY` (**התקופה של טאב "הכנסות והוצאות"**, ארבע הרמות), `r=YYYY-Qn|YYYY-Hn|YYYY` (דוח), `n=6|12` (סקירה), `f=in|out` (סינון). `?tab=fund` הישן ממשיך לעבוד, וגם קישור ישן שנושא **רק** `?m=` — בכל אחת מארבע הצורות — נוחת על טאב "הכנסות והוצאות" באותה תקופה, בדיוק כפי שנחת לפני העיצוב מחדש. הקישורים נבנים ב-`usePortalHref` מה-pathname הנוכחי ונושאים `view`/`apt`, כך שאותם רכיבים משרתים גם את התצוגה המקדימה של האדמין ב-`/finance?view=resident`.
- **"החשבון שלי" והכרטיס הכהה (28/09/2026 ערב):** הכרטיס `.mine` (c4, 1:1 לרפרנס בלי כפתור התשלום): הסכום הגדול = `total_debt` (סכום על כל דירות הטלפון), תגית `t-red` "חוב פתוב" מעל 0 / **`t-ok` "אין חוב"** ב-0 (`rgba(18,161,80,.2)` / `#9BE3B8`), `.row2` = "דמי ניהול ₪X" · "מים חמים ₪Y", שורת `.asof` "נכון ל-DD.MM.YYYY" (13px `#AAB4C8`), וכפתור `.pbtn.pbtn-lg.pbtn-more` ("לפירוט המלא", `rgba(255,255,255,.1)`, טקסט לבן) → טאב `acc`. הטאב "החשבון שלי": 4 `.card.kpi.c3` (יתרה לתשלום ב-`red-ink` מעל 0; חיוב חודשי כטקסט `.v.txt` 18px/margin-top 14px), כרטיס "פירוט" (`.details`, `white-space: pre-line`, טקסט בלבד), הכרטסת מהרפרנס נבנתה ומוסתרת ב-`PORTAL_BLOCKS.ledger=false`, הערת שוליים `.foot` 13px `ink-muted`. **דירה מאורכבת עם חוב (בהליך משפטי או אצל פתאל) רואה את החוב שלה בדיוק כמו כל דירה אחרת** — אותם שדות, אותו כרטיס, בלי תגית/סימון/טקסט על ארכוב, הליך משפטי או פתאל (החלטת רונן 28/09/2026 ערב; החליפה את כרטיס "הנתונים בבדיקה מול חברת הניהול"). טלפון עם כמה דירות = בלוק `.acc-block` לכל דירה.
- **התאריכון בלחיצה אחת של "הכנסות והוצאות" (29/09/2026) — יכולת קבועה, אסור להסיר:** **אותה קומפוננטה** של `/finance` — `src/components/finance/PeriodPicker.tsx` עם `residentMode` ו-`variant="portal"` — בתוך ה-`.per` שב-`.hd` של הטאב. ה-trigger לובש את `.sel` של הרפרנס (ומקבל ממנו גם רוחב מלא ב-≤600 ו-`min-height:44px` ב-`pointer:coarse`); הפאנל זהה למשטח הצוות: כותרת « כל YYYY » בין שני חצים (החץ הימני = שנה קודמת ב-RTL), לחיצה על השנה בוחרת שנה שלמה, רשת חודשים **3×4** שכל שורה בה רבעון עם תווית "רבעון N" לחיצה, וכל זוג שורות מחצית עם תווית אנכית "מחצית א׳/ב׳". בחירת רבעון/מחצית/שנה צובעת את **כל** החודשים שבטווח כבלוק (`bg-brand-soft` + `border-brand-border`) והתווית עצמה מודגשת (`bg-brand`). **כל לחיצה בוחרת וסוגרת — אין מצב טווח ואין לחיצה שנייה.** מובייל = bottom sheet, דסקטופ = popover. אצל דייר: רק חודשים **מפורסמים** לחיצים (נקודה ירוקה `emerald-500`), ורבעון/מחצית/שנה לחיצים רק אם יש בהם חודש מפורסם (`rangeHasPublished`); חודש עתידי תמיד אינרטי. ברירת המחדל = החודש האחרון שפורסם, ותקופה שדייר לא רשאי לפתוח חוזרת אליו (`residentPeriodFor`). הבחירה נכתבת ל-`?m=` ב-`startTransition` והשרת מרנדר מחדש (`key={period.key}`). **ה-accent הוא `bg-brand` `#3D5AFE`** — ה-primary של המערכת השטוחה, וגם הברנד של הרפרנס; ה-`blue-600` שהיה שם קדם למערכת השטוחה ותוקן כאן בשני המשטחים. **כל נתוני הטאב נגזרים מהתקופה** — KPI, שורות, קטגוריות, ייצוא ה-xlsx, ויתרת הבנק שהופכת ל"יתרת בנק לסוף התקופה" (החודש המפורסם האחרון בתקופה שיש לו ערך). לתקופה מרובת-חודשים נוספים שני אלמנטים בלבד: שורת `.note` "כולל N מתוך M חודשים" וכרטיס `c12` "הכנסות מול הוצאות" עם `PortalBarChart` — **עמודה לכל חודש מפורסם בתקופה** (חודש מוסתר אינו חור בגרף, הוא פשוט לא שם), ולחיצה על עמודה פותחת את אותו חודש. **חודש בודד מרונדר בדיוק כמו קודם** — בלי גרף ובלי שורת ה-N מתוך M.
- **מגמת קטגוריה בטאב "הכנסות והוצאות" (06/10/2026):** כל שורת קטגוריה — בכרטיסי "הכנסות לפי קטגוריה" ו"הוצאות לפי קטגוריה" — היא `<button>` (`.cat.cat-tg`, `aria-expanded`) שנפתח ונסגר בלחיצה על כל השורה; chevron (`ChevronIcon`, `--ink-soft`) בעמודה השלישית של ה-grid = **הקצה השמאלי** בשורה הראשונה, מסתובב 180° בפתיחה (`.15s`). הסכום והאחוז בשורה = **סך התקופה של התאריכון, ללא שינוי**. ה-padding של הכפתור (`6px 0`) מרים את משטח המגע ל-≥44px וה-gap של הרשימה ירד בהתאם (`.cats.tgl` = `2px`, 6+2+6 = 14 הקודם) וכך גם ה-margin העליון שלה (18 → 12, בגלל ה-6 של השורה הראשונה) — השורות לא זזו. `.cats`/`.cat` של הסקירה **לא נגעו** (שם השורות אינן לחיצות). **הפאנל הפתוח** (`PortalCategoryTrend`): גרף עמודות של **עד 12 החודשים המפורסמים האחרונים** של הקטגוריה — לא תלוי בתאריכון — מ-`GET /api/portal/finance/categories/[id]/monthly` בפתיחה הראשונה, נשמר בזיכרון הדף עד רענון. SVG ידני בתוך קופסה `dir="ltr"` (`.trend`, 180px; ≤600: 160px) — **ישן משמאל, חדש מימין**, ושאר השורה RTL; עמודה דקה לכל חודש (`min(14, 42%` מרוחב העמודה`)`, מינימום 4) **מעוגלת למעלה בלבד** (רדיוס 4), בגוון הרך של הסוג — הוצאה `--red-soft` `#FDECEC`, הכנסה `--green-soft` `#E7F6EE` — והעמודה הפעילה בגוון המלא (`--red`/`--green`); חודש מפורסם בלי תנועות = עמודה בגובה 0 (התווית נשארת). ציר Y: `trendAxis` — 4–5 קווים (`#EEF1F6`) שהעליון בהם קרוב מעל העמודה הגבוהה (המדרגה ה"יפה" הקטנה, 1·2·2.5·5×10ⁿ, שמכסה את המקסימום בעד ארבע מדרגות; `niceAxis` של שאר הגרפים תמיד מצייר ארבע ויכול להעמיד את הראש על כמעט פי שניים — 80K מעל עמודה של 43K), עם תוויות `axisLabel` (`0 · 5K · 10K · 20K`, Inter 11 `#94A3B8`). תווית חודש: `monthShort` (Heebo 12, 11 בעמודה צרה מ-30px, `#64748B`), ו**כשהחלון חוצה שנים — שתי ספרות שנה בכל התוויות** ("דצמ׳ 25"); כשאין מקום — כל תווית k-ית, נספר מהחדש (החדש תמיד מתויג). ריחוף (עכבר) / הקשה (מגע) → `.tip` הכהה הקיים: שם החודש + הסכום המלא `₪X,XXX` (`fmtIls`, `.num .in/.out` — הזוג הבהיר של ה-tooltip), מעוגן לקצה השמאלי/הימני בשליש הקיצוני כדי לא לצאת מהכרטיס. **מצבים:** "טוען…" (בגובה הגרף), "אין נתונים להצגה" (קטן, ממורכז — כשאין חודש עם סכום), "לא ניתן לטעון את הגרף." + "נסה שוב". **בתצוגה המקדימה של האדמין** אין session של פורטל, ולכן הפאנל מציג הערה ("בתצוגה המקדימה הגרף אינו נטען — בעלי הדירות רואים אותו בפורטל.") ולא פונה ל-API. **מחוץ לתחום:** בלי ספריית גרפים, בלי השוואת שנים, בלי הדגשת התקופה הנבחרת.
- **"יתרת קופת הבניין":** ה-KPI של הרפרנס חזר (`PORTAL_BLOCKS.cashBalance`), מוצג רק כשמתג "הצג יתרת בנק לדיירים" דלוק ויש ערך לחודש מפורסם; `.d` = "+/−₪X מול החודש הקודם" רק כשלחודש המפורסם הקודם יש ערך. בטאב "הכנסות והוצאות" KPI רביעי "יתרת בנק לסוף החודש" (`.kpis[data-count="4"]`, 4 עמודות; ≤600 שתיים). בלי ערך — ה-grid נסגר בלי חור (שני KPI ב-c6 / שלושה עם המקומי).
- **Top bar:** הטקסט ב-`.bld b` הוא **"בניין אלמוג, חיפה"** (השם המלא נשאר בכניסה וב-`<title>`); נמדד 28/09/2026 ערב: ב-1280 וב-1440 שורה אחת — בניין 177 · טאבים 621 · משתמש 240 מתוך 1216, בלי ellipsis. הכלל `flex:none` לטאבים ולמשתמש נשאר כרשת ביטחון.
- **שדה האדמין "יתרת בנק לסוף החודש"** (`BankBalanceField`, `/finance` שוטף, ליד טוגל הפרסום): `Input` בגובה `h-[38px]` (כמו pill הטוגל), `dir=ltr` + `font-num`, שמירה ב-blur/Enter, Escape מחזיר, × מוחק; מצב שגיאה `border-red-400 bg-red-50`. קריאה בלבד = pill עם הערך.
- **תצוגה מקדימה של האדמין** (`/finance?view=resident`): פס `role=status` בסגנון באנר ה-indigo של DESIGN (`border-indigo-200 bg-indigo-50`), טקסט "תצוגה מקדימה — כך רואה דייר", `select` דירה `h-10 rounded-[10px]`, וכפתור `outline` "יציאה מתצוגת דייר" — מחוץ ל-`.portal-skin`. הפורטל עצמו ב-`preview` בלי כפתור התנתקות.

### פורטל — "דיווח על תקלה" (`/portal/report`) — חריג מוצהר (03/10/2026)

**מקור-האמת העיצובי:** `ref/issue-report-form.md` (המפרט) + `ref/Issue Report Form (standalone).html` ו-`ref/issue-report-form (1).png` (רפרנס ויזואלי). הרפרנס גובר על מסמך זה בהיקף המסך הזה בלבד, **למעט חריגות שהוחלטו (03/10/2026) וגוברות על הרפרנס:** תמונות בלבד (אין וידאו), עד 5, מונה "2/5 תמונות"; אין כפתור/מסך מעקב ואין אזכור לוואטסאפ — במסך 04 כפתור אחד "חזרה לדף הבית" (ראשי) והטקסט "חברת הניהול קיבלה את הדיווח ותטפל בו בהקדם."; סיכום 04 = מספר קריאה · מיקום · דחיפות · תמונות; אין שדה דירה. הקבצים: `src/components/portal/PortalIssueReport.tsx`, `src/app/portal/report/page.tsx`, `src/app/styles/portal-report.css`, `src/lib/portal/{issueReport,imagePrep}.ts`.

- **סקין:** תחת `.portal-skin`, כל המחלקות בקידומת `pir-` (`portal.css` כבר מחזיק `.hd`, `.foot`, `.chips`, `.note`, `.tag`). ערכי ה-px, הרדיוסים והגופנים 1:1 לרפרנס. העמודה `max-width:560px` במרכז; מ-601px עם גבול צד `var(--border)` על רקע `--bg` של הפורטל.
- **טוקנים:** כל צבע שיש לו מקבילה בסקין הפורטל — דרך המשתנה שלו (`--brand*`, `--ink*`, `--border*`, `--field`, `--red*`, `--green*`, `--amber*`). **חמישה ערכים בלי מקבילה — מקומיים למסך** (`.pir`): `--pir-field-err #FFF8F8` (רקע שדה בשגיאה) · `--pir-tile #FAFBFF` (אריחי מדיה, "+") · `--pir-btn-dis #DCE2FF` (כפתור השליחה לפני מוכנות) · `--pir-thumb #E9EDF5` (רקע ממוזערת) · `--pir-ring rgba(61,90,254,.12)` (טבעת פוקוס). לא נוספו לטוקנים הגלובליים.
- **סטיות מכוונות מהמוק הסטטי:** ריפוד עליון של הכותרת 10px (+safe-area) במקום 4px — ה-4px של הרפרנס יושבים מתחת לפס סטטוס מדומה. הצ'יפים המהירים מוצגים כל עוד "מיקום" ריק (גם במצב שגיאה — הדרך המהירה למלא אותו). שורת הממוזערות נשברת לשורה שנייה (5×64px לא נכנסים ב-320px). צ'יפים (30px) ו-× (22px) מקבלים hit-area של 44px ב-`::after`. ה-"+" פותח שורת בחירה "צילום / גלריה" מתחת לממוזערות (לא popover — לא חורג מהמסך ב-360px).
- **כפתור השליחה:** נראה מושבת (`--pir-btn-dis`) כל עוד שדה חובה ריק ולא בוצע ניסיון (מצב 01), **אבל לחיץ** — הלחיצה היא הדרך למצב 03. מושבת באמת רק בזמן כיווץ תמונה או שליחה (ספינר על הממוזערות ועל הכפתור).
- **ולידציה:** בשליחה; מאז כל שדה שהציג שגיאה נבדק חי. באנר `role="alert"` "יש למלא N שדות חובה" (1 = "יש למלא שדה חובה אחד"), גלילה ופוקוס לשגיאה הראשונה. שגיאה בשדה בפוקוס שומרת את הגבול האדום עם טבעת אדומה.
- **הכניסה (`PortalShell`):** כפתור `pbtn pbtn-primary pbtn-lg` "דיווח על תקלה" (אייקון משולש אזהרה) **בראש התוכן של כל טאב**, מיושר לסוף (שמאל); ≤600 ברוחב מלא. **לא ב-top bar:** השורה האחת של הרפרנס (בניין · שישה טאבים · משתמש) נמדדה עם ~114px פנויים ב-1280 (ה-`top-in` מוגבל ל-1280, ולכן גם ב-1440), ועם שם בעלים של כמה דירות — אפס; כפתור עם תווית שם דחף את שם הבניין ל-ellipsis. נמדד 03/10/2026: ה-top bar זהה לפיקסל ל-`main` ב-360/601/1181/1280/1440. לא מוצג בתצוגה המקדימה של האדמין.

### פורטל — טאב "החלטות ופרוטוקולים" (`?tab=dec`) — חריג מוצהר (05/10/2026)

**מקור-האמת העיצובי:** `ref/portal/decisions-tab.md` (המפרט) + הטאב `dec` ב-`ref/portal/Tenant Portal (standalone).html` ו-`ref/portal/decisions-{desktop,mobile}.png`. הרפרנס גובר על מסמך זה בהיקף הטאב הזה בלבד, **למעט חריג אחד שהוחלט (05/10/2026) וגובר על הרפרנס: אין שורת צ'יפים של קטגוריות** (הכל / אסיפות דיירים / תקציב וכספים / תחזוקה ושיפוצים / פרוטוקולים). סרגל הכלים הוא **שדה החיפוש בלבד**, ולכן גם **תגית הנושא האפורה ירדה משורת ה-meta** — אין עמודת `topic` בסכימה, ואין במה לקבץ מלבד סוג המסמך. הקבצים: `src/components/portal/PortalDecisions.tsx`, `src/app/styles/portal.css` (הבלוק "החלטות"), `src/lib/decisions.ts`.

- **סקין:** תחת `.portal-skin`, ערכי ה-px של הרפרנס 1:1. מחלקות: `.dec-tools` · `.srch` · `.yr` · `.drow`/`.dmain`/`.dic`/`.dtx`/`.dmeta`/`.dbody`/`.dact` · `.fsz`. ה-`.chev` של הטאב מוגדר **תחת `.drow`** כי `portal.css` כבר מחזיק `.tw tr.exp .chev` בסקופ אחר.
- **מבנה:** רשימה שטוחה אחת, מהחדש לישן, חתוכה ב**מפרידי שנה** (`.yr`, Inter 700 13px `--ink-soft`, קו לשמאל) מעל כרטיס סרגל כלים. שורה מכווצת: אריח PDF 42×42 רדיוס 11 ב-`--red-soft`/`--red-ink` · כותרת 15.5px/600 · שורת meta 13px (**תגית סוג · תאריך `DD.MM.YYYY` · "PDF · גודל"**) · chevron שמסתובב 180° בפתיחה. פתוחה: `--brand-border` + צל רך, divider מקווקו, פסקת תקציר (14.5px, `max-width:640px`), ושני כפתורים.
- **תגית הסוג:** "החלטה" + המספר כשקיים ("החלטה 14/2026") ב-brand-soft (`--brand-soft`/`--brand-ink`, inline — אין לה tone מוכן ב-`portal.css`); "פרוטוקול" ב-`t-green`. **פרוטוקול לעולם לא נושא מספר**, גם אם יש ערך בעמודה.
- **הכפתורים:** "פתיחת המסמך" (`pbtn-primary pbtn-sm`, טאב חדש) ו"הורדה" (`pbtn-secondary pbtn-sm`, אותו נתיב עם `?download=1`). **בפורטל** שניהם מצביעים על `/api/portal/decisions/<id>/file` — **לעולם לא על `/api/files` ולא על ה-bucket**; מפתח האובייקט לא מגיע ללקוח כלל.
- **בתצוגת הצוות (`/finance?view=resident&tab=dec`, 07/10/2026):** לצוות אין session פורטל, ולכן הכפתורים הולכים בנתיב הצוות `/api/files/portal-decisions/<key>` (`portal_decisions:view`). **צוות בלי `portal_decisions:view`** (נכנס לתצוגה דרך `finance:view` בלבד) — השורה נפתחת כרגיל עם התקציר, אבל **במקום שני הכפתורים** מופיעה שורה אחת `.dlock` (13px, `--ink-muted`, אותו מרווח עליון של `.dact`): "תצוגה בלבד — פתיחת המסמך והורדתו דורשות הרשאת „החלטות ופרוטוקולים”." — ולא כפתורים שעונים 403 אחרי לחיצה. גם מפתח האובייקט לא נשלח אליו. ה-403 בנתיב נשאר כהגנה.
- **מצבים:** חיפוש בלי תוצאות → "לא נמצאו תוצאות" + "נסו מילת חיפוש אחרת או נקו את החיפוש." (ללא המילה "סינון" — אין סינון). **אין מסמכים כלל** → המצב הריק של הטאב (`.card.empty`, אריח PDF): "עדיין לא פורסמו החלטות או פרוטוקולים" — ולא שדה חיפוש מעל כלום.
- **מובייל (≤600):** אריח 38×38, כותרת 14.5px, `.fsz` (גודל הקובץ) מוסתר, כפתורים ברוחב מלא, `.dbody` בלי ההזחה של 56px. **אין `padding-bottom` ל-bottom nav** — ראה הסעיף הבא.
- **ניווט — אין bottom nav (מחייב):** ה-ref HTML מחזיק `.bnav` בן שלושה פריטים (סקירה · החלטות · עוד) + bottom sheet, אבל **הפורטל הבנוי לא מימש אותו מעולם**: שורת ששת הטאבים (`.nav`) היא הניווט בכל רוחב, ומ-1180px ומטה יורדת לשורה משלה עם גלילה אופקית (ראה "פורטל בעלי הדירות — חריג מוצהר" למעלה). הטאב `dec` כבר ישב שם כ-placeholder עם תג "בקרוב"; ב-05/10/2026 הוא חובר והתג הוסר. **מפרט שנגזר מה-ref עלול להניח bottom nav — אין כזה, והוספתו היא שינוי מבנה הניווט של כל הפורטל.**

### מודול צ׳יפים — חריג מוצהר (08/2026)

**מקור-האמת העיצובי: `/var/billing-proof/Chip2.html` (חלון ההנפקה הרב-אישי) + `/var/billing-proof/Chip2.md` (השפה הוויזואלית — פלטה/טיפוגרפיה/מידות; זהה בתוכנו ל-`Chip.md` המקורי). הרפרנס גובר על מסמך זה בכל התנגשות, בהיקף מודול הצ׳יפים בלבד** (החלטת מוצר). הרפרנס המקורי `/var/billing-proof/whatsapp-broadcast/Chip.html` **הוסר מהדיסק** — העיצוב שנגזר ממנו מיושם בקוד וסעיף (א) להלן נשאר התיעוד שלו. ה-scope נאכף טכנית: כל הטוקנים מוגדרים כ-CSS vars תחת המחלקה **`.chips-skin`** (`src/app/styles/chips.css`) — שום ערך לא דורס את ה-`@theme` הגלובלי, ו-`font-num` הגלובלי נשאר Inter. אסור לייבא את פלטת הצ׳יפים למסכים אחרים.

**(א) נגזר ישירות מהרפרנס (מחייב 1:1) — חלון ההנפקה (`IssueChipSheet`):**

- פלטה: brand `#3D5AFE` (hover `#2E49E8`, soft `#EEF1FF`, ink `#2B3FB8`, border `#C9D3FF`) · ink `#141B34`/`#5A6386`/`#98A0BC`/`#C9CEE0` · גבולות `#E7EAF4`/`#D6DAEA` · רקע `#EEF1F8`, משטח משני `#FAFBFE`, hover `#F3F5FC` · ירוק `#22A06B` (soft/border/ink) · ענבר `#F5A524` · סגול `#7C4DFF` · אדום `#E5484D`.
- header גרדיאנט `linear-gradient(115deg,#2B3FB8,#3D5AFE 62%,#5872FF)`; 5 כרטיסי סעיף (ראש עם אייקון-tone + קו מפריד): דירה=כחול, בעל הצ׳יפ=סגול, סוג=ענבר, מספרים=כחול, עמלה=ירוק.
- כרטיסי תפקיד 2×2: ריק=גבול מקווקו + „השלם פרטים ›”; נבחר=גבול brand + רקע soft + טבעת + עיגול ✓; תגית „גר בדירה” (soft-blue, לבנה בנבחר).
- Segmented פיזי/אפליקציה: מיכל alt מרופד radius 13, פעיל=brand + צל.
- מספרי צ׳יפ: שורת הוספה (קלט מונו + „+ הוסף מספר”, Enter מוסיף) → תגיות; **אין מחיקת צ׳יפ מונפק** — הסרה קיימת רק לתגית *ממתינה* (טרם הונפקה); כיתוב „צ׳יפ שהונפק לא נמחק…”.
- מידות: קלט/כפתור 44px (footer 46px) · רדיוסים 22/16/13/11/9/6 · תגית 22px · טיפוגרפיה: כותרת 21/800, סעיף 15.5/800, תווית 13/700, קלט 14.5.
- Checkbox מסומן = **ירוק** `#22A06B` + ✓ לבן (22px, radius 7).
- **מספרים ב-IBM Plex Mono** (`--font-chip-mono` → `.chip-num`, `direction:ltr`, tabular) — חריג לחוק „Inter בלבד”; תקף רק בתוך `.chips-skin`.
- Footer: ראשי בהתחלה (RTL), spacer, „סגור” בסוף.

**(ב) הורחב לפי הפלטה (החלטות עיצוב שלי — הרפרנס לא מכסה):**

- טבלת `/chips`: **שם המחזיק = העמודה הראשית** (מתחתיו דירה + badge תפקיד); מספר צ׳יפ כתגית-ref (פעיל=ירוק, לא-פעיל=**אדום** מקווקו+קו-חוצה); badges „לא במרשם”, „N צ׳יפים”, match-type; empty-state ייחודי לחיפוש.
- KPI cards (4: פעילים · באפליקציה · אבדו ב-30 יום · דירות ללא צ׳יפ פעיל), פאנל מחזיק (`ChipHolderPanel`, קריאה בלבד), ChipsTab בפאנל הדירה, mobile cards — אנטומיית DESIGN.md עם פלטת הרפרנס. **`ChipDetailPanel` נמחק (09/2026)** — אין פאנל פרטים, אין טאב היסטוריה, אין מנגנון "בקר" (הטאב "ממתין לחסימה בבקר", כרטיס ה-KPI וכפתור "סומן בבקר" הוסרו; העמודה `controller_synced` נשארה ב-DB בלי UI). **כל לחיצה על צ׳יפ בכל מקום — שורת טבלה (דסקטופ+מובייל), שורה בפאנל המחזיק, שורה ב-ChipsTab, deep-link `?chip=` מהתראות — פותחת אך ורק את חלון ההנפקה של הדירה של אותו צ׳יפ.** למשתמש ללא `chips:edit` השורות אינרטיות (לחלון אין מצב קריאה).
- מה שהרפרנס לא מגדיר נופל ל-DESIGN.md: error state (`border-red-400 bg-red-50`), loading/skeletons, dialogs לאישורים, mobile, ו-touch targets (חיצי הפעולה מקבלים hit-area ‏44px גם כשהוויזואל 30px).

**התנגשויות שתועדו (הרפרנס ניצח, בהיקף המודול):** פונט מספרים (IBM Plex Mono במקום Inter) · גווני ink/גבולות/רקעים (וריאנט מוזז של ה-skin) · brand-hover `#2E49E8` במקום `#2c44e0` · גרדיאנט header שונה מ-§28.2 · גובה קלט 44px במקום `h-10` · checkbox ירוק במקום brand · רדיוסים ייעודיים · משפחות ירוק/ענבר/סגול hex במקום Tailwind tones · footer עם ראשי-בהתחלה במקום `PanelFooter` המשותף.

**(ג) חלון ההנפקה הרב-אישי (08/2026) — מקור כל אלמנט:**

| אלמנט | מקור |
|---|---|
| בלוק "בעל צ׳יפ" חוזר (`.oblock`): גבול 1.5 `--chip-violet-border` (`#DECDFF` — טוקן שנוסף מ-Chip2), radius 14, badge ממוספר מונו 28px, ראש שם+תפקיד, מצב ריק מקווקו | Chip2 ‏1:1 |
| מפריד (`.sepline`) + תווית "מספרי הצ׳יפ של {שם}" | Chip2 ‏1:1 |
| כפתור "+ הוסף בעל צ׳יפ" — רוחב מלא, 48px, מקווקו סגול-soft | Chip2 ‏1:1 |
| תגית ממתינה — **ענבר מקווקו**, מצב "ממתין להנפקה" + נקודה ענברית, X לבן-ענבר (אדום ב-hover); ‏409 → אדום + "מספר תפוס" | Chip2 ‏1:1 (מצב ה-409 — אקסטרפולציה) |
| תגית צ׳יפ **שמור** — פעיל = ירוק (`--chip-green-*`); **לא-פעיל = אדום** (09/2026, מחליף את האפור): גבול מקווקו `--chip-red-border`, רקע `--chip-red-soft`, מספר `--chip-red-ink` + קו-חוצה, badge "לא פעיל" לבן עם נקודה `--chip-red`, badge סוג וטוגל באותה משפחה. נבדל מתגית ה-409 הממתינה, שמשתמשת ב-`--chip-red` החזק ובתווית "מספר תפוס" | הנחיה גוברת (צילום עיצוב). **האדום חל על כל המודול, ללא חריגים** — חלון ההנפקה, טבלת `/chips` (`ChipNumberTag`/`StatusPill`), `ChipsTab` (`ChipRow`) ו-`ChipHolderPanel`, באותם ערכים בדיוק. מחוץ לחלון ההנפקה זה שינוי classes בלבד — אין טוגל בטבלה/בטאב/בפאנל המחזיק. התווית האחידה בכל המודול: **"לא פעיל"** (לא "מושבת") |
| בורר סוג פר-מספר (`.typemini` בשורת ההוספה) + badge סוג על כל תגית (אייקון+טקסט בגבול inline-start) | Chip2 ‏1:1, כולל התווית **"כרטיס"** (09/2026 — מחליף את "פיזי"; ערך ה-DB `chip_type='physical'` לא השתנה) |
| בורר תפקידים בתוך בלוק | **Chip2 ‏1:1 (החלטת משתמש 09/08, מחליפה את ההחלטה הקודמת לשמור 2×2)**: שורה קומפקטית אחת — 4 כפתורים `flex-1` בגובה 40px, radius 10, ✓ בתוך הכפתור; ‏sel=brand+טבעת, ‏taken=`.taken` (רקע alt, ✓ רפאים, not-allowed), תפקיד ללא פרטים=disabled; פרטי המרשם/"גר בדירה"/"השלם פרטים" עברו לשורת hint ‏(`.rhint`) מתחת לשורה, והשם/טלפון מתמלאים בשדות שמתחת |
| Footer | **הנחיה גוברת**: ראשי-בהתחלה נשמר (Chip2 הפך את הסדר בטעות — מסומן שם "unchanged") |
| X על בלוק | Chip2 מציג תמיד; **הוחלט**: מוצג רק לבלוק **בלי** צ׳יפים שמורים (הסרת בלוק לעולם לא "מעלימה" צ׳יפ קיים) |
| Toggle על צ׳יפ שמור בתוך החלון | **הנחיה גוברת (09/2026 — מחליפה את חוק הדיאלוגים):** פעולה מיידית בלחיצה אחת, **אפס דיאלוגים**. כיבוי → `window.confirm("להשבית את צ׳יפ <מספר>?")` בלבד, ואז `POST …/deactivate` עם `reason='unknown'`; הדלקה → `POST …/reactivate` בלי סיבה ובלי שאלה. optimistic: התגית מתחלפת מיד, כשל (כולל 409 "מספר תפוס") מחזיר אותה + `toast.error`. סדר התגית: **[טוגל] [badge סטטוס] [מספר] [badge סוג]**. אין מחיקה — צ׳יפ שהונפק לעולם לא נמחק |
| **תיקון מספר** על תגית שמורה (09/2026) | הנחיה גוברת: המספר בתגית הוא כפתור; לחיצה → שדה inline באותה תגית (`chip-num`, LTR, גבול brand + ring). **Enter/blur שומרים מיד** (כמו הטוגל), Escape מבטל. optimistic: המספר מתחלף מיד; `PATCH /api/chips/:id {chip_number}`; **409** כשצ׳יפ **פעיל** אחר מחזיק את המספר (בדיקה אפליקטיבית — האינדקס החלקי מכסה רק פעילים) → המספר חוזר + toast; מספר שכבר בחלון → toast בלי בקשה. האירוע: `chip_events` `event_type='note'`, `new_value={chip_number:{old,new}}`, `reason='תיקון מספר'` (בלי מיגרציה) |
| **עריכת בעל צ׳יפ על בלוק שמור** (09/2026) | הנחיה גוברת: שם/טלפון ניתנים לעריכה גם כשלבלוק יש צ׳יפים שמורים; **תפקיד** ניתן לשינוי רק לתפקיד שאף בלוק אחר לא מחזיק (`takenRoles`; "אחר" תמיד פנוי). השינוי חל על **כל** צ׳יפי הבלוק בשמירה, ב**אותה טרנזקציה** עם ההנפקה (`POST /api/chips` עם `updates:[{id, holder_name?, holder_phone?, resident_role?}]`, zod, all-or-nothing). ה-diff נמדד מול הערכים שהבלוק נזרע בהם (`orig`) — בלוק שלא נגעו בו לא שולח דבר. הפוטר: "הנפק צ׳יפ" / "שמור שינויים" / "שמור והנפק" לפי מה שיש. עמלה/הערות של שמורים — לא נערכים |

---

## 35. שקיפות כספית — לשוניות, תאריכון, פרסום חודש, קרן שיפוצים

מודול `/finance` נבנה על הקומפוננטות המשותפות (`Section` / `PanelFooter` / `Field`, Sheet לפי §12,
טבלה בגרסת הטוקנים של `DebtorsTable` + כרטיסים במובייל דרך `roomy:`, `KpiCard`). הדפוסים של המודול:

### לשוניות (`components/finance/FinanceTabs.tsx`)

שתי לשוניות בראש העמוד, בדפוס §16 בלי מונים: "שוטף" (ברירת מחדל, בלי פרמטר) ו"קרן שיפוצים"
(`?tab=fund`). כפתור `h-11 rounded-xl px-4 text-sm font-semibold` עם אייקון; פעיל = `bg-blue-600`
(שוטף) / `bg-violet-600` (קרן) + `text-white shadow-soft-sm`; לא פעיל = `border border-line bg-white
text-ink-2 hover:bg-row-hover`. המעבר שומר את `?m=` כדי שחזרה ל"שוטף" תחזיר את התקופה.

### תאריכון בלחיצה אחת (`components/finance/PeriodPicker.tsx`) — מחליף את חצי החודש

טריגר `h-[38px] rounded-[10px] border border-[#e2e8f0] bg-white px-3` עם `CalendarDays`, תווית התקופה
(`text-[17px] font-extrabold`, `min-w-[128px]`) ו-`ChevronDown`. הפאנל: שורת «כל YYYY» — חץ שנה קודמת
מימין (`ChevronRight`), הכותרת עצמה כפתור שבוחר את השנה, חץ שנה הבאה משמאל; מתחתיה גריד
`grid-template-columns: 2.75rem 4.5rem repeat(3, 1fr)` בשורות של `2.75rem`: כל שורה = רבעון עם תווית
לחיצה "רבעון N", כל צמד שורות = תווית אנכית "מחצית א׳/ב׳" (`[writing-mode:vertical-rl] rotate-180`,
`row-span-2`), ושלושה תאי חודש `rounded-lg text-[13px] font-semibold`. מצבים: נבחר `bg-blue-600
text-white`; בתוך תקופה נבחרת `border-blue-200 bg-blue-50 text-blue-700`; החודש הנוכחי `ring-1
ring-inset ring-blue-300`; **חודש עתידי `text-slate-300 cursor-not-allowed` ולא לחיץ** (וכך גם רבעון /
מחצית / שנה שטרם התחילו); **חודש שפורסם = נקודה ירוקה** `h-1.5 w-1.5 bg-emerald-500` בפינת ה-end.
**כל לחיצה בוחרת וסוגרת** — אין מצב טווח ואין לחיצה שנייה. מחשב (`min-width: 768px`): פאנל מעוגן
`absolute start-0 top-full w-[400px] rounded-xl border p-4 shadow-soft-md` עם שכבת סגירה
`fixed inset-0`; מובייל: `Sheet side="bottom"` (`rounded-t-2xl p-4`, safe-area) — אותה קומפוננטה, אותו
גריד, מטרות מגע `min-h-11`. הבחירה נכתבת ל-`?m=` בדקדוק `YYYY-MM · YYYY-Qn · YYYY-Hn · YYYY`
(`lib/finance/period.ts`), ב-`startTransition`; השרת מרנדר מחדש וה-client מקבל `key={tab:period}`.

### טוגל פרסום חודש (`components/finance/PublishToggle.tsx`)

מופיע ליד התאריכון **רק כשנבחר חודש בודד** (לא בדוח תקופה, לא בלשונית הקרן): `Switch` + תגית
`h-[38px] rounded-[10px] border px-3 text-sm font-semibold` — "מוצג לדיירים" (`Eye`,
`border-emerald-200 bg-emerald-50 text-emerald-700`) / "מוסתר מדיירים" (`EyeOff`, `border-slate-200
bg-slate-50 text-slate-600`). נשמר מיד (`PUT /api/finance/month-status`), אופטימי עם rollback. צופה
רואה את התגית בלי ה-Switch. בחודש מפורסם מוצג באנר ירוק קבוע מעל ה-KPI (`border-emerald-200
bg-emerald-50 text-emerald-900`): "חודש זה מוצג לדיירים — שינויים ייראו מיד".

### דוח תקופה (`components/finance/PeriodReportView.tsx`)

לרבעון / מחצית / שנה: 3 `KpiCard` (הכנסות · הוצאות · עודף בתקופה, טון `amber` בגירעון), ואז "הכנסות
לפי סעיף" ו"הוצאות לפי סעיף" — טבלה `table-fixed` עם `<colgroup>` [סעיף | סה"כ 160 | ממוצע חודשי 160]
(אותו רוחב `COL_PX.amount` של טבלאות החודש); לחיצה על שורה פותחת מתחתיה שורת `colSpan={3}` עם
גרף עמודות `recharts` בגובה 220px לפי חודש (עטיפה `dir="ltr"`, ציר X `reversed`, ציר Y מימין — כמו
`CollectionChart`; ירוק `#16a34a` להכנסה, אדום `#e5484d` להוצאה). במובייל — כרטיסים שנפתחים לגרף.
כשיש בטווח חודשים מוסתרים — באנר `amber` בראש: "X מוסתר מדיירים — אצלם הדוח יכלול N מתוך M חודשים".
חודשים עתידיים בטווח לא נספרים (המכנה של הממוצע = חודשי התקופה עד החודש הנוכחי).

### לשונית הקרן (`components/finance/FundTab.tsx`, `FundLedgerTable.tsx`, `FundTargetDialog.tsx`)

בלי בורר חודש — הכול מצטבר. כרטיס KPI אחד `rounded-2xl border border-line bg-white p-5`: "נגבה מתוך
יעד" (`text-[26px] font-bold text-emerald-700` / `text-lg` ליעד) + אייקון עריכה `h-11 w-11` שפותח
**Dialog** לשדה בודד (§12) — `Field` "יעד גבייה (₪)"; שורת "אחוז גבייה" ופס `h-2.5 rounded-full
bg-slate-100` עם מילוי `bg-emerald-500` (`role="progressbar"`, נחתך ב-100%); ושלושה מדדים ב-`dl`
`grid sm:grid-cols-3` (`rounded-xl border bg-surface-2 p-4`): נגבה (emerald) · יצא (rose) · יתרה בקרן
(ink, `amber` כששלילית). כרטיס "יצא לפי מטרה": כל סעיפי ההוצאה של הקרן, גם ב-0 ₪ — שם (+ תגית
"מושבתת") · פס יחסי `bg-rose-400` על `bg-slate-100` · סכום; קישור "ניהול מטרות" →
`/finance/settings#renovation-fund`. "כל תנועות הקרן": `FundLedgerTable` — יומן אחד, מהחדש לישן,
`<colgroup>` [תאריך 112 | מטרה / תיאור | הכנסה 160 | הוצאה 160 | פעולות 112] מאותם קבועים; הכנסה מציגה
`MM/YYYY` (חודש הרישום), הוצאה `DD/MM/YYYY`; תנועה מחודש שלא פורסם מקבלת תגית `bg-amber-50
text-amber-700` "לא פורסם". הכפתורים בלשונית: "הוצאה מהקרן" ו"הפקדה לקרן" — אותו `EntrySheet` עם
`section='renovation_fund'`: שדה הסעיף נקרא "מטרה" בהוצאה ומציע רק מטרות פעילות של הקרן.

### תצוגת דייר (`components/finance/ResidentViewToggle.tsx`, `ResidentViewClient.tsx`, `ResidentMonthView.tsx`)

מתג `Switch` בתוך תווית `h-11 rounded-xl border px-3 text-sm font-semibold` עם `Eye` — "תצוגת דייר" —
ליד הלשוניות; פעיל = `border-indigo-200 bg-indigo-50 text-indigo-800`. כותב `?view=resident` (שומר
`tab` ו-`m`). במצב הזה: באנר קבוע `role="status"` `border-indigo-200 bg-indigo-50 text-indigo-900`
"אתה צופה כמו דייר — מוצגים רק חודשים שפורסמו, בלי פרטים פנימיים" עם `Button variant="outline"`
"יציאה מתצוגת דייר" (`LogOut`); אין כפתורי הוספה, אין טוגל פרסום ובאנרי פרסום, אין עריכת יעד /
"ניהול מטרות", אין עמודות ספק / מס׳ חשבונית / קבצים / פעולות, אין תגיות "לא פורסם" ואין "מושבתת".
התאריכון ב-`residentMode`: חודש שלא פורסם `text-slate-300 cursor-not-allowed` כמו חודש עתידי, רבעון /
מחצית / שנה לחיצים רק אם יש בהם חודש מפורסם; המקרא: "חודש שפורסם — רק אלה זמינים". חודש בודד =
`ResidentMonthView`: 3 `KpiCard` + טבלאות לפי סעיף `[תאריך 112 | תיאור | סכום 160]` (הוצאה) /
`[תיאור | סכום 160]` (הכנסה) מאותם קבועים; דוח תקופה = שורת מידע `border-line bg-surface-2`
"כולל N מתוך M חודשים" (`Info`) במקום באנר האזהרה; אף חודש לא פורסם = `rounded-lg border bg-card p-12`
"עוד לא פורסמו חודשים".

### סעיפים ומטרות (`/finance/settings`, `CategorySheet.tsx`)

אין יותר שדה "חלק בתקציב": ה-`section` נקבע לפי הכרטיס שממנו נוצר הסעיף — "סעיפים — תקציב שוטף"
(`Tags`, כחול) או "מטרות — קרן שיפוצים" (`PiggyBank`, סגול, `id="renovation-fund"` + `scroll-mt-24`
לקישור מהלשונית). בכרטיס הקרן: "מטרות (הוצאות מהקרן)" ו"סעיפי הפקדה (הכנסות לקרן)". סעיף/מטרה עם
תנועות לא נמחקים — רק מושבתים (`Switch` inline, 409 במחיקה).

### אייקון סטטוס Google Drive (`components/finance/DriveStatusIcon.tsx`)

אייקון `h-4 w-4` יחיד ליד כל קובץ, עם Tooltip: `CloudUpload text-amber-500` = ממתין לגיבוי ·
`Cloud text-emerald-600` = גובה · `CloudOff text-red-500` = נכשל (הסיבה ב-Tooltip, וציון "מוצו
הניסיונות" אחרי 5). בשורת טבלה מוצג האייקון של המצב הגרוע ביותר בין הקבצים, בתוך צ׳יפ
`Paperclip N` (`h-9`, `h-11` במובייל) שפותח `Popover` עם רשימת הקבצים (קישור ל-proxy + גודל + סטטוס).

### יישור העמודות בין הטבלאות (`components/finance/table-shared.tsx` → `EntryGroupTable.tsx`, `FundLedgerTable.tsx`)

טבלאות ההכנסות וההוצאות הן אותה קומפוננטה, אך עם מבנה עמודות שונה (הכנסות: תיאור · סכום · קבצים · פעולות;
הוצאות: תאריך · ספק · מס׳ חשבונית · תיאור · סכום · קבצים · פעולות). כדי ש"סכום", "קבצים" ו"פעולות" ישבו
על אותו קו אנכי: `<Table className="table-fixed min-w-[960px]">` + `<colgroup>` עם רוחבים קבועים (px)
מקונסטנטה אחת, `COL_PX` ב-`table-shared.tsx` (יחד עם `TABLE_CLASS`, `HEAD_CLASS`, `fmtDate` ו-`RowActions`
— כל טבלה של המודול, כולל יומן הקרן ודוח התקופה, מייבאת משם) — **סכום 160 · קבצים 128 · פעולות 112**,
ובהוצאות גם **תאריך 112 · מס׳ חשבונית 144**. שאר העמודות (תיאור; ספק + תיאור) מתחלקות ברוחב הנותר, עם `truncate` + `title`.
שורות הקבוצה והסה״כ: `colSpan` מכסה **רק** את העמודות שמימין ל"סכום", תא הסכום נפרד, ותא ריק
`colSpan={2}` לקבצים/פעולות — כך הסכום נופל בדיוק בעמודה שלו. יישור זהה בשתיהן: סכום `text-center`,
קבצים `text-center`, פעולות `text-end`. מתחת ל-960px עטיפת ה-`Table` (`overflow-x-auto`) גוללת
אופקית — אותה גלילה בשתי הטבלאות — במקום למחוץ את עמודות הטקסט; מתחת ל-`roomy` מוצגים כרטיסים.

### שדה ספק עם טקסט חופשי (`components/finance/SupplierSearchField.tsx`)

וריאציה של שדה החיפוש הניתן-לניקוי (§6): `Search` ב-start, `X` ב-end כשיש ערך, רשימת תוצאות
`absolute` מתחת לשדה (`rounded-md border-slate-200 bg-white shadow-lg max-h-64`). בחירה = ספק
מהטבלה (שורת אישור ירוקה "ספק מרשימת הספקים"); הקלדה חופשית = שם חופשי (שורת הסבר אפורה).
**לא יוצר ספק** לעולם.


---

## 36. תור ההצעות מבלינק (`/contacts` + כרטיס הדירה)

הסנכרון מבלינק לא דורס שדה של דייר שהוא חולק עליו — הוא מציע, ורונן מכריע
(29/09/2026). שני משטחים, שניהם מהפלטה הקיימת, בלי צבע חדש.

### כפתור התור (ראש `/contacts`)

```tsx
<Button variant="outline" className="gap-2 border-amber-200 bg-amber-50 text-amber-700
                                     hover:bg-amber-100 hover:text-amber-800">
  <RefreshCcwDot className="h-4 w-4" /> {n} הצעות מבלינק
</Button>
```

יושב ראשון בשורת הפעולות (לפני "ייבוא Excel"), **ומצויר רק כש-`n > 0`** — תור ריק
אינו חדשות. הספירה מגיעה מה-server component בטעינה הראשונה; הרשימה עצמה נטענת
רק בלחיצה. ענבר ולא אדום: זו החלטה שממתינה, לא תקלה.

### פאנל התור (`contact-suggestions-panel.tsx`)

`Sheet` תקני לפי §12 (‏`side="left"`, סולם הרוחב, כותרת gradient, גוף
`bg-slate-50/60 p-5`, `PanelFooter`). שורה לכל דירה+שדה, בקלף לפי §9b:

- כותרת השורה: `דירה {n}` + צ׳יפ שדה (`bg-slate-100 text-slate-600`) + זמן יחסי.
- הערכים בשורה אחת: **שלנו** `text-muted-foreground line-through`, ‏`ArrowLeft`
  אפור, **המוצע** `font-semibold text-slate-900`. טלפונים `dir="ltr" tabular-nums`.
  ערך ריק = "— ריק".
- שתי פעולות בקצה: "אשר" `border-emerald-200 text-emerald-700` · "דחה"
  `border-rose-200 text-rose-600` (אותו ניסוח של כפתור המחיקה ב-`PanelFooter`).
  במובייל הן נערמות מתחת לערכים (`flex-col` → `sm:flex-row`).
- ב-footer "אשר הכל" דרך `PanelFooter`, עם `AlertDialog` לאישור (§12 — פעולה
  רוחבית על נתונים קיימים). **מ-03/10/2026 הוא חל רק על הקבוצה השנייה** (ראו למטה).
- תור ריק = מצב ריק לפי §17 עם `Inbox`; טעינה = שלושה `h-20 animate-pulse`.

**שתי קבוצות (03/10/2026).** הגוף מחולק לשתי `section`, כל אחת עם כותרת
`text-sm font-bold text-slate-900` + אייקון 16px ושורת הסבר `text-xs text-muted-foreground`:
1. **"משפיעות על הגישה לפורטל"** (`KeyRound`, `text-amber-600`) — טלפון, "שיוך לפורטל",
   "ניתוק מהפורטל" ושם בעלים חדש. אישור אחד-אחד בלבד.
2. **"שאר ההצעות"** (`ListChecks`, `text-slate-500`) — שמות ומיילים; רק עליהן "אשר הכל".

שורת "שיוך"/"ניתוק" מציגה אדם במקום שני ערכים: שם `font-semibold` · טלפון `dir="ltr"` ·
צ׳יפ תפקיד `rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700`; כפתור
האישור נקרא "שייך" / "נתק". שם בעלים חדש מקבל **שני כפתורים במקום "אשר", ללא ברירת מחדל**
(`OwnerNameDecision`): "תיקון שם" (`PenLine`, ירוק כמו "אשר") ו"החלפת בעלים" (`UserRoundCog`,
`border-amber-200 text-amber-700`), שפותח `AlertDialog` עם רשימת הטלפונים שינותקו והטלפון
החדש שיאושר; כפתור האישור בו הרסני (`bg-destructive`). הערות מצב בשורה — `text-xs
text-amber-700`: "ממתין להחלטה על שם הבעלים" (טלפון בעלים שמחכה — כפתור האישור מושבת),
"אישור יסמן בכרטיס הדירה סוג דייר "שוכר"". בתג שבכרטיס הדירה — אותם שני כפתורים בגודל `xs`.
שורת "ניתוק" אומרת למה נוצרה, `text-xs text-slate-600` (מידע, לא אזהרה): "למה: הטלפון לא נמצא
ב-Bllink בדירה הזו" / "למה: הטלפון רשום ב-Bllink כלא פעיל" (`UNLINK_REASON_LABEL`). ההתאמה מול
Bllink לפי טלפון קודם — "ניתוק" לעולם לא נוצר בגלל שם שונה (03/10/2026). בעלים נוסף שהטלפון
שלו פשוט לא מופיע ב-Bllink **לא מקבל שורת "ניתוק"** — הסרה שלו רק ידנית מכרטיס הדירה; רק
"לא פעיל" ב-Bllink מוריד אותו לתור.

### תג ההצעה בכרטיס הדירה (`MainDetailsCard`)

מתחת לשדה שיש לו הצעה פתוחה, ברוחב מלא:

```tsx
<div className="mt-1 flex flex-wrap items-center justify-end gap-1.5
                rounded-md border border-amber-200 bg-amber-50 px-2 py-1">
  <span className="text-[11px] font-semibold text-amber-700">בלינק:</span>
  <span className="text-xs font-semibold text-amber-900">{proposed}</span>
  {/* Check ירוק · X ורוד — כפתורי אייקון p-1 עם Tooltip */}
</div>
```

אותו ענבר של הכפתור, כך שהתג והכפתור נקראים כאותו דבר. האייקונים הם כפתורי
`Tooltip` בלבד — הטקסט המלא ("אשר — הערך ייכתב כאן" / "דחה — שלכם נשאר, וההצעה
לא תחזור") יושב ב-Tooltip ולא על הכרטיס.

### סימון מקור השדה ("ידני · תאריך")

שורת כיתוב אחת מתחת לערך, `text-[11px] text-slate-400`, בלי אייקון ובלי רקע:
`ידני · 29.09` או `בלינק · 29.09`, והמשפט המלא ב-Tooltip. **רק שדה שמישהו באמת
שינה** מקבל אותה — שדה שאיש לא נגע בו פשוט אין לו שורה, וכך הכרטיס לא מתמלא
בסימונים.

### שורות שמופיעות רק כשיש מה לומר (29/09/2026)

התור גדל משלושה שדות לשישה (`owner_name`, `owner_phone`, `owner_email`,
`tenant_name`, `tenant_phone`, `tenant_email`), אבל **הכרטיס לא גדל איתו**:
"שם שוכר", "מייל בעלים" ו"מייל שוכר" מצוירות רק כשיש **ערך, הצעה פתוחה או
חותמת מקור**. לרוב הדירות אין שוכר, ולכן שורה ריקה קבועה הייתה עלות בלי תועלת.
ארבע השורות הוותיקות (מספר דירה, בעל הדירה, שני הטלפונים) נשארות תמיד.

כתובת מייל היא `<a href="mailto:…">` עם `dir="ltr"` וקו תחתון ב-hover — קריאה
בלבד; עריכה נעשית ברשימת הדיירים. כיוון הערך בתג ובפאנל נקבע מטבלה אחת
משותפת (`SUGGESTION_FIELD_IS_NUMERIC`): טלפונים וכתובות LTR, שמות בכיוון הדף.

---

## 37. תקלות מפורטל הדיירים במודול התקלות (03/10/2026, כרטיס דייר וקנבן לפי שלב טיפול — שלב ג׳)

תקלה שבעל דירה פתח ב-`/portal/report` היא שורה רגילה של `issues` (`source='portal'`) — אותה טבלה,
אותו קנבן, אותו פאנל עריכה (`IssueFormPanel`, Sheet לפי §12). הכותרת שלה: **"דיווח דייר · <מיקום>"**.
הרכיבים ב-`components/issues/IssueReporter.tsx`:

- **סימון "דיווח דייר"** (`ResidentReportStrip` + `RESIDENT_REPORT_ACCENT`) — מחליף את התגית הקטנה בצוות.
  טון **violet** של §2 (אותה משפחה של המסנן "מדיירים"), אייקון `Megaphone`, הטקסט
  "דיווח דייר · <שם> · דירה <מספר> · <תפקיד>" (התפקיד — בעלים / שוכר / מפעיל — מ-03/10/2026; מדווח לא
  מזוהה: "דיווח דייר · לא מזוהה"). **אין צבע חדש** — רק
  `violet-50/200/500/700` מהפלטה של Tailwind ש-§2 מתעד.
  - **כרטיס קנבן** (`variant="card"`): פס ברוחב הכרטיס מעל הכותרת — `border-b border-violet-200 bg-violet-50
    px-3.5 py-1.5 text-[12px] font-semibold text-violet-700`, אייקון `h-3.5`; והכרטיס כולו
    `border-s-[3px] border-s-violet-500` (גם ב-hover).
  - **שורת טבלה** (`variant="row"`): מתחת לכותרת — `rounded-md bg-violet-50 px-2 py-0.5 text-[12px] font-semibold
    text-violet-700`; ה-accent על התא הראשון (`border-s` של השורה ב-RTL). בכרטיס המובייל — על ה-`li`.
  - **ראש חלון התקלה** (`variant="panel"`): באנר ראשון בגוף הפאנל — `rounded-xl border border-violet-200 bg-violet-50
    px-4 py-3 text-sm font-bold text-violet-700` + accent.
- **בלוק "נפתח ע״י"** (`IssueReporterSection`) — `Section` §8 עם `Megaphone`, `iconTone="violet"` (בלי תגית
  ב-`headerSlot` — הבאנר מעליו נושא את הסימון); מיד אחרי הבאנר, לפני "פרטי התקלה", קריאה בלבד. `dl` בשורות
  label/value (כמו `MainDetailsCard`): `dt text-base font-medium text-muted-foreground`, `dd font-semibold text-slate-900`.
  שורות: שם · דירה · טלפון · מיקום · קומה / אזור · מספר קריאה. **הטלפון:** `<a href="tel:+972…">` בתצוגה ישראלית
  (`050-111-1112`, `font-num`, `text-brand`, `min-h-11`) + כפתור העתקה 44px עם Tooltip — **רק** ל-`contacts:view`
  (`canSeeReporterPhone`); בלי ההרשאה השורה לא קיימת והערך לא נשלח ב-API. מדווח לא מזוהה + `contacts:view`:
  שורת השם "לא מזוהה — טלפון 052-…".
- **הקנבן — ארבע עמודות לפי שלב טיפול** (`lib/issues/board.ts`, מימין לשמאל): ממתין לשיוך (`amber-500`) ·
  לטיפול היום (`rose-500`) · בטיפול (`blue-500`) · בוצע (`emerald-500`) — אותה מסגרת עמודה ואותו כרטיס כמו קודם.
  **לוח ידני (מ-04/10/2026):** כרטיס חדש נכנס לראש העמודה שהכלל נותן לו (שיוך + `due_date`, "היום" לפי
  Asia/Jerusalem), ומשם רק גרירה מזיזה אותו (`issues.board_column`); הסדר בעמודה = `sort_order`. בכרטיס: תגית הדחיפות כמו קודם;
  **"באיחור X ימים"** (`rounded-md bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700`) לתאריך שעבר;
  **צ'יפ תאריך** (`rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700` + `CalendarDays h-3`,
  "05/10 · 10:00") לכל כרטיס עם תאריך שאינו באיחור ("באיחור" — בעמודת "לטיפול היום" בלבד, כמו קודם).
  **גרירה:** לכל עמודה ולכל מיקום, כולל בתוך העמודה; הכרטיס נוחת בדיוק במקום השחרור ולא משתנה בו שום שדה
  אחר. "בוצע" — סוגר את התקלה כמו קודם. בזמן גרירה: העמודה `border-blue-300 bg-blue-50/60` (כמו קודם), הכרטיס
  שמעליו ינחת `ring-2 ring-blue-300` (אותו סימון של לוח המשימות), ונחיתה בתחתית — פס `h-1 rounded-full bg-blue-300`
  מתחת לכרטיס האחרון; שחרור במקום הנוכחי — בלי סימון. גרירה לא פותחת את חלון התקלה; לחיצה פותחת.
  **לוח ידני לגמרי** (אושר ע״י רונן 04/10/2026): כרטיס לא משנה עמודה לבד — לא בחצות, לא בשיוך מטפל, לא בשינוי תאריך.
- **שורת יוצר בתחתית הכרטיס (06/10/2026, הורחבה 07/10)** — רכיב אחד, `components/shared/CreatedByLine.tsx`,
  בשלושה כרטיסים: קנבן התקלות (האלמנט האחרון, אחרי המטפלים), **קנבן המשימות** (השורה האחרונה — מתחת למטפלים
  ולרצועת המחזוריות) ו**מסך העובד** ב-`/issues` (מתחת לכפתור הפעולה, `mt-4` כמו שכניו בכרטיס). `border-t
  border-slate-200 pt-2 text-xs text-muted-foreground` (+ `self-stretch` בקנבנים), הטקסט "נוצר ע״י <שם> · 04/10/2026
  22:13" — התאריך והשעה בשעון ישראל (`formatStamp(created_at, '/')`), עטופים `dir="ltr" font-num tabular-nums
  whitespace-nowrap` (07/10: בכרטיס צר התאריך והשעה לא נשברים לשתי שורות — החותמת יורדת שורה כיחידה אחת). השם =
  `created_by_name` של השורה (`issues` / `tasks`; snapshot מרגע היצירה; בדיווח דייר — שם המדווח). שורה בלי יוצר —
  תאריך ושעה בלבד. תצוגות הטבלה — בלי השורה.
- **מגע (04/10/2026)** — אותו לוח, אותו סימון נחיתה, אותו endpoint; רק בעלי `issues:edit` (בלי ההרשאה — אין גרירה ואין
  "העבר אל…"):
  - **לחיצה ארוכה** (~500ms, סבילות ~10px) מרימה את הכרטיס: `relative z-30 scale-[1.02]` + ה-shadow של hover הקיים
    (`shadow-[0_10px_22px_-8px_rgba(15,23,42,0.18)]`), `transition-none`, והכרטיס עוקב אחרי האצבע; רטט קצר (`vibrate`)
    איפה שנתמך. תנועה לפני ה-500ms = גלילה רגילה; לחיצה קצרה = פתיחת החלון. ליד קצה אזור הגלילה הלוח נגלל לבד.
    הכרטיסים `select-none [-webkit-touch-callout:none]` (בלי בחירת טקסט ו-callout בלחיצה ארוכה).
  - **מ-768px (טאבלט ומעלה):** הגרירה עוברת בין עמודות ובתוכן, כמו בעכבר.
  - **מתחת ל-768px (טלפון):** הגרירה מסדרת רק בתוך העמודה של הכרטיס (הכרטיס זז אנכית בלבד). לעמודה אחרת — כפתור
    **"העבר אל…"** בכל כרטיס (`IssueMoveToMenu`, `md:hidden`): אייקון `ArrowLeftRight h-4 w-4`, אזור לחיצה `h-11 w-11`
    (`-my-2` כדי לא להגביה את שורת הכותרת), `rounded-lg text-slate-500 hover:bg-slate-100`, ליד תגית הדחיפות. פותח
    `Popover` (`PopoverContent w-56 p-2`, כמו רשימת הקבצים של §שקיפות): כותרת "העבר אל…" `px-3 pt-1 pb-1 text-xs
    font-semibold text-slate-400`, ושורה לכל אחת משלוש העמודות האחרות — `min-h-11 rounded-lg px-3 py-2 text-sm
    font-medium text-slate-700 hover:bg-slate-50` עם נקודת הצבע של העמודה (`h-2.5 w-2.5 rounded-full`). בחירה →
    הכרטיס בראש העמודה; "בוצע" → סגירה כמו גרירה ל"בוצע". הכפתור והתפריט לא פותחים את חלון התקלה.
- **מסננים** בסרגל `/issues` — כפתורי toggle בגובה ה-Selects (`h-10 rounded-lg border px-3 text-sm
  font-medium`, `aria-pressed`): "מדיירים" (`Megaphone`, פעיל `border-violet-200 bg-violet-50 text-violet-700`) — בשתי
  התצוגות; "ממתין לשיוך" (`UserX`, פעיל `border-amber-200 bg-amber-50 text-amber-700`) ו"לטיפול היום"
  (`CalendarClock`, פעיל `border-rose-200 bg-rose-50 text-rose-700`) — **בטבלה בלבד** (בקנבן הן עמודות);
  כבוי `border-slate-200 bg-white text-slate-600`.
- **מסך העובד** (`worker-issue-detail` / `worker-issues-view`) — לא השתנה: המיקום כפי שהדייר כתב בשורת `MapPin`,
  והתגית הקטנה "פורטל דיירים" (`PortalSourceTag`, soft pill §10 `bg-violet-100 text-violet-600`) + שם + דירה
  (`IssueSourceLine`). בלי טלפון.

---

## 38. פורטל לפי תפקיד, זהות מאושרת ואזהרת הזנה (03/10/2026)

כל הרכיבים מהפלטה הקיימת — **אין צבע ואין טוקן חדשים**.

- **פורטל — כותרת:** השם מגיע מהזהות האחידה בלבד. אין שם (טלפון חסום, או רשומה בלי שם) →
  **"שלום"**, ובאווטאר `AccountIcon` במקום ראשי תיבות. השורה השנייה: "דירה 1210 · בעלים" /
  "דירות 520, 1001 · בעלים · שוכר" (`rolesLabel`); לטלפון חסום — אין שורה שנייה.
- **"החשבון שלי" — תגית תפקיד:** `.tag.t-gray` הקיימת (`data-role`), ליד "דירה N" בכותרת כל בלוק
  (`.acc-block > h2` — `flex items-center gap 10px`), ובדירה יחידה — בסוף שורת המשנה (`.acc-sub`, flex
  עם gap 8px).
- **"טלפונים חסומים" (`/admin/portal-blocked`):** כרטיס לכל טלפון (§9b), ובראשו צ׳יפ סיווג
  `rounded-full px-2.5 py-0.5 text-xs font-medium` בטונים של §2: שמות ללא קשר `bg-rose-50 text-rose-700`
  (ממוין ראשון) · חסר שם `bg-amber-50 text-amber-700` · משפחה `bg-violet-50 text-violet-700` · חברה + איש
  קשר `bg-blue-50 text-blue-700` · כתיב שונה `bg-emerald-50 text-emerald-700`. בקשה ממתינה — צ׳יפ
  `bg-slate-100 text-slate-600`. פעולות (`h-11 px-4`): "אדם אחד" (ראשי, `UserCheck`; מושבת עם `title` כשיש
  רשומה בלי שם), "דחה בקשה" (outline), ובכל שיוך "נתק" (`DetachLinkButton`) ו"השלם שם" (קישור
  `buttonVariants({variant:'outline'})` ל-`/contacts?apt=N`). מתחת — "זהויות מאושרות" (`BadgeCheck`
  `text-emerald-600`) עם "בטל אישור" ו-`AlertDialog` הרסני.
- **"אדם אחד" — `IdentityApprovalPanel`:** Sheet תקני (§12 — יצירת רשומה). Section "שם תצוגה" (`Input h-10`,
  **ריק בפתיחה**; השמות שברשומות כצ׳יפים לבחירה `min-h-11 rounded-lg border px-4 py-2`) ו-Section "הקשר לכל
  דירה" — שורה לכל דירה עם `Select` (`h-10`, placeholder "בחר קשר…", ללא ברירת מחדל): אישי / מורשה של
  חברה / קרוב משפחה. "אשר — אדם אחד" מושבת עד שהכול נבחר.
- **אזהרת הזנה — `PhoneEntryDialog`:** `AlertDialog` (§12 — אישור), כותרת "הטלפון הזה רשום אצל <שם>
  בדירה <מספר>. אותו אדם?", ושלוש פעולות בלי ברירת מחדל: "ביטול" (`AlertDialogCancel`) · "לא, אדם אחר"
  (outline) · "כן, אותו אדם" (ראשי). לבעל `portal_manage` "כן" פותח את `IdentityApprovalPanel` מעל כרטיס
  הדירה. **אותו דיאלוג בכל מקום שכותב טלפון דייר** (`usePhoneEntryWarning`): כרטיס הדירה, עריכת טלפון
  בפאנל החייב (`EditPhoneDialog` נשאר פתוח מתחת לשאלה עם המספר שהוקלד — "ביטול" חוזר אליו) ואישור הצעות
  בלינק (מהתור ומהתג בכרטיס). ייבוא קובץ לא יכול לשאול — השורה לא נשמרת ודוח הייבוא מפנה לכרטיס הדירה.
- **כרטיס הדירה, "טלפון ← דירות בפורטל":** צ׳יפ תפקיד `rounded-full bg-blue-50 px-2 py-0.5 text-[11px]
  font-medium text-blue-700` ליד השם; המקור לפי תפקיד ("רשומת השוכר", "איש קשר — מפעיל").


---

## 39. ניטור שגיאות — Sentry (07/10/2026)

אין כאן רכיב UI חדש. הסעיף קיים כי מסך השגיאה הכללי (`src/app/global-error.tsx`, "משהו השתבש")
ושגיאות השרת נשענים על Sentry, ומי שנוגע בהם צריך לדעת מה פעיל ואיך מפעילים. פירוט מלא, כולל אימות:
`docs/monitoring.md`.

- **שרת ו-edge — מופעלים בזמן ריצה.** `SENTRY_DSN` נקרא מ-`/etc/billing/billing.env` בכל עלייה של
  השירות (`sentryRuntimeOptions(process.env)`, `src/lib/sentry-options.ts`). **`sudo systemctl restart
  billing.service` מספיק כדי להפעיל או לכבות** — בלי build ובלי deploy. ב-journal מופיעה שורה אחת בכל
  עלייה: `Sentry initialized` או `Sentry disabled (no DSN)`. ה-DSN עצמו לא נרשם.
- **דפדפן — נקבע בזמן build, וכבוי בפרודקשן.** לדפדפן אין `process.env`, ולכן `instrumentation-client.ts`
  קורא את `SENTRY_CLIENT_DSN` שה-`env` של `next.config.ts` מטמיע מסביבת ה-build. ה-DSN נמצא רק ב-
  `billing.env`, ולכן ה-build לא רואה אותו. המשמעות ל-UI: הטקסט "השגיאה דווחה" במסך השגיאה הכללי לא
  מגובה היום בדיווח מהדפדפן. הפעלת Sentry בדפדפן היא החלטה נפרדת.
- **כלל לקוד חדש:** לא להוסיף ל-`env` שב-`next.config.ts` משתנה שהשרת קורא. `env` מטמיע את הערך גם
  בקוד השרת, ו-build בלי הערך מוחק את הקוד שתלוי בו (כך נעלם בלוק ה-init עד 07/10/2026). השומרים:
  `tests/sentry-runtime.test.ts` ו-`npm run check:sentry-build` (ב-CI, אחרי ה-build).

---

## 40. עדכוני תלויות — Renovate (07/10/2026)

אין כאן רכיב UI. הסעיף קיים כי עדכון של ספריית UI יכול לשנות את המראה גם כשאף שורה בקוד שלנו לא השתנתה,
וה-CI לא תופס שינוי ויזואלי.

- **מ-07/10/2026 עדכוני התלויות מגיעים כ-PRs של Renovate** (`renovate.json`): פעם בשבוע, ראשון לפנות בוקר
  (שעון ישראל). PR מקובץ אחד לכל ה-minor/patch, PR נפרד לכל major, רענון lockfile שבועי, תווית `dependencies`.
  עדכוני אבטחה נפתחים מיד. **אין automerge** — כל PR ממוזג ידנית.
- **לפני מיזוג PR שנוגע בספריית UI** (`shadcn`, `tailwindcss`, `tw-animate-css`, `tailwind-merge`,
  `@base-ui/react`, `lucide-react`, `recharts`, `sonner`) — בדיקה ויזואלית מול המסמך הזה. `globals.css`
  מייבא את `shadcn/tailwind.css`, ושדרוג minor של `shadcn` (4.4.0 → 4.21.1) כבר הוסיף פעם כללי CSS
  גלובליים ונדחה (04/10/2026).

### מצב תחזוקה שוטפת — הבדיקה הוויזואלית בקבוצת ה-non-major (07/10/2026)

מ-07/10/2026 billing במצב תחזוקה שוטפת: אין פיצ'ר פתוח, ושינויים בקוד מגיעים בעיקר מ-PRs של Renovate (סעיף 40
למעלה). ה-PR המקובץ של ה-minor/patch נפתח בראשון לפנות בוקר, ובראשון 11/10/2026 הוא צפוי לכלול את
`shadcn` 4.4.0 → 4.21.x. **לפני מיזוג PR כזה:**

1. **diff של ה-CSS ש-`globals.css` מייבא** (`shadcn/tailwind.css` = `dist/tailwind.css` בחבילה), בתיקיית עבודה
   מחוץ לריפו: `npm pack shadcn@<ישן> shadcn@<חדש>` ואז `diff` בין שני ה-`package/dist/tailwind.css`. מסווגים כל
   בלוק עליון: `@utility` / `@custom-variant` / `@theme inline` נכנסים ל-CSS רק כשמחלקה משתמשת בהם; `@property`
   וכלל לא משוכב (`.x {…}` מחוץ ל-`@utility`) — גלובליים.
2. **חיפוש בקוד של כל שם מחלקה חדש** (`grep -rn` ב-`src`). שם שכבר בשימוש אצלנו = התנגשות.
   **המדידה של 07/10/2026 (4.4.0 → 4.21.4):** +542 שורות — 24 `@utility` (`no-scrollbar`, `scroll-fade-*`,
   `shimmer-*`), 8 `@property` (`--scroll-fade-*`), שני בלוקי `@theme inline` נוספים וכלל לא משוכב אחד
   (`@media (prefers-reduced-motion) { .shimmer {…} }`). **אף אחד מהשמות לא בשימוש ב-`src`.** הצפי: אין שינוי
   נראה — אבל זה צפי, לא בדיקה.
3. **צילומי לפני/אחרי** של build של ענף ה-PR ב-sandbox (לא בתיקיית הפרודקשן) מול הפרודקשן: `/login`,
   `/dashboard` (KPI + טבלה), פאנל צד (`Sheet`) עם `Field`/`Select`, `/portal`, `/finance?view=resident`.
   הצילומים רק ב-`/var/billing-proof/renovate-<תאריך>/` (כלל ברזל 13).
4. **הבדל נראה כלשהו — לא ממזגים.** מדווחים לרונן עם הצילומים; ההחלטה שלו.
