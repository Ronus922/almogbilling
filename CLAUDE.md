@AGENTS.md
@GIT_PUSH_SKILL.md


---

## כללי ברזל (מחייבים!)
1. **RTL First** - כל עיצוב מימין לשמאל
2. **Mobile First** - responsive תמיד
3. **TypeScript Strict** - אין `any`, אין `console.log`
4. **Gap Over Margin** - Parent שולט על ריווח
5. **תוכן לא נוגע בבורדר** - padding תמיד!
6. **Touch Target** - מינימום 44x44px
7. **globals.css = תוכן עניינים** - globals.css מכיל רק `@import` (30 שורות מקס). כל CSS בתת-קבצים ב-`app/styles/`. קובץ partial מקסימום 1500 שורות
8. **DRY Components** - מבנה שחוזר → קומפוננטה רוחבית עם props לתוכן/צבעים. אין קוד כפול!
9. **CSS Cleanup** - כשמוחקים/מבטלים אלמנט → תמיד שאל: "למחוק גם את ה-CSS שלו?" אל תשאיר CSS יתום!
10. **ניהול context (קריטי!)** - אחרי כל 2 משימות חייבים להריץ `/compact`. אם המשתמש מסרב - להזהיר: "השיחה תתקע בקרוב ולא יהיה אפשר לשחזר". לפני סגירה - `/end`. **אסור לחכות ל-3+ משימות בלי compact!**
11. **Deploy = `npm run deploy` (לא `npm run build` לבד!)** - כל שינוי קוד שמיועד לפרודקשן **חייב** להסתיים ב-`npm run deploy` (build → `systemctl restart billing.service` → אימות שהשירות `active` ושהתהליך החדש עלה אחרי כתיבת `.next/BUILD_ID`). `npm run build` לבד דורס את `.next/standalone/` בלי restart → התהליך הרץ מגיש chunks ישנים → "This page couldn't load". `npm run build` לבד מותר **רק** לבדיקת קומפילציה, לעולם לא כ-deploy. הסקריפט: `scripts/deploy.sh`.
12. **ניקוי נתוני בדיקה — לפי id שיצרת, לא לפי פילטר** - כשבדיקה/סקריפט יוצר רשומות זמניות (במיוחד ב-`public.sessions`), **שמור את ה-`id` המדויק ברגע היצירה ומחק רק אותו**. אסור לנקות לפי `user_id`, `expires_at`, טווח זמן, שם, או כל פילטר "שנראה נכון" — פילטר רחב מדי פוגע ברשומות של משתמשים חיים. ב-22/08/2026 ניקוי לפי `user_id + expires_at` ניתק משתמשים אמיתיים מהמערכת. הכלל חל על כל טבלה, לא רק sessions: אם לא שמרת את המזהה, אל תמחק — שאל.


---

## 🎨 חוק עיצוב מחייב (DESIGN LAW — אסור לחרוג!)

**לפני בנייה או שינוי של כל קומפוננטת UI — חובה (ללא יוצא מן הכלל):**

1. **לקרוא את `DESIGN.md`** (מקור-האמת היחיד לעיצוב) ואת הסקילים **`/design-system`** ו-**`/side-panel`**, **וליישם אותם אחד-לאחד**. אין להתחיל UI בלי זה.
2. **כל CREATE / EDIT נפתח ב-Side Panel** — `Sheet` עם `side="left"` ו-`sm:w-[55vw]` — **ולעולם לא ב-`Dialog`**. `Dialog`/`AlertDialog` שמורים אך ורק ל**אישורים** (מחיקה/יציאה-ללא-שמירה) ול**עריכת שדה בודד**.
3. **טבלאות, טפסים, ריווחים, צבעים וטיפוגרפיה — אך ורק לפי `DESIGN.md`.** משתמשים בקומפוננטות המשותפות הקיימות (`@/components/side-panel/Section`, `PanelFooter`, ה-`Field` הסטנדרטי, פלטת ה-tones של `DESIGN.md`).
4. **אסור לאלתר עיצוב, אסור לפרש מחדש, ואסור להסתמך על ברירות-המחדל של shadcn** כאשר קיימת הגדרה ב-`DESIGN.md` (למשל גובה Input `h-10` בפאנלים, `SelectValue` עם children-function כשיש JSX, error state `border-red-400 bg-red-50`).
5. **סטייה מהכללים נחשבת באג לכל דבר** — מתקנים אותה כמו באג, לא "בהזדמנות". בכל קובץ UI שנוגעים בו במשימה — מוודאים תאימות מלאה ל-`DESIGN.md` ומתקנים סטיות קיימות באותו קובץ.


---

## Minimum Padding (חובה!)
| Element | Minimum |
|---------|---------|
| Button | `px-4 py-2` |
| Card/Container | `p-4` |
| Input | `px-3 py-2` |
| Badge | `px-2 py-0.5` |
| Table Cell | `px-4 py-3` |
| List Item | `p-3` |
| Modal | `p-6` |

```tsx
// ✅ Always
<div className="border p-4">content</div>
<button className="border px-4 py-2">click</button>

// ❌ Never
<div className="border">content</div>
<button className="border">click</button>
```

---


---

## Ruflo — תמיד פעיל (ALWAYS ON)

**Ruflo/claude-flow v3 הוא שכבת האורקסטרציה הקבועה של כל שיחה.**

| פלטפורמה | אחריות |
|----------|--------|
| 🔵 Claude Code | ארכיטקטורה, אבטחה, בדיקות, code review, PRD |
| 🟢 Codex (OMX) | מימוש, ריפקטורינג, אופטימיזציה, boilerplate |

- כל החלטת ארכיטקטורה → כתוב לזיכרון: `npx claude-flow@v3alpha memory write --namespace collaboration`
- משימות מורכבות → `npx claude-flow-codex dual run --namespace collaboration`
- Swarm → `npx claude-flow@v3alpha swarm run --topology hierarchical --max-agents 8`
- תמיד `doctor --fix` לפני swarm
- `/ruflo` לטעינת הסקייל המלא

---


---

## OMX Runtime (ברירת מחדל תפעולית)
- `omx` מריץ את Codex תחת `oh-my-codex`
- עבודה רחבה, רב-קובצית, refactor, debug ארוך או handoff-heavy: ברירת המחדל היא `omx team`
- `om "<task>"` הוא ה־shortcut הראשי: `omx team 3:executor "<task>"`
- `/prompts:planner`, `/prompts:architect`, `/prompts:executor`, `/prompts:verifier` הם משטחי העבודה הדיפולטיים של OMX
- `omd` מפעיל `omx doctor --team`
- `omx team status <team>`, `omx team resume <team>`, `omx team shutdown <team>` הם כלי הבקרה
- לא מריצים `omx agents-init .` בפרויקט KIT רגיל; התבניות של ה־KIT הן ה־source of truth ל־`CLAUDE.md` ו־`AGENTS.md`

---


---

## Agents & Skills

**מקור-אמת יחיד:** בחירת agent, decision trees, task decomposition, וקטלוג מלא של כל ה-skills/agents — טען `/master`.

- כל ה-skills זמינים אוטומטית כ-`/<name>` (auto-discovery) — לדוגמה `/design`, `/api`, `/security`, `/qa`, `/ruflo`.
- כל ה-agents זמינים דרך כלי ה-Task (Design, API, Security, QA, Fullstack, Ruflo, ועוד).
- הרשימה החיה המלאה נוצרת אוטומטית ב-`/master` (`gen-catalog.sh`) — לעולם לא ידנית, לעולם לא מתיישנת.

---


---

## Recommended Dependencies (Standard Stack)

Every CRM/Dashboard/Web project should include these libraries. Install with `--full` flag in `new-project`.

### Tier 1 — חובה (כל פרויקט)

```bash
pnpm add @tanstack/react-table @tanstack/react-query recharts \
  react-hook-form @hookform/resolvers zod nuqs
```

| Library | Purpose | RTL |
|---------|---------|-----|
| `@tanstack/react-table` | Headless tables — sorting, filtering, pagination. Shadcn DataTable built on it. | Headless = full RTL control |
| `@tanstack/react-query` | Server state — cache, background refresh, loading/error. Every Supabase fetch. | N/A |
| `recharts` | Charts for dashboards. Shadcn Chart component built on it. | `direction="rtl"` |
| `react-hook-form` + `@hookform/resolvers` | Form state. Shadcn Form built on it. Minimal re-renders. | N/A |
| `zod` | Schema validation — forms, Server Actions, API. | N/A |
| `nuqs` | URL state — filters, search, pagination as URL params. | N/A |

### Tier 2 — מומלץ

```bash
pnpm add zustand next-safe-action @formkit/auto-animate sonner cmdk
```

| Library | Purpose |
|---------|---------|
| `zustand` | Client state (~1KB) — sidebar, wizard, UI toggles. Replaces Context bloat. |
| `next-safe-action` | Type-safe Server Actions with Zod validation + middleware (auth, rate-limit). |
| `@formkit/auto-animate` | One hook, zero config — auto-animates DOM additions/removals (~2KB). |
| `sonner` | Toast notifications — already used in pye9/synthesis. |
| `cmdk` | Command palette (⌘K) — quick search in any CRM. |

### Tier 3 — לפי צורך

| Library | When |
|---------|------|
| `@react-pdf/renderer` | PDF generation (invoices, reports) — JSX → PDF with Hebrew fonts |
| `ai` (Vercel AI SDK) | AI chat interface — `useChat`, streaming, multi-provider |
| `uploadthing` | File uploads — full-stack (S3 + validation + webhooks) |
| `@dnd-kit/core` + `@dnd-kit/sortable` | Drag-and-drop, Kanban boards |
| `next-intl` | Full i18n (Hebrew + English + Arabic) |
| `react-resizable-panels` | Split views, resizable sidebars |
