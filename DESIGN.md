# DESIGN.md — מערכת עיצוב מאסטר (ALMOG CRM)

> **מסמך זה הוא מקור האמת לכל אלמנט UI חדש בפרויקט.**
> כל קומפוננטה ויזואלית חדשה (כפתור, dialog, alert, toast,
> form, card, table, sidebar, וכו') חייבת להתאים לדפוסים
> כאן. בעת אי-ודאות — חזור למסמך, לא להמציא וריאציה חדשה.

**Stack**: Next.js 16 + Tailwind 4 + shadcn/ui + lucide-react.
**שפה**: עברית מלאה, RTL.
**פונט**: Heebo (Google Fonts).

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

אינדיקטור טריות-נתונים לדשבורד. מציג **שני טיימסטמפים מובחנים**: **ייבוא אחרון**
(מ-`debtors.last_imported_at` — מניע את חומרת ה-severity) ו**סנכרון אחרון**
(מ-`sync_runs` — מידע משני). סנכרון וייבוא הן פעולות נפרדות במכוון.

### Container — כרטיס לבן, צל רך, צבע לפי severity
```tsx
<div className={cn('flex flex-col gap-3 rounded-2xl border px-5 py-3.5 shadow-soft-xs md:flex-row md:items-center md:justify-between', styles.wrap)}>
```

| Severity | תנאי (ייבוא) | bg | border |
|---|---|---|---|
| `ok`     | < 24h           | `bg-white`        | `border-line` |
| `yellow` | 24–48h          | `bg-[#fff6e6]`    | `border-[#e08700]/30` |
| `red`    | > 48h / null    | `bg-[#feefef]`    | `border-[#e5484d]/30` |

### צד ימין (start ב-RTL) — chip + שני טיימסטמפים
- chip לוח-שנה: `grid h-10 w-10 place-items-center rounded-xl {iconBg} {iconFg}` (`CalendarSync`).
- שורה ראשית (`font-semibold`): `ייבוא אחרון: <תאריך ב-font-num>` או `טרם בוצע ייבוא`.
- שורה משנית (`text-sm text-ink-2`): אייקון `RefreshCw` זעיר + `סנכרון אחרון: <תאריך ב-font-num>` / `טרם בוצע סנכרון` (`text-ink-3`).
- הערת severity (`text-xs opacity-80`) רק כש-severity != `ok`.

### Button — "סנכרן עכשיו" (ירוק gradient, צל ירוק רך)
```tsx
<Button className="h-9 gap-2 rounded-lg bg-gradient-to-l from-[#16a34a] to-[#0c7a37] px-4 text-sm font-bold text-white shadow-[0_4px_14px_rgba(22,163,74,0.3)] hover:brightness-105">
  <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
  <span>{syncing ? 'מסנכרן…' : 'סנכרן עכשיו'}</span>
</Button>
```
קורא ל-`POST /api/sync/bllink` (same-origin, admin-only); נרשם ב-`sync_runs`; אחרי הצלחה — מרענן את שני הטיימסטמפים מ-`GET /api/sync/status` + `router.refresh()`, `toast` הצלחה; בכישלון — `toast.error` (דפוס שגיאות §7).

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
- **Excel** = SheetJS (`xlsx`, dependency קיים); כספים כ-numbers אמיתיים (לסיכום באקסל), טלפון כ-string; שם גיליון "חייבים"; קובץ `debtors_YYYY-MM-DD.xlsx`.
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

### `validatePhone(input)` returns:
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
- `<SheetContent side="left" dir="rtl" showCloseButton={false} className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white">`
- Header gradient: `bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white`
- Custom X: `h-11 w-11 rounded-lg border border-white/25 bg-white/5 hover:bg-white/15`
- Body scroll: `flex-1 overflow-y-auto bg-slate-50/60 p-5`
- Footer sticky: `flex-none border-t border-slate-200 bg-white px-5 py-3`

### Sheet animation params (in `src/components/ui/sheet.tsx`):
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
- **רשימה אחידה** (ללא כותרות-סקשן): כל פריטי הניווט ברשימה שטוחה אחת — עבודה יומיומית + תקשורת קודם, אחריהם הגדרות-המערכת (סטטוסים, תבניות, אזורים, משתמשים). תמיכת הסקשנים נשמרה בקוד (`title` ריק → לא מרונדרת כותרת/קו): כדי לפצל שוב, מוסיפים entry ל-`SECTIONS` עם `title`. כל פריט עם ה-route + module שלו → RBAC 1:1 (פריט לא-מורשה פשוט מוסתר).
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
- **Heebo** דרך `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700;800&display=swap">`
  ב-`<head>`. Arial = fallback (Gmail/Outlook web יחסמו את ה-link
  לעיתים — תפול חזרה ל-Arial וזה בסדר).
- **Layout**: outer `<table width="100%">` + inner `<table width="600">`
  ממורכז. **לא** `<div>` — Outlook (במיוחד desktop) לא מבין flex/grid.
  ה-Tables משתמשות ב-`role="presentation"` כדי לא לבלבל screen readers.
- **CTA button**: `<a>` עם `display:inline-block` + `background:#2563eb`
  + `color:#ffffff` + `padding:12px 32px` + `border-radius:8px` +
  `font-weight:700` + `text-decoration:none`. אין `<button>` — לא נתמך
  בקליינטים רבים.
- **לוגו = טקסט בלבד** ("אלמוג", `font-size:28px; font-weight:800;
  color:#0f172a`). אין `<img>` — Gmail חוסם תמונות מ-senders לא
  מאומתים, פחות נקודות כשל ופחות סיכון להיכנס לספאם.
- **escape ל-HTML** של כל מחרוזת user-supplied (`userName` וכד') לפני
  הזרקה לתבנית — ראה `escapeHtml()` ב-`reset-password.ts`.

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
- ה-Sidebar מסונן רק לפי view (מודולים ללא view מוסתרים).

### Checkbox vs Switch in the matrix
המטריצה משתמשת ב-**תיבות סימון (Checkbox)** ולא ב-Switch. Checkbox
מתאים לבחירה של הרשאה (selection — האם להעניק את ההרשאה הזו), Switch
מתאים להגדרה דחופה (state toggle — האם תכונה פעילה כעת). הרשאות הן
configuration שנקבעת לפני submit / שמירה — ולכן Checkbox.

### Code shape
- `Action = 'view' | 'edit'`
- `ModulePermission = { module, canView, canEdit }`
- `hasPermission(role, perms, module, action)` — super_admin: true תמיד;
  admin: true פרט ל-`SUPER_ADMIN_ONLY`; manager/viewer: לפי המטריצה.

### Matrix component modes
ה-`PermissionMatrix` תומכת בשני מצבים:
- **Auto-save** (UserSidePanel): רק `userId` + `permissions` + `onMutated`.
  כל toggle שולח `PUT /api/users/{userId}/permissions` ומציג toast.
- **Controlled** (InviteUserPanel): `value` + `onChange`. הקומפוננטה לא
  מבצעת קריאת API ולא מציגה toast — ה-parent מחזיק state ושולח כשהוא
  מוכן (למשל יחד עם invite creation).

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
+ focus ring מותגי (§2). Textarea: `min-h-[184px] resize-none leading-[1.85]`.

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
<div className="flex h-screen bg-app">         {/* row, RTL → סיידבר בימין */}
  <Sidebar />                                  {/* עמודה מלאת-גובה בקצה ימין, brand בראשה */}
  <div className="flex flex-1 flex-col overflow-hidden">
    <Header />                                 {/* בתוך אזור התוכן בלבד */}
    <main className="flex-1 overflow-auto bg-app">
      <div className="mx-auto max-w-[1640px] p-[18px] md:p-6">{children}</div>
    </main>
  </div>
</div>
```

**עקרונות (מה שמנע את הסטייה):**
- **הסיידבר הוא עמודה מלאת-גובה בקצה ימין** — נמתח מ-`top` ל-`bottom` של המסך (הילד הראשון ב-row, `align-items: stretch`). ה-brand block בראשו עולה עד הקצה העליון ממש.
- **ה-Header יושב רק מעל אזור התוכן** — הוא ילד של עמודת התוכן (`flex-1 flex-col`), ולכן **נעצר בגבול הסיידבר ולא חוצה מעליו**. זו הנקודה הקריטית: header אסור שיהיה אח (sibling) של הסיידבר ברמת ה-row.
- **יישור הקווים התחתונים**: ה-brand block (§14) וה-Header (§15) חולקים `h-16` + `border-b border-line` → שני הקווים התחתונים מתלכדים לקו רציף אחד לרוחב ראש המסך.
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

## אם משהו חסר כאן

לפני שאתה מנחש — בדוק שתי קומפוננטות קיימות באותה משפחה (טבלאות, קלפים, וכו'). אם אין דפוס קיים — שאל את המשתמש לפני שאתה ממציא וריאציה חדשה. עדכון ל-DESIGN.md הוא חלק מ-MR — לא משאיר decision לא-מתועד.

---

## חריגים מוצהרים

מסך /messages (צ'אט וואטסאפ) — חריג מאושר. מעוצב ירוק-וואטסאפ (#16a34a) כ-primary במקום blue-600, 1:1 עם ref/whatsapp.html, כדי לשמר זהות ויזואלית של וואטסאפ. אין להחיל עליו את כלל primary=blue. כל שאר המערכת ממשיכה כחול.

טופס אירוע יומן (`event-form-panel`) — חריג מאושר. שדות בגובה **44px (`h-11`)** במקום `h-10` הסטנדרטי בפאנלים, לפי החלטת המשתמש להתאמה פיקסלית ל-`ref/אירוע חדש`. חל **רק** על טופס האירוע ביומן; שאר הפאנלים (משימות/תקלות/ספקים) נשארים `h-10`.

גריד שבוע/יום ביומן — חריג מאושר. חלון השעות הוא **08:00–20:00** (שעות עבודה) במקום 07:00–20:00 שב-ref, לפי החלטת המשתמש. פריט מחוץ לחלון עובר clamp לשורת הקצה.

חיווי נוכחות בצ׳אט הפנימי (`/chat`) — חריג מאושר. ה**ירוק** (`emerald-500` נקודה, `text-emerald-600` לטקסט „מחובר עכשיו”) הוא חיווי **online/presence** בלבד — נקודה על האווטאר ב-header וברשימה, ושורת „● מחובר עכשיו” ב-header של שיחת 1:1. תואם את ה-Active-dot המוצהר (sect 9b). זה **אינו** primary — כל שאר הצ׳אט נשאר blue-600 (בועות נשלח, badge, כפתורים). הנוכחות נגזרת מ-`users.last_seen_at < 60s`, מתעדכנת חי דרך ה-SSE (`/api/chat/stream`).
