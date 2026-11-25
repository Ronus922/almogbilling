'use client';

// The issue window opened from an Orders-tab row (v2 design of 24/11/2026,
// ref/chip-order/chip-issue-admin-v2.html):
//
//   · "בעלי הצ׳יפ" — ONE BLOCK PER PERSON of the order (its holder lines; an
//     order made before 20/11/2026 gets one block per apartment, from the
//     order's own name and phone): role, full name, apartment (read only), the
//     quantity ordered, phone and email (editable), the lease of a renter,
//     "עדכן בכרטיס הדייר" (writes to the tenants list ONLY on that click), and
//     the chip allocation — numbers + card / app, "שויכו X מתוך Y" (active
//     chips; green when full), the person's chips with the active / disabled
//     switch, the number fixed inline. The same person's earlier chips in the
//     apartment (matched by phone) show in the block, tagged "קודם".
//   · "הוסף בעל צ׳יפ" adds a person (a staff holder: never priced, never part
//     of the paid quantity). A block that has chips cannot be removed; a person
//     of the order cannot be removed at all (paid).
//   · "פירוט עסקה והערות" — the order (OrderTransaction) + the internal note.
//     (The fee fields — "עמלת הנפקה (₪)", "החיוב בוצע" — left the window on
//     25/11/2026, in both modes.)
//   · A CLOSED order — collected or rejected — is read only: its people and
//     its note cannot be edited and no number can be added (the server refuses
//     such a save anyway). That is how a RECEPTION order always opens: it was
//     paid at the reception and handed over on the spot, so it is collected
//     the moment it is made. The chips themselves can still be switched and
//     their numbers fixed — those are the chip's own actions, not the order's.
//   · "שמור שינויים" — ONE request, one transaction (POST
//     /api/chip-orders/[id]/holders): holder edits, staff holders, new numbers
//     (linked to the order line AND the holder line), the note. The window
//     STAYS OPEN afterwards (24/11/2026), reloaded on what is saved now.
//   · "מוכן לאיסוף" is ONE CLICK (24/11/2026): it may be pressed as soon as
//     every ordered chip is covered — by a saved chip or by a number still
//     waiting in the window — and it saves the window first (the same request
//     as "שמור שינויים") and only then marks the order ready. A save that
//     fails marks nothing. The server's own rule did not move: an order is
//     ready only when all its chips are issued.
//   · EXTRA CHIPS (25/11/2026). A new number beyond the quantity an apartment
//     line paid for online is an extra chip, and it has to be settled: the
//     payment section of the reception appears for the extras only — "אשראי"
//     (disabled), "מזומן או העברה" (the save makes a reception order for those
//     chips) or "ללא חיוב" (no order). The web order and its total never
//     change. Extra chips that were paid at the reception show in the person's
//     block, tagged, and are not part of the order's count.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink } from 'lucide-react';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { validatePhone } from '@/lib/validation';
import { cn } from '@/lib/utils';
import { e164ToLocal } from '@/lib/portal/phone';
import { MAX_CHIPS_PER_GROUP } from '@/lib/chips/issueGroups';
import { isOpenChipOrder, type ChipOrderRole, type ChipOrderWindow, type ChipOrderWindowChip, type ChipOrderWindowHolder } from '@/lib/chipOrders/model';
import { missingChipsText } from '@/lib/chipOrders/orderRows';
import {
  extraChipsOf, receptionAmount, receptionMethodInForce, receptionPaymentReason, type ReceptionContext, type ReceptionPaymentMethod,
} from '@/lib/chipOrders/reception';
import type { ChipResidentRole, ChipType } from '@/lib/types/chips';
import { HolderRegistryButton } from '../ChipOrderSection';
import {
  AlertIco, AmberNote, ChipAllocation, DiscardDialog, HolderBlock, IssueSheetFrame, IssueSheetFooter, PlusIco, ROLE_SHORT, RoleSegment,
  Section, UsersIco, WalletIco, useChipQuickActions, type PendingChip,
} from './parts';
import { OrderTransaction } from './OrderTransaction';
import { ReceptionPayment } from './reception';
import type { IssueChipSheetProps } from '../IssueChipSheet';

const DATE_ONLY = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' });
/** New numbers of one block in one save — the request bound of the server
 *  (chipOrderWindowSaveSchema), not a quantity rule (21/11/2026). */
const MAX_PENDING_PER_BLOCK = MAX_CHIPS_PER_GROUP;
/** "אני" — the reference's four states. "אורח" is the stored role `other`. */
const ROLE_OPTIONS = (['owner', 'tenant', 'operator', 'other'] as const).map((value) => ({ value, label: ROLE_SHORT[value] }));

interface Snapshot { role: ChipResidentRole; name: string; phone: string; email: string }

interface Block {
  key: number;
  /** The holder line id; null = a staff holder not saved yet, or a legacy block. */
  id: string | null;
  itemId: string;
  source: ChipOrderWindowHolder['source'];
  role: ChipResidentRole;
  name: string;
  phone: string;
  email: string;
  qty: number;
  lease: { key: string | null; name: string | null; end: string | null };
  chips: ChipOrderWindowChip[];
  existing: ChipOrderWindowChip[];
  /** Extra chips added for this person and paid at the reception. */
  extras: ChipOrderWindowChip[];
  pending: PendingChip[];
  numInput: string;
  numType: ChipType;
  dupHint: string | null;
  phoneTouched: boolean;
  /** The values the block was loaded with (null = new). */
  orig: Snapshot | null;
}

const identity = (b: { id: string | null; itemId: string; source: string; key: number }) =>
  b.id ? `h:${b.id}` : b.source === 'legacy' ? `l:${b.itemId}` : `n:${b.key}`;

const phoneView = (p: string | null) => (p ? (p.startsWith('+972') ? e164ToLocal(p) : p) : '');

function fromHolder(h: ChipOrderWindowHolder, key: number): Block {
  const snap: Snapshot = { role: h.role, name: h.full_name, phone: phoneView(h.phone), email: h.email ?? '' };
  return {
    key, id: h.id, itemId: h.item_id, source: h.source, role: h.role, name: snap.name, phone: snap.phone, email: snap.email,
    qty: h.chips_count, lease: { key: h.lease_file_key, name: h.lease_file_name, end: h.lease_end_date },
    chips: h.chips, existing: h.existing, extras: h.extras ?? [], pending: [], numInput: '', numType: 'physical', dupHint: null, phoneTouched: false,
    orig: snap,
  };
}

function effectivePending(b: Block): PendingChip[] {
  const r = b.numInput.trim();
  return r && !b.pending.some((p) => p.number === r) ? [...b.pending, { number: r, chip_type: b.numType }] : b.pending;
}

function edited(b: Block): boolean {
  if (!b.orig) return b.name.trim() !== '';
  return b.role !== b.orig.role || b.name.trim() !== b.orig.name || b.phone.trim() !== b.orig.phone || b.email.trim() !== b.orig.email;
}

async function fetchWindow(orderItemId: string): Promise<ChipOrderWindow> {
  const res = await fetch(`/api/chip-orders/items/${orderItemId}`, { credentials: 'include' });
  if (!res.ok) throw new Error(res.status === 404 ? 'ההזמנה לא נמצאה או כבר נסגרה' : 'טעינת ההזמנה נכשלה');
  const data = (await res.json()) as { window?: ChipOrderWindow };
  if (!data.window) throw new Error('טעינת ההזמנה נכשלה');
  return data.window;
}

export function OrderIssueSheet({
  open, onOpenChange, onIssued, canEditOrders = false, canWriteContacts = false, canCancelReception = false, orderItemId,
}: IssueChipSheetProps & { orderItemId: string }) {
  const [win, setWin] = useState<ChipOrderWindow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const seq = useRef(1);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const removedRef = useRef<string[]>([]);
  removedRef.current = removed;
  const [note, setNote] = useState('');
  const [noteOrig, setNoteOrig] = useState('');
  const [conflict, setConflict] = useState<{ blockKey: number; number: string } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** The one click of "מוכן לאיסוף" is running (save, then ready). */
  const [readyBusy, setReadyBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  // The extra chips of the save (beyond what was paid online): the price per
  // chip of /settings and whether "אשראי" is drawn (GET /api/chips/reception),
  // the method that was chosen, and the sum it confirmed.
  const [pricing, setPricing] = useState<Pick<ReceptionContext, 'unit_price' | 'card_option'> | null>(null);
  const [pricingTick, setPricingTick] = useState(0);
  const [method, setMethod] = useState<ReceptionPaymentMethod | null>(null);
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null);
  /** Only the newest load of the order may land (a reload after an immediate
   *  action must never overwrite the reload that follows a save). */
  const loadSeq = useRef(0);
  /** A save went through and its reload has not landed yet: whichever load
   *  lands next is the order as stored, even if it is not the one the save
   *  itself asked for — or saved numbers would stay on the screen as waiting. */
  const freshNext = useRef(false);

  const reload = () => setVersion((v) => v + 1);
  const quick = useChipQuickActions(version, () => { reload(); onIssued(); });

  // Fresh state on every open.
  useEffect(() => {
    if (!open) return;
    setWin(null);
    setLoadError(null);
    setBlocks([]);
    setRemoved([]);
    setNote('');
    setNoteOrig('');
    setConflict(null);
    setServerError(null);
    setSubmitting(false);
    setReadyBusy(false);
    setDirty(false);
    setConfirmCloseOpen(false);
    setModalOpen(false);
    setVersion(0);
    setPricing(null);
    setMethod(null);
    setConfirmedAmount(null);
  }, [open]);

  // The price per chip — loaded when the window opens, and again after the
  // server said the sum moved. Without it the section says so and a paid save
  // cannot go; "ללא חיוב" still can.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/chips/reception', { credentials: 'include' })
      .then((res) => (res.ok ? (res.json() as Promise<ReceptionContext>) : null))
      .then((data) => {
        if (!cancelled && data) setPricing({ unit_price: data.unit_price, card_option: data.card_option });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, pricingTick]);

  // What a load puts on the screen. A SOFT load (after an immediate action —
  // the switch, a number fix, "עדכן בכרטיס הדייר") keeps the local edits, the
  // numbers waiting to be saved and the new blocks; chips and quantities
  // refresh. A FRESH load (the window opens, or a save went through) is the
  // order as stored: nothing local survives it, because nothing local is left.
  const applyWindow = useCallback((w: ChipOrderWindow, fresh: boolean) => {
    setWin(w);
    setLoadError(null);
    if (fresh) {
      setNote(w.order.internal_note ?? '');
      setNoteOrig(w.order.internal_note ?? '');
      setRemoved([]);
      setConflict(null);
      setServerError(null);
      setDirty(false);
      setMethod(null);
      setConfirmedAmount(null);
    }
    setBlocks((prev) => {
      const hidden = fresh ? [] : removedRef.current;
      const loaded = w.holders.filter((h) => !h.id || !hidden.includes(h.id)).map((h) => fromHolder(h, 0));
      const out: Block[] = [];
      for (const f of loaded) {
        const old = prev.find((p) => identity(p) === identity({ ...f, key: -1 }));
        if (old && !fresh) out.push({ ...old, id: f.id, source: f.source, qty: f.qty, lease: f.lease, chips: f.chips, existing: f.existing, extras: f.extras });
        else out.push({ ...f, key: old?.key ?? seq.current++ });
      }
      // Staff holders added in this window and not saved yet stay.
      if (!fresh) for (const p of prev) if (!p.id && p.source === 'staff') out.push(p);
      return out;
    });
  }, []);

  // Load (and reload after an immediate action).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const mine = ++loadSeq.current;
    fetchWindow(orderItemId)
      .then((w) => {
        if (cancelled || loadSeq.current !== mine) return;
        applyWindow(w, version === 0 || freshNext.current);
        freshNext.current = false;
      })
      .catch((e: Error) => { if (!cancelled && loadSeq.current === mine) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, [open, orderItemId, version, applyWindow]);

  /** Load the order now and wait for it — after a save. False = it could not
   *  be loaded. */
  async function refreshNow(fresh: boolean): Promise<boolean> {
    if (fresh) freshNext.current = true;
    const mine = ++loadSeq.current;
    try {
      const w = await fetchWindow(orderItemId);
      if (loadSeq.current === mine) {
        applyWindow(w, freshNext.current);
        freshNext.current = false;
      }
      return true;
    } catch {
      // Not armed for later: a load that was never asked to be fresh must not
      // wipe what is typed after this point.
      freshNext.current = false;
      return false;
    }
  }

  const items = win?.items ?? [];
  const aptOf = (itemId: string) => items.find((i) => i.id === itemId)?.apartment_number ?? '';

  // ── Derived ──────────────────────────────────────────────────────────────

  const totalPending = useMemo(() => blocks.reduce((s, b) => s + effectivePending(b).length, 0), [blocks]);
  const noteChanged = note.trim() !== noteOrig.trim();
  // Collected or rejected: nothing of the ORDER can change any more.
  const closed = !!win && !isOpenChipOrder(win.order.status);
  const frozen = submitting || closed;

  function blockInvalid(b: Block): string | null {
    const pending = effectivePending(b);
    const touched = edited(b) || pending.length > 0;
    if (!touched) return null;
    if (b.name.trim().length < 2) return 'נדרש שם מלא';
    if (b.phone.trim() && !validatePhone(b.phone).valid) return validatePhone(b.phone).error ?? 'מספר טלפון לא תקין';
    // A person of a web order always has a phone; at the reception it is optional.
    if (!b.phone.trim() && (b.source === 'order' || b.source === 'legacy')) return 'נדרש טלפון';
    if (b.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim())) return 'כתובת מייל לא תקינה';
    return null;
  }

  const changes = totalPending + blocks.filter(edited).length + removed.length + (noteChanged ? 1 : 0);
  const blocksValid = blocks.every((b) => blockInvalid(b) === null);
  // An immediate action on a chip (the switch, a number fix) is its own
  // request: nothing is saved over it while it is still running.
  const idle = !submitting && quick.busyId === null;

  // ── The extra chips of this save ─────────────────────────────────────────
  // New numbers beyond what an apartment line paid for online — per line, as
  // the server counts them: the line's active chips, then the numbers waiting.
  const extraChips = extraChipsOf(items.map((i) => {
    let linked = 0;
    let added = 0;
    for (const b of blocks) {
      if (b.itemId !== i.id) continue;
      linked += b.chips.filter((c) => c.order_item_id === i.id && quick.view(c).status === 'active').length;
      added += effectivePending(b).length;
    }
    return { ordered: i.chips_count, linked, added };
  }));
  const unitPrice = pricing?.unit_price ?? null;
  const extraAmount = unitPrice === null ? null : receptionAmount(extraChips, unitPrice);
  // "מזומן או העברה" confirms the sum that was on the screen when it was
  // chosen: once the sum is another one, the choice no longer stands.
  const methodNow = receptionMethodInForce({ method, amount: extraAmount, confirmedAmount });
  const payReason = receptionPaymentReason({ newChips: extraChips, method, amount: extraAmount, confirmedAmount, what: 'extra' });

  const canSubmit = !!win && !closed && changes > 0 && blocksValid && idle && canEditOrders && payReason === null;

  // ── "מוכן לאיסוף" in one click ───────────────────────────────────────────
  // The order may be marked ready once EVERY apartment line is covered — the
  // server's own rule (active chips linked to the line ≥ what it ordered),
  // with the numbers still waiting in the window counted too, since the click
  // saves them first. A number the server already refused does not count.
  const assigning = !!win && (win.order.status === 'paid' || win.order.status === 'approved');
  // The refused number counts as refused only while it is still waiting in its
  // block: once it is removed or replaced, the refusal is history and must not
  // hold the button back.
  const refused = conflict && blocks.some((b) => b.key === conflict.blockKey && effectivePending(b).some((p) => p.number === conflict.number))
    ? conflict
    : null;
  const missing = items.reduce((sum, i) => {
    let have = 0;
    for (const b of blocks) {
      if (b.itemId !== i.id) continue;
      have += b.chips.filter((c) => c.order_item_id === i.id && quick.view(c).status === 'active').length;
      have += effectivePending(b).filter((p) => !(refused?.blockKey === b.key && refused.number === p.number)).length;
    }
    return sum + Math.max(0, i.chips_count - have);
  }, 0);
  /** Why "מוכן לאיסוף" cannot be pressed now (shown under the buttons); null = it can. */
  const readyReason = !assigning ? null
    : refused ? 'יש להסיר או להחליף את מספר הצ׳יפ התפוס שמסומן באדום'
    : missing > 0 ? `יש לשייך את כל הצ׳יפים שהוזמנו — ${missingChipsText(missing)}`
    : !blocksValid ? 'יש לתקן את הפרטים המסומנים באדום בבעלי הצ׳יפ'
    : payReason !== null ? payReason
    : null;
  const canReady = assigning && readyReason === null && idle && canEditOrders;

  // ── ESC layering ─────────────────────────────────────────────────────────

  useEscapeKey(open && !confirmCloseOpen && !modalOpen && !quick.edit, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (submitting) return;
    if (dirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }

  // ── Mutators ─────────────────────────────────────────────────────────────

  function patch(key: number, p: Partial<Block>) {
    setDirty(true);
    setServerError(null);
    setBlocks((prev) => prev.map((b) => (b.key === key ? { ...b, ...p } : b)));
  }

  function addHolder() {
    if (!win) return;
    setDirty(true);
    setBlocks((prev) => [...prev, {
      key: seq.current++, id: null, itemId: win.clicked_item_id, source: 'staff', role: 'tenant', name: '', phone: '', email: '',
      qty: 0, lease: { key: null, name: null, end: null }, chips: [], existing: [], extras: [], pending: [], numInput: '', numType: 'physical',
      dupHint: null, phoneTouched: false, orig: null,
    }]);
  }

  function removeHolder(b: Block) {
    setDirty(true);
    setConflict((c) => (c?.blockKey === b.key ? null : c));
    if (b.id) setRemoved((r) => [...r, b.id as string]);
    setBlocks((prev) => prev.filter((x) => x.key !== b.key));
  }

  function numberInWindow(n: string, exceptChipId?: string): boolean {
    return blocks.some((b) => b.pending.some((p) => p.number === n)
      || [...b.chips, ...b.existing, ...b.extras].some((c) => c.id !== exceptChipId && c.chip_number === n));
  }

  function addNumber(b: Block) {
    const v = b.numInput.trim();
    if (!v || b.pending.length >= MAX_PENDING_PER_BLOCK) return;
    if (numberInWindow(v)) {
      patch(b.key, { dupHint: `המספר ${v} כבר נמצא בחלון הזה` });
      return;
    }
    patch(b.key, { pending: [...b.pending, { number: v, chip_type: b.numType }], numInput: '', dupHint: null });
  }

  function removePending(b: Block, n: string) {
    setConflict((c) => (c?.blockKey === b.key && c.number === n ? null : c));
    patch(b.key, { pending: b.pending.filter((p) => p.number !== n) });
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  /** POSTs everything the window changed, in one transaction. Returns how many
   *  chips were issued, or null when nothing was saved — the reason is on the
   *  screen by then (the server's message; a taken number turns red). */
  async function persist(): Promise<number | null> {
    if (!win) return null;
    setServerError(null);
    setConflict(null);
    const sent = blocks.filter((b) => edited(b) || effectivePending(b).length > 0);
    try {
      const res = await fetch(`/api/chip-orders/${win.order.id}/holders`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          holders: sent.map((b) => ({
            id: b.id,
            item_id: b.itemId,
            legacy: b.source === 'legacy',
            role: b.role,
            full_name: b.name.trim(),
            phone: b.phone.trim() || null,
            email: b.email.trim() || null,
            new_chips: effectivePending(b),
          })),
          removed_holder_ids: removed,
          ...(noteChanged ? { note: note.trim() || null } : {}),
          // How the extra chips are settled. The amount is what the window
          // shows; the server computes its own and refuses a save where the
          // two differ.
          ...(extraChips > 0 && methodNow
            ? { extra_payment: { method: methodNow, amount: methodNow === 'cash_transfer' ? extraAmount ?? 0 : 0 } }
            : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        issued?: number; error?: string; chip_number?: string; holder_index?: number | null; code?: string;
        extra?: { chips: number; method: ReceptionPaymentMethod; order: { order_number: number; total: number } | null } | null;
      };
      if (!res.ok) {
        // The server counted the extra chips, or their sum, differently from
        // this window — the price per chip was changed, or a chip of the order
        // was added / disabled elsewhere meanwhile. Nothing was saved: load
        // the price and the order's chips again (the numbers waiting here are
        // kept), and ask for the payment again.
        if (data.code === 'amount_mismatch' || data.code === 'payment_required') {
          setMethod(null);
          setConfirmedAmount(null);
          setPricingTick((t) => t + 1);
          reload();
        }
        if (res.status === 409 && data.chip_number) {
          const b = typeof data.holder_index === 'number' ? sent[data.holder_index] : undefined;
          if (b) {
            const taken = data.chip_number;
            setConflict({ blockKey: b.key, number: taken });
            // A number that was still in the box (typed, never added with
            // "הוסף") becomes a row of its own: the refusal needs something to
            // turn red, and an X to remove it with.
            setBlocks((prev) => prev.map((x) => (
              x.key === b.key && x.numInput.trim() === taken && !x.pending.some((n) => n.number === taken)
                ? { ...x, pending: [...x.pending, { number: taken, chip_type: x.numType }], numInput: '' }
                : x
            )));
          }
        }
        setServerError(data.error ?? 'השמירה נכשלה');
        return null;
      }
      if (data.extra?.order) {
        toast.success(`נרשם תשלום על ${data.extra.chips === 1 ? 'צ׳יפ נוסף אחד' : `${data.extra.chips} צ׳יפים נוספים`} — הזמנת קבלה ${data.extra.order.order_number}`);
      }
      return data.issued ?? 0;
    } catch {
      toast.error('השמירה נכשלה');
      return null;
    }
  }

  /** "שמור שינויים": save, say so, and stay — the window reloads on what is
   *  stored now (24/11/2026; until then a save closed it). If the order cannot
   *  be loaded again the window closes, rather than show saved numbers as if
   *  they were still waiting. */
  async function save() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const n = await persist();
      if (n === null) return;
      toast.success(n > 1 ? `${n} צ׳יפים הונפקו` : n === 1 ? 'הצ׳יפ הונפק' : 'השינויים נשמרו');
      onIssued();
      if (!(await refreshNow(true))) onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }

  /** "מוכן לאיסוף" in one click: save whatever the window holds, THEN mark
   *  the order ready. A save that fails marks nothing — its error is shown as
   *  on any save. The window stays open on the new status, "נאסף" next. */
  async function markReady() {
    if (!win || !canReady) return;
    setSubmitting(true);
    setReadyBusy(true);
    try {
      let issued: number | null = null;
      if (changes > 0) {
        issued = await persist();
        if (issued === null) return;
      }
      let failed: string | null = null;
      try {
        const res = await fetch(`/api/chip-orders/${win.order.id}/ready`, { method: 'POST', credentials: 'include' });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          failed = data.error === 'not_found' ? 'ההזמנה לא נמצאה' : data.error ?? 'הפעולה נכשלה';
        }
      } catch {
        failed = 'הפעולה נכשלה';
      }
      if (failed) {
        toast.error(issued !== null ? `השינויים נשמרו, אבל ההזמנה לא סומנה מוכנה: ${failed}` : failed);
      } else {
        toast.success(
          'סומן מוכן לאיסוף — נשלחה הודעה למזמין',
          issued ? { description: issued === 1 ? 'הצ׳יפ הונפק ונשמר' : `${issued} צ׳יפים הונפקו ונשמרו` } : undefined,
        );
      }
      onIssued();
      // Something was stored (the save, the status or both) → the order as
      // stored; a refusal with nothing saved → a plain reload. If what was
      // stored cannot be loaded, the window closes rather than show an order
      // that is no longer true.
      const stored = issued !== null || !failed;
      const loaded = await refreshNow(stored);
      if (!loaded && stored) onOpenChange(false);
    } finally {
      setSubmitting(false);
      setReadyBusy(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const allChips = blocks.flatMap((b) => [...b.chips, ...b.existing, ...b.extras]);

  return (
    <>
      <IssueSheetFrame
        open={open}
        onRequestClose={requestClose}
        closeDisabled={submitting}
        footer={<IssueSheetFooter onSave={() => void save()} saveDisabled={!canSubmit} saving={submitting} onClose={requestClose} closeDisabled={submitting} />}
      >
        {loadError && <div className="ci-alert" role="alert">{loadError}</div>}
        <Section icon={<UsersIco />} title="בעלי הצ׳יפ" sub="כל בלוק = אדם אחד והצ׳יפים שלו · ניתן להוסיף עוד">
          {!win ? (
            loadError ? null : <div className="ci-skel" />
          ) : (
            <>
              {closed && (
                <p className="ci-info" role="status" data-testid="chip-order-closed-note">
                  <AlertIco size={14} />
                  <span>
                    {win.order.source === 'reception'
                      ? win.order.status === 'rejected'
                        ? 'הזמנת הקבלה בוטלה, והצ׳יפים שלה הושבתו — הפרטים לקריאה בלבד.'
                        : 'הזמנת קבלה: שולמה ונמסרה במקום, ולכן היא סגורה — הפרטים לקריאה בלבד.'
                      : 'ההזמנה סגורה — הפרטים לקריאה בלבד.'}
                    {' '}את הצ׳יפים עצמם אפשר להשבית, להחזיר לפעיל ולתקן מספר. צ׳יפים נוספים מנפיקים ב„הנפק צ׳יפ”.
                  </span>
                </p>
              )}
              {blocks.map((b, bi) => {
                const apt = aptOf(b.itemId);
                const firstName = b.name.trim().split(/\s+/)[0] || null;
                const activeLinked = b.chips.filter((c) => quick.view(c).status === 'active').length;
                // Paid extras count too: they sit on a reception order, and
                // would lose their person with the block.
                const hasChips = b.chips.length > 0 || b.extras.length > 0;
                const paidLine = b.source !== 'staff';
                const invalid = blockInvalid(b);
                const phoneBad = b.phoneTouched && b.phone.trim() && !validatePhone(b.phone).valid;
                const registryRole = b.role === 'owner' || b.role === 'tenant' || b.role === 'operator';
                return (
                  <HolderBlock
                    key={b.key}
                    index={bi}
                    name={b.name}
                    role={b.role}
                    apartment={apt}
                    onRemove={() => removeHolder(b)}
                    removeDisabled={frozen || hasChips || paidLine}
                    removeTitle={paidLine ? 'בעל צ׳יפ מההזמנה ששולמה — לא מסירים' : hasChips ? 'לבעל הצ׳יפ יש צ׳יפים — אי אפשר להסיר' : 'הסרה'}
                  >
                    <RoleSegment options={ROLE_OPTIONS} value={b.role} disabled={frozen}
                      onChange={(v) => patch(b.key, { role: v as ChipResidentRole })} />
                    <div className="ci-mainrow">
                      <div className="ci-fld">
                        <label htmlFor={`oh-name-${b.key}`}>שם מלא</label>
                        <input id={`oh-name-${b.key}`} type="text" value={b.name} disabled={frozen} placeholder="שם מלא"
                          onChange={(e) => patch(b.key, { name: e.target.value })} />
                      </div>
                      <div className="ci-fld">
                        <label htmlFor={`oh-apt-${b.key}`}>דירה</label>
                        <input id={`oh-apt-${b.key}`} type="text" readOnly value={`דירה ${apt}`} className="ci-num ci-ro" />
                      </div>
                      <div className="ci-fld">
                        <span className="ci-lbl">כמות כרטיסים</span>
                        <div className="ci-qtybox ci-num" title={paidLine ? undefined : 'נוסף בחלון — לא חלק מההזמנה ששולמה'}>{paidLine ? b.qty : '—'}</div>
                      </div>
                    </div>
                    <div className="ci-frow">
                      <div className="ci-fld">
                        <label htmlFor={`oh-phone-${b.key}`}>טלפון נייד</label>
                        <input id={`oh-phone-${b.key}`} type="tel" inputMode="tel" value={b.phone} disabled={frozen}
                          className={cn('ci-num ci-ltr', phoneBad && 'ci-bad')}
                          onChange={(e) => patch(b.key, { phone: e.target.value })} onBlur={() => patch(b.key, { phoneTouched: true })} />
                      </div>
                      <div className="ci-fld">
                        <label htmlFor={`oh-email-${b.key}`}>מייל</label>
                        <input id={`oh-email-${b.key}`} type="email" inputMode="email" value={b.email} disabled={frozen}
                          className="ci-num ci-ltr" onChange={(e) => patch(b.key, { email: e.target.value })} />
                      </div>
                    </div>
                    {(b.role === 'tenant' || b.role === 'operator' || b.lease.key) && (
                      <div className="ci-leaserow">
                        <span>
                          {b.lease.key ? (
                            <a href={`/api/files/chip-order-leases/${b.lease.key}`} target="_blank" rel="noopener noreferrer" data-testid="chip-order-lease-link">
                              <ExternalLink className="h-4 w-4" />
                              צפייה בחוזה
                            </a>
                          ) : 'חוזה: לא צורף'}
                        </span>
                        <span>סיום חוזה: <span className="ci-num">{b.lease.end ? DATE_ONLY.format(new Date(`${b.lease.end}T12:00:00Z`)) : '—'}</span></span>
                      </div>
                    )}
                    {!closed && b.source !== 'staff' && (b.role === 'owner' || b.role === 'tenant' || b.role === 'operator') && (
                      <AmberNote>שינוי השם או הטלפון כאן חל על בעל הצ׳יפ בהזמנה ועל הצ׳יפים שלו — מרשם הדיירים לא מתעדכן.</AmberNote>
                    )}
                    {/* Writing to the tenants list is offered only while the order is open (the server's rule). */}
                    {registryRole && !closed && (
                      <HolderRegistryButton
                        itemId={b.itemId}
                        apartmentNumber={apt}
                        role={b.role as ChipOrderRole}
                        name={b.name}
                        phone={b.phone}
                        canWriteContacts={canWriteContacts && canEditOrders}
                        disabled={submitting}
                        onDone={() => { reload(); onIssued(); }}
                        onModalChange={setModalOpen}
                      />
                    )}
                    <ChipAllocation
                      title={`הקצאת צ׳יפים — ${b.name.trim() || 'בעל הצ׳יפ'}`}
                      sub={paidLine ? <>לפי ההזמנה: <span className="ci-num">{b.qty}</span> כרטיסים</> : 'מחוץ לכמות ששולמה'}
                      assigned={activeLinked + b.pending.length}
                      of={paidLine ? b.qty : null}
                      firstName={firstName}
                      numInput={b.numInput}
                      onNumInput={(v) => patch(b.key, { numInput: v, dupHint: null })}
                      numType={b.numType}
                      onNumType={(t) => patch(b.key, { numType: t })}
                      onAdd={() => addNumber(b)}
                      addBlocked={b.pending.length >= MAX_PENDING_PER_BLOCK || !canEditOrders || closed}
                      saved={b.chips}
                      existing={b.existing}
                      extras={b.extras}
                      pending={b.pending}
                      conflictNumber={conflict?.blockKey === b.key ? conflict.number : null}
                      dupHint={b.dupHint}
                      disabled={submitting}
                      quick={quick}
                      onToggle={(chip) => void quick.toggle(chip, submitting)}
                      onCommitNumber={() => void quick.commitNumber(allChips, (n, id) => numberInWindow(n, id), submitting)}
                      onRemovePending={(n) => removePending(b, n)}
                    />
                    {paidLine && activeLinked + b.pending.length > b.qty && (
                      <p className="ci-warn">
                        נוספו יותר צ׳יפים ממה שהוזמן (<span className="ci-num">{activeLinked + b.pending.length}</span> מתוך <span className="ci-num">{b.qty}</span>). אם הדירה כולה עברה את הכמות ששולמה באתר — על הצ׳יפים הנוספים בוחרים אמצעי תשלום, בסעיף „פירוט עסקה והערות”.
                      </p>
                    )}
                    {invalid && <p className="ci-err mt-2">⚠️ {invalid}</p>}
                  </HolderBlock>
                );
              })}
              <button type="button" className="ci-addowner" onClick={addHolder} disabled={frozen || !canEditOrders}>
                <PlusIco size={15} />
                הוסף בעל צ׳יפ
              </button>
            </>
          )}
        </Section>

        {win && (
          <Section icon={<WalletIco />} tone="green" title="פירוט עסקה והערות" sub="פרטי ההזמנה, התשלום והצ׳יפים להנפקה">
            <OrderTransaction
              win={win}
              readyAction={{ can: canReady, busy: readyBusy, reason: readyReason, run: () => void markReady() }}
              canEditOrders={canEditOrders}
              canCancelReception={canCancelReception}
              disabled={submitting}
              onGone={() => { onIssued(); onOpenChange(false); }}
              onModalChange={setModalOpen}
            />
            {/* The extra chips of this save — beyond what was paid online. The
                same payment section as at the reception, for the extras only. */}
            {extraChips > 0 && !closed && (
              <div className="ci-extrapay" data-testid="chip-order-extra-payment">
                <p className="ci-info" role="status">
                  <AlertIco size={14} />
                  <span>
                    {extraChips === 1 ? 'נוסף צ׳יפ אחד' : <>נוספו <span className="ci-num">{extraChips}</span> צ׳יפים</>} מעבר לכמות ששולמה באתר.
                    {' '}ההזמנה מהאתר והסכום שלה לא משתנים — „מזומן או העברה” רושם על הצ׳יפים הנוספים הזמנת קבלה נפרדת, ו„ללא חיוב” לא רושם הזמנה.
                  </span>
                </p>
                <ReceptionPayment
                  newChips={extraChips}
                  unitPrice={unitPrice}
                  method={methodNow}
                  onMethod={(m) => {
                    setDirty(true);
                    setServerError(null);
                    setMethod(m);
                    setConfirmedAmount(m === 'cash_transfer' ? extraAmount : null);
                  }}
                  cardOption={pricing?.card_option ?? false}
                  disabled={submitting || !canEditOrders}
                  reason={payReason}
                  cashOff={win.order.is_test ? 'בהזמנת בדיקה לא נרשם תשלום' : null}
                />
              </div>
            )}
            <div className="ci-fld ci-notefld">
              <label htmlFor="order-note">הערה</label>
              <textarea id="order-note" value={note} disabled={frozen} maxLength={2000} placeholder="הערות פנימיות על ההנפקה..."
                onChange={(e) => { setDirty(true); setNote(e.target.value); }} />
            </div>
          </Section>
        )}

        {serverError && <div className="ci-alert" role="alert">{serverError}</div>}
      </IssueSheetFrame>

      <DiscardDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}
        onDiscard={() => { setConfirmCloseOpen(false); onOpenChange(false); }} />
    </>
  );
}
