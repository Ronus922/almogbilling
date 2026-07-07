# DECISIONS

## WhatsApp durable delivery engine — CUT OVER TO PRODUCTION (2026-07-07)

**Status: LIVE.** The broadcast redesign cut the fire-and-forget in-process runner
over to the durable queue + external worker. Done in this cutover:
- Migration `059` **applied to prod** (`wa_campaigns`, `wa_campaign_recipients`,
  `wa_send_log`, `wa_worker_heartbeat`, `reconcile_wa_campaign`), plus adaptations:
  `template_name` snapshot on campaigns; `delivered_at`/`read_at` on recipients.
- Worker **installed + running**: `deploy/wa-queue-worker.service` →
  `/etc/systemd/system/wa-queue-worker.service`, `enable --now`, heartbeat live.
- **UI cut over**: broadcasts now live at `/whatsapp/broadcasts` (history table),
  `/whatsapp/broadcasts/new` (compose), `/whatsapp/broadcasts/[id]` (details +
  delivery log). The `/messages` "תפוצה" button routes here; nav item added.
- **Fire-and-forget retired**: `runBroadcast`/`startBroadcast` deleted, old
  `POST/GET /api/whatsapp/broadcasts` route removed, `BroadcastPanel` deleted.
  `resolveBroadcastRecipients` kept (used by `/campaigns` + `/audience-count`).
- **Cancellation is real**: atomic `cancelCampaign` (idempotent, marks
  pending/processing → cancelled, never touches sent), audit row on cancel,
  worker only claims from `running` campaigns. Verified live end-to-end.
- Legacy `whatsapp_broadcasts` rows are **left intact** (not migrated, not
  deleted); new history reads `wa_campaigns` going forward.
- **Deliberate scope decisions**: no literal `cancel_requested` DB state (atomic
  cancel is stronger + race-free; the "עוצר…" state is a UI transient); durable
  broadcasts are NOT mirrored into `chat_messages` (tracked in the recipient log
  — avoids the chat_messages bloat that made the old design unscalable);
  pause/resume/retry_failed stay backend-only (not surfaced — no "resend all").

---

## WhatsApp durable delivery engine (Phase 2) — built on branch, NOT cut over (2026-07-06)

Replaces the fire-and-forget in-process broadcast runner with a DB-backed queue +
external worker. **Broadcast scope only** (per approval); bulk-send / notifications /
reminders are unchanged for now. Built for review — **not wired to production**: the
migration is NOT applied to the prod DB, no worker runs on prod, and the existing
`whatsapp-broadcast.ts` path is untouched. All testing used a **mock provider** and a
throwaway DB (`proj_billing_wqtest`) — **no real WhatsApp message was sent**.

### What exists (branch `main`, uncommitted → to be committed in slices)
- **Migration** `supabase/migrations/059_whatsapp_delivery_queue.sql` (applied only to the
  test DB): `wa_campaigns`, `wa_campaign_recipients`, `wa_send_log` (shared rate limiter),
  `wa_worker_heartbeat`, and `reconcile_wa_campaign()`. Loosely coupled (no FKs to
  users/debtors) so it is testable in isolation and a deleted debtor can't orphan a send.
- **Engine** `src/lib/wa-queue/` — types, error classification, provider (`GreenApiProvider`
  + `MockProvider`), rate limiter, `engine.ts` (atomic claim `FOR UPDATE SKIP LOCKED`,
  lease processing, `recoverLeases`, `reconcile`), `campaigns.ts` (create/enqueue +
  start/pause/resume/cancel/retry_failed with validated transitions), `worker.ts`
  (graceful shutdown, heartbeat, per-campaign creds), `health.ts`.
- **Worker** `scripts/wa-queue-worker.ts` + `deploy/wa-queue-worker.service` (systemd
  TEMPLATE — billing uses systemd, not PM2; **not installed**).
- **API** `src/app/api/whatsapp/campaigns/**` — durable create (returns id immediately,
  idempotent on `client_token`), `[id]` status, `[id]/actions` (start/pause/resume/cancel/
  retry_failed → 409 on invalid transition), `[id]/recipients` (inspect failures),
  `health`. All gated `whatsapp_chat` view/edit (the existing RBAC — no second model).
- **Tests** `tests/wa-queue.test.ts` — 21 integration tests (skip cleanly without
  `WA_TEST_DATABASE_URL`) + backoff/classification unit tests. Cover: idempotency,
  atomic + concurrent claim, transient retry, permanent no-retry, lease recovery
  (before-send re-queue / after-send indeterminate), **deployment-interruption →
  at-most-once**, duplicate workers, pause/resume/cancel, retry_failed, stale + counter
  reconciliation, rate limit, RBAC.

### Key design decisions
- **Exactly-once-safe recovery**: an item that crashed *before* the send is re-queued; one
  that crashed *after* `send_attempted_at` is marked `indeterminate` and **never
  auto-resent** — only an explicit operator `retry_failed` (a human decision) can re-send
  it. So auto-recovery never duplicates a delivered message (Green API has no
  client-supplied idempotency key, so at-least-once is otherwise unavoidable).
- **Counters are derived**, `status` is the source of truth; `reconcile_wa_campaign()` +
  the worker's `reconcileStale()` roll a campaign up from row truth, so a dead process can
  never strand a campaign in `running` forever.
- **One shared DB-backed rate limiter** (`wa_send_log`) — correct across worker restarts
  and multiple workers; replaces the scattered in-memory `setTimeout` sleeps.
- **RBAC**: reused `whatsapp_chat` view/edit (reads→view, all mutations→edit). Billing's
  RBAC has only two actions per module, so the task's granular per-control permissions
  collapse onto that existing model — no second authorization system, no prod re-seed.

### Cutover plan (requires approval — the irreversible steps)
1. Apply `059` to the prod billing DB (`psql "$DIRECT_URL" -f …059….sql`).
2. Install + start the worker (`deploy/wa-queue-worker.service`), add it to site-health.
3. Point the broadcast UI/route at `/api/whatsapp/campaigns` (create with `dry_run:false`);
   retire `whatsapp-broadcast.ts`'s `void runBroadcast`.
4. Migrate legacy `whatsapp_broadcasts` rows: map to `wa_campaigns`; any stuck in
   `running` → mark **requires-reconciliation** (do NOT auto-resend — exact recipient
   state is unknown), and give the operator an explicit recovery action.
5. Later slices (separate approval): bulk-send, notifications, reminders onto the same
   engine + shared limiter.

---

## WhatsApp broadcast audit (2026-07-06, read-only)

ממצאי audit של זרימות השליחה ההמונית ב-WhatsApp. אין שינויי קוד — תיעוד בלבד.
קיימות **שתי** זרימות bulk נפרדות + שני senders מרובי-נמענים משיקים (התראות/תזכורות).

### 1. נקודות הפעלה (triggers)

| זרימה | UI | Route | מנוע |
|-------|----|-------|------|
| **Broadcast (קמפיין)** | `src/app/(app)/messages/components/BroadcastPanel.tsx` | `POST /api/whatsapp/broadcasts` — `src/app/api/whatsapp/broadcasts/route.ts` (RBAC `whatsapp_chat:edit`) | `startBroadcast()` — `src/lib/whatsapp-broadcast.ts:211` |
| **Bulk-send (עד 50 חייבים)** | `src/components/whatsapp/WhatsAppBulkSendPanel.tsx` | `POST /api/whatsapp/send-bulk` — `src/app/api/whatsapp/send-bulk/route.ts` (RBAC `whatsapp:edit`) | לולאה בתוך ה-route עצמו |

אין טריגר אוטומטי ל-broadcast: אין cron/n8n. הטריגר האוטומטי היחיד לשליחת
WhatsApp בכלל הוא `billing-reminders.timer` (systemd, כל 5 דק') →
`scripts/run-reminders.sh` → `POST /api/cron/reminders` — זרימת **תזכורות**,
לא broadcast.

### 2. מנגנון השליחה (dispatch)

**Broadcast** — לולאה סדרתית fire-and-forget בתוך פרוסס השרת. ה-route מחזיר
תשובה מיד; אין queue חיצוני ואין worker (`src/lib/whatsapp-broadcast.ts:232-234`):

```ts
// Fire-and-forget — do NOT await; the request returns now and the loop runs in
// the background of the server process.
void runBroadcast(broadcast.id, recipients, input.body, actor.id, creds);
```

הלולאה (`runBroadcast`, שם, שורות 144-193): לכל נמען — אינטרפולציית תבנית →
`sendWhatsAppMessage` (Green API) → `insertChatMessage` (שורת DB פר-הודעה עם
`broadcast_id`, `status: 'sent'|'failed'`, `externalMessageId`) →
`bumpBroadcastCounters`. כישלון של נמען בודד לא עוצר את הקמפיין. ה-UI עוקב
בפולינג (`GET /api/whatsapp/broadcasts`).

**Bulk-send** — לולאה סדרתית **סינכרונית בתוך הבקשה** שמזרימה NDJSON
(שורת progress פר-נמען + summary; `X-Accel-Buffering: no` בשביל nginx).
הבקשה חיה עד סוף כל השליחות; ניתוק ה-client (`req.signal.aborted`) עוצר את
הלולאה (`send-bulk/route.ts:90-148`).

### 3. טבלת קמפיינים ורשומות פר-הודעה

`public.whatsapp_broadcasts` (migration `018_whatsapp_chat_inbox.sql:26-39`):

```sql
id uuid PK · name text · body text · audience_filter jsonb
total_count int · sent_count int · failed_count int
status text CHECK ('pending','running','completed','failed')
created_by uuid → users · created_at · completed_at
(+ instance_id uuid — migration 020)
```

**כל הודעה יוצאת היא שורת DB** ב-`chat_messages` עם סטטוס משלה
(`sent`/`failed` + `error_detail`), מקושרת ב-`broadcast_id` (broadcast) או דרך
`sendAndRecordWhatsApp` (bulk-send, שגם רושם debtor event ומעדכן
`last_whatsapp_sent_at`). לא fire-and-forget ברמת התיעוד — רק ברמת ההרצה.

### 4. מוות באמצע שליחה — resume / duplicate / stop?

**עוצר מת, בלי resume ובלי duplicate אוטומטי:**

- הלולאה חיה בזיכרון הפרוסס בלבד. `kill`/deploy/restart (וזכור: כל deploy של
  billing עושה restart!) הורג אותה באמצע.
- שורת הקמפיין נשארת `status='running'` **לנצח** — `finishBroadcast('failed')`
  נקרא רק על exception שנתפס, לא על מוות של הפרוסס.
- אין שום קוד שמאתר קמפיינים תקועים ב-startup/cron (נבדק: אין סריקת
  `'running'`/`'pending'` בכל `src/`).
- אין duplicate אוטומטי — אבל הרצה ידנית חוזרת של אותו קמפיין יוצרת broadcast
  חדש ושולחת שוב **לכל** הנמענים, כולל מי שכבר קיבל (אין בדיקת already-sent
  מול `chat_messages`).
- ב-bulk-send: מוות של הפרוסס או ניתוק client עוצר; מה שנשלח נשלח (ומתועד),
  השאר לא. אין resume.

### 5. השהיות / rate-limit

| זרימה | pacing |
|-------|--------|
| Broadcast | 3–6 שניות אקראי בין הודעות (`whatsapp-broadcast.ts:189-192`) — anti-ban |
| Bulk-send | קבוע 2,500ms בין הודעות, תקרת 50 נמענים (`send-bulk/route.ts:17-18`) |
| התראות (`services/createNotify.ts:112-118`) | **אין** — `Promise.allSettled` מקבילי |
| תזכורות (`lib/reminders/engine.ts:254+`) | **אין** — לולאה סדרתית בלי sleep |

אין טיפול ב-429/backoff מול Green API באף זרימה.

### סיכונים שתועדו (ללא תיקון — דורשים החלטה)

1. **קמפיין תקוע**: restart באמצע broadcast ⇒ `running` לנצח + נמענים שלא
   קיבלו; אין דרך לחדש בלי לשלוח כפול לכולם.
2. **חוסר עקביות RBAC**: bulk-send דורש `whatsapp:edit`, broadcast דורש
   `whatsapp_chat:edit` — שתי הרשאות שונות לאותה יכולת עסקית.
3. **anti-ban חסר בהתראות/תזכורות**: שליחה מרובת-נמענים בלי השהיה דרך אותו
   instance ברירת-מחדל שמשמש קמפיינים.
