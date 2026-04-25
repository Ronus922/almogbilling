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
4. **Heebo בלבד**: אין להחדיר Inter/Roboto/Arial.
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
| Numeric data | `tabular-nums` (חובה לכסף ולטלפונים) |

**Font weights**: `font-extrabold` (800) > `font-bold` (700) > `font-semibold` (600) > `font-medium` (500) > `font-normal` (400).

---

## 4. Spacing

Stack rhythms בשימוש בפרויקט: `gap-1.5` / `gap-2` / `gap-3` / `gap-4` / `gap-5` / `gap-6` / `gap-8`.
Padding nominals: `p-3` / `p-4` / `p-5` / `p-6` / `p-8` / `p-10`.
**העדף `space-y-{n}` בין סקשנים, `gap-{n}` בתוך flex/grid.**

---

## 5. Buttons

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

## 5b. Sync & Import buttons (LastImportIndicator pattern)

מערכת כפתורים סטנדרטית למסכי נתונים שמציגים מצב עדכון אחרון (Dashboard, וכו').

### Button — "סנכרן עכשיו"
```tsx
<Button
  type="button"
  onClick={syncNow}
  disabled={syncing}
  className="h-9 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold gap-2"
>
  <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
  <span>{syncing ? 'מסנכרן…' : 'סנכרן עכשיו'}</span>
</Button>
```

### Button — "ייבוא נתונים"
```tsx
<Button
  type="button"
  onClick={() => router.push('/import')}
  className="h-9 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold gap-2"
>
  <Upload className="h-4 w-4" />
  <span>ייבוא נתונים</span>
</Button>
```
- מוצג **רק** כש-`isAdmin && showWarning` (כלומר severity != 'ok'). במצב OK אין צורך לדחוף את המשתמש לייבוא.

### Container (LastImportIndicator) — color by severity
```tsx
<div className={cn('flex flex-col gap-3 rounded-xl border px-5 py-3 md:flex-row md:items-center md:justify-between', styles.wrap)}>
```

| Severity | תנאי | bg | border |
|---|---|---|---|
| `ok`     | < 24h           | `bg-white`        | `border-slate-200` |
| `yellow` | 24–48h          | `bg-[#fef9c3]`    | `border-yellow-300` |
| `red`    | > 48h / null    | `bg-[#fee2e2]`    | `border-red-300` |

Icon-circle בצד ימין (start ב-RTL): `grid h-10 w-10 place-items-center rounded-full {iconBg} {iconFg}`.

---

## 6. Form Fields

### Input (default size)
- Default: `h-8` (shadcn). **בפאנלים מודרניים השתמש ב-`h-10`** (40px) לאחידות עם Select.
- Number/phone: `dir="ltr"` + `tabular-nums`.
- Padding for icons: `pe-9` (icon end) או `ps-9` (icon start).
- Focus state: ירש מ-shadcn (ring blue).
- Error state: `border-red-400 bg-red-50 focus:ring-red-200`.

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

`src/components/app-shell/Sidebar.tsx`:
- Container: `hidden w-64 shrink-0 border-l bg-card md:flex md:flex-col`
- Section header: `mb-2 px-3 text-xs font-medium text-muted-foreground`
- Item: `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors`
- **Active**: `bg-primary/10 text-primary font-medium`
- **Idle**: `hover:bg-muted`
- **Disabled**: `text-muted-foreground cursor-not-allowed opacity-60`
- Icon: `h-4 w-4 shrink-0`

---

## 15. Header (Top bar)

`src/components/app-shell/Header.tsx`:
- `flex h-16 items-center justify-end border-b bg-card px-6` — UserMenu מיושר לקצה השמאלי (end ב-RTL).

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

### Skeleton card
```tsx
<div className="h-40 rounded-xl bg-muted/60 animate-pulse" />
```
שורה: `h-4 w-{width} rounded bg-muted animate-pulse`.

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
- **Tooltip on disabled button**: לעטוף עם `<TooltipTrigger render={<span className="block" />}>` כדי שה-`disabled` button לא יבלע את ה-pointer events.

---

## אם משהו חסר כאן

לפני שאתה מנחש — בדוק שתי קומפוננטות קיימות באותה משפחה (טבלאות, קלפים, וכו'). אם אין דפוס קיים — שאל את המשתמש לפני שאתה ממציא וריאציה חדשה. עדכון ל-DESIGN.md הוא חלק מ-MR — לא משאיר decision לא-מתועד.
