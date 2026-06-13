# RUN SUMMARY — רצף 4 מודולים (תזמור אוטונומי)

> ביצוע אוטונומי מקצה-לקצה של 4 מודולים ברצף, כל אחד דרך סוכן-משנה ייעודי,
> עם שער אימות בין מודול למודול. תאריך: 2026-06-13.
> נקודת התחלה: `e23e2a7`. נקודת סיום: `7005bbc` (נדחף ל-origin/main).

---

## טבלת סטטוס

| # | מודול | STATUS | מיגרציה | feat commit | docs commit | עמוד | בדיקת שער |
|---|-------|--------|---------|-------------|-------------|------|-----------|
| 1 | משימות + התראות + מנוע תזכורות | ✅ SUCCESS | `023` | `e17ae7f` | `6bf58f7` | `/tasks` (307) | עבר |
| 2 | תקלות (Issues) | ✅ SUCCESS | `024` | `b698c4b` | `870bf19` | `/issues` (307) | עבר |
| 3 | לוח שנה (Calendar) | ✅ SUCCESS | `025` | `bfa080a` | `d8490ed` | `/calendar` (307) | עבר |
| 4 | צ׳אט פנימי (Internal Chat) | ✅ SUCCESS | `026` | `6566388` | `7005bbc` | `/chat` (307) | עבר |

**מצב סופי של השירות:** `billing.service` = **active** · `/api/health` = **200** ·
כל 4 העמודים מחזירים **307** (קיימים, redirect לאימות — לא 404) · אין `FAILURE_REPORT.md` ·
`git` מסונכרן מול origin (ahead=0 / behind=0) · עץ-עבודה נקי (רק `prompts/` נשאר untracked מכוון).

כל שער בין-מודולי אומת עצמאית על-ידי המתזמר: היעדר FAILURE_REPORT, `npm run build` תקין,
`systemctl is-active billing`, `/api/health`=200, העמוד החדש מחזיר 307 (לא 404),
וה-commit נדחף בפועל ל-origin (`HEAD == origin/main` אחרי `git fetch`).

---

## מיגרציות שנוספו (אדיטיביות בלבד, הורצו ידנית מול ה-DB)

> הערה תפעולית: `deploy.sh` **אינו** מריץ מיגרציות (אין `scripts/run-migrations.ts`).
> כל מיגרציה הורצה ידנית עם `psql "$DIRECT_URL"`. **בכל שחזור/בנייה-מחדש של ה-DB יש להריץ אותן ידנית.**

| קובץ | טבלאות / שינויים |
|------|-------------------|
| `023_tasks_notifications_reminders.sql` | `tasks`, `task_comments`, `notifications`, `reminders` (מנוע גנרי) |
| `024_issues.sql` | `issues`, `issue_comments` + `ADD COLUMN tasks.issue_id` (FK ON DELETE SET NULL) |
| `025_calendar.sql` | `calendar_events` (כולל שדות חזרתיות + `parent_series_id` self-FK), `calendar_event_participants` |
| `026_internal_chat.sql` | `internal_conversations`, `internal_conversation_participants`, `internal_messages` |

---

## Endpoints חדשים

**מודול 1 — משימות / התראות / תזכורות**
- `GET/POST /api/tasks` · `GET/PATCH/DELETE /api/tasks/[id]`
- `GET/POST /api/tasks/[id]/comments` · `PATCH /api/tasks/reorder` (batch קנבן) · `GET /api/tasks/assignees`
- `GET/PATCH /api/notifications` (של המשתמש בלבד; בודד + mark-all)
- `POST /api/cron/reminders` (מאובטח `x-cron-secret`, fail-closed + constant-time)

**מודול 2 — תקלות**
- `GET/POST /api/issues` · `GET/PATCH/DELETE /api/issues/[id]`
- `GET/POST /api/issues/[id]/comments`
- `POST/DELETE /api/issues/[id]/images` (Supabase Storage, ולידציה בשרת: jpg/png/webp ≤5MB ≤6)
- `POST /api/issues/[id]/create-task` (טרנזקציה, קישור דו-כיווני) · `GET /api/issues/assignees`

**מודול 3 — לוח שנה**
- `GET /api/calendar?from=&to=` (אירועים בטווח + משימות due_date read-only)
- `POST /api/calendar/events` · `GET/PATCH/DELETE /api/calendar/events/[id]` (`scope=single|future`)
- `GET /api/calendar/participants?search=` (משתמשים + אנשי קשר)

**מודול 4 — צ׳אט פנימי**
- `GET/POST /api/chat/conversations` (direct עם dedup / group)
- `GET/POST /api/chat/conversations/[id]/messages?since=` (gated ל-participant; mark-read)
- `GET /api/chat/users` (picker)

---

## עמודים וקומפוננטות חדשים

- **עמודים** (תחת `src/app/(app)/`): `/tasks`, `/issues`, `/calendar`, `/chat` — כולם נוספו לסיידבר.
- **NotificationBell** בכותרת העליונה (polling 60s, מונה לא-נקראו, dropdown, ניווט ל-`action_url`).
- **Side Panel** ליצירה/עריכה בכל המודולים (Sheet, side=left, 55vw, dirty-tracking, confirm-exit) —
  למעט החריגים המאושרים: Dialog לאישור scope-סדרה בלוח השנה, ו-Dialog ל"שיחה חדשה" בצ׳אט.
- **תשתית משותפת חוצת-מודולים:** מנוע `reminders` גנרי (`src/lib/reminders/engine.ts`) עם ענפים
  per `entity_type` — `task`, `issue`, `calendar_event` (action_url=`/calendar`); שירות `notifications`.
- **systemd timer:** `billing-reminders.timer` (+ `.service`) — רץ כל 5 דקות, **active + enabled**.
  מזריק את ה-secret דרך `EnvironmentFile`/stdin (לא ב-argv).

---

## אבטחה — תמצית הממצאים שתוקנו

- **מודול 1:** RBAC לכל route, בידוד התראות per-user, פרמטריזציה מלאה, cron fail-closed +
  constant-time, ניקוי reminders יתומים ב-DELETE משימה.
- **מודול 2:** UUID guards על routes `[id]` (404 נקי במקום 500), העלאת תמונה אטומית (cap בתוך ה-UPDATE),
  ללא path-traversal (object key נגזר-שרת), service-role key לעולם לא חוזר ללקוח.
- **מודול 3:** UUID guards על `[id]`, ולידציית תאריך round-trip (דחיית 2026-02-30 וכד'),
  טווח `from/to` חובה ומוגבל ל-~13 חודשים, **בידוד סדרות** מוכח (`FOR UPDATE` + scope ל-`seriesRoot`).
- **מודול 4 (קריטי IDOR):** כל endpoint דורש participant — גישה לשיחה זרה מחזירה **403** (נבדק חי),
  ללא existence-oracle, allow-list לחברי שיחה, `MAX_GROUP_MEMBERS=50`, render דרך `{content}`
  (React-escaped, **אין `dangerouslySetInnerHTML`** — אומת).

---

## ⚠️ נקודות שדורשות בדיקה ידנית שלך

1. **בדיקה ויזואלית חיה ב-UI** (כל ה-smoke היו ברמת API/DB, לא רנדור):
   - `/tasks` — קנבן + גרירה, מתג טבלה/קנבן, פאנל יצירה, NotificationBell.
   - `/issues` — העלאת תמונה אמיתית + lightbox, "צור משימה מתקלה" והקישור הדו-כיווני.
   - `/calendar` — מתג חודש/שבוע/יום, recurrence panel, חיפוש משתתפים, דיאלוג scope-סדרה.
   - `/chat` — שליחה ב-Enter, מצב קבוצה, RTL/מובייל, deep-link `?c=` מהפעמון.
2. **מיילים (לא נבדקו חי):** הקצאת משימה / תזכורת `both`-channel רוכבים על נתיב ה-Gmail SMTP הקיים —
   כדאי לאמת משלוח אחד אמיתי. במודול 3 תזכורת אירוע נשלחת ל**יוצר** האירוע (anchor לשורש הסדרה) —
   ודא שזו סמנטיקת הנמען הרצויה (מול owner / כל המשתתפים).
3. **בורר חייב בפאנל משימה:** קיים שדה חופשי `apartment_number` בלבד; ה-DB/API תומכים ב-`debtor_id`
   אך לא נוסף picker (endpoint חיפוש החייבים gated `whatsapp:edit`). דורש סליס המשך אם רוצים בורר.
4. **תזכורות-תקלה:** המנוע תומך ב-`entity_type='issue'` אך אין UI ליצירת תזכורת על תקלה — סליס המשך.
5. **bucket `issue-attachments`:** פרטי, אכיפת mime/size ברמת האפליקציה (לא ברמת ה-bucket) — אפשר
   להוסיף `allowed_mime_types`/`file_size_limit` כשכבת הגנה נוספת.
6. **מיגרציות ידניות:** `deploy.sh` לא מריץ מיגרציות — בכל שחזור DB יש להריץ `023`–`026` ידנית.
7. **`prompts/`** נשאר untracked מכוון (קבצי מפרט המשימה, לא תוצר) — החלט אם לקמט בעתיד.

---

## רצף הקומיטים (8 — feat+docs לכל מודול)

```
e17ae7f feat(tasks)     6bf58f7 docs   ← מודול 1
b698c4b feat(issues)    870bf19 docs   ← מודול 2
bfa080a feat(calendar)  d8490ed docs   ← מודול 3
6566388 feat(chat)      7005bbc docs   ← מודול 4
```

כל הקומיטים נדחפו ל-`origin/main`. אסור היה force-push / מחיקת נתונים / next build ישיר —
לא נעשו. כל deploy בוצע דרך `npm run deploy` (build → restart → healthcheck).
