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
//   · "פירוט עסקה והערות" — the order (OrderTransaction) + fee + internal note.
//   · "שמור שינויים" — ONE request, one transaction (POST
//     /api/chip-orders/[id]/holders): holder edits, staff holders, new numbers
//     (linked to the order line AND the holder line), the note.

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink } from 'lucide-react';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { validatePhone } from '@/lib/validation';
import { cn } from '@/lib/utils';
import { e164ToLocal } from '@/lib/portal/phone';
import { MAX_CHIPS_PER_GROUP } from '@/lib/chips/issueGroups';
import type { ChipOrderRole, ChipOrderWindow, ChipOrderWindowChip, ChipOrderWindowHolder } from '@/lib/chipOrders/model';
import type { ChipResidentRole, ChipType } from '@/lib/types/chips';
import { HolderRegistryButton } from '../ChipOrderSection';
import {
  AmberNote, ChipAllocation, DiscardDialog, HolderBlock, IssueSheetFrame, IssueSheetFooter, PlusIco, ROLE_SHORT, RoleSegment,
  Section, UsersIco, WalletIco, useChipQuickActions, type PendingChip,
} from './parts';
import { OrderTransaction } from './OrderTransaction';
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
    chips: h.chips, existing: h.existing, pending: [], numInput: '', numType: 'physical', dupHint: null, phoneTouched: false,
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

export function OrderIssueSheet({
  open, onOpenChange, onIssued, canEditOrders = false, canWriteContacts = false, orderItemId,
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
  const [fee, setFee] = useState('');
  const [feeCharged, setFeeCharged] = useState(false);
  const [conflict, setConflict] = useState<{ blockKey: number; number: string } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

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
    setFee('');
    setFeeCharged(false);
    setConflict(null);
    setServerError(null);
    setSubmitting(false);
    setDirty(false);
    setConfirmCloseOpen(false);
    setModalOpen(false);
    setVersion(0);
  }, [open]);

  // Load (and reload after an immediate action) — local edits, pending numbers
  // and new blocks survive a reload; chips and quantities refresh.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/chip-orders/items/${orderItemId}`, { credentials: 'include' });
        if (!res.ok) throw new Error(res.status === 404 ? 'ההזמנה לא נמצאה או כבר נסגרה' : 'טעינת ההזמנה נכשלה');
        const data = (await res.json()) as { window?: ChipOrderWindow };
        if (cancelled || !data.window) return;
        const w = data.window;
        setWin(w);
        setLoadError(null);
        setNoteOrig((prev) => (version === 0 ? w.order.internal_note ?? '' : prev));
        if (version === 0) setNote(w.order.internal_note ?? '');
        setBlocks((prev) => {
          const fresh = w.holders.filter((h) => !h.id || !removedRef.current.includes(h.id)).map((h) => fromHolder(h, 0));
          const out: Block[] = [];
          for (const f of fresh) {
            const old = prev.find((p) => identity(p) === identity({ ...f, key: -1 }));
            if (old) out.push({ ...old, id: f.id, source: f.source, qty: f.qty, lease: f.lease, chips: f.chips, existing: f.existing });
            else out.push({ ...f, key: seq.current++ });
          }
          // Staff holders added in this window and not saved yet stay.
          for (const p of prev) if (!p.id && p.source === 'staff') out.push(p);
          return out;
        });
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [open, orderItemId, version]);

  const items = win?.items ?? [];
  const aptOf = (itemId: string) => items.find((i) => i.id === itemId)?.apartment_number ?? '';

  // ── Derived ──────────────────────────────────────────────────────────────

  const totalPending = useMemo(() => blocks.reduce((s, b) => s + effectivePending(b).length, 0), [blocks]);
  const noteChanged = note.trim() !== noteOrig.trim();
  const feeError = fee.trim() && !(Number.isFinite(Number(fee)) && Number(fee) >= 0) ? 'סכום לא תקין' : null;

  function blockInvalid(b: Block): string | null {
    const pending = effectivePending(b);
    const touched = edited(b) || pending.length > 0;
    if (!touched) return null;
    if (b.name.trim().length < 2) return 'נדרש שם מלא';
    if (b.phone.trim() && !validatePhone(b.phone).valid) return validatePhone(b.phone).error ?? 'מספר טלפון לא תקין';
    if (!b.phone.trim() && b.source !== 'staff') return 'נדרש טלפון';
    if (b.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim())) return 'כתובת מייל לא תקינה';
    return null;
  }

  const changes = totalPending + blocks.filter(edited).length + removed.length + (noteChanged ? 1 : 0);
  const canSubmit =
    !!win && changes > 0 && blocks.every((b) => blockInvalid(b) === null) && !feeError &&
    !submitting && canEditOrders;

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
      qty: 0, lease: { key: null, name: null, end: null }, chips: [], existing: [], pending: [], numInput: '', numType: 'physical',
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
      || [...b.chips, ...b.existing].some((c) => c.id !== exceptChipId && c.chip_number === n));
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

  async function save() {
    if (!canSubmit || !win) return;
    setSubmitting(true);
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
          issuance_fee: fee.trim() ? Number(fee) : null,
          fee_charged: feeCharged,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        issued?: number; error?: string; chip_number?: string; holder_index?: number | null;
      };
      if (!res.ok) {
        if (res.status === 409 && data.chip_number) {
          const b = typeof data.holder_index === 'number' ? sent[data.holder_index] : undefined;
          if (b) setConflict({ blockKey: b.key, number: data.chip_number });
        }
        setServerError(data.error ?? 'השמירה נכשלה');
        return;
      }
      const n = data.issued ?? 0;
      toast.success(n > 1 ? `${n} צ׳יפים הונפקו` : n === 1 ? 'הצ׳יפ הונפק' : 'השינויים נשמרו');
      onIssued();
      onOpenChange(false);
    } catch {
      toast.error('השמירה נכשלה');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const allChips = blocks.flatMap((b) => [...b.chips, ...b.existing]);

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
              {blocks.map((b, bi) => {
                const apt = aptOf(b.itemId);
                const firstName = b.name.trim().split(/\s+/)[0] || null;
                const activeLinked = b.chips.filter((c) => quick.view(c).status === 'active').length;
                const hasChips = b.chips.length > 0;
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
                    removeDisabled={submitting || hasChips || paidLine}
                    removeTitle={paidLine ? 'בעל צ׳יפ מההזמנה ששולמה — לא מסירים' : hasChips ? 'לבעל הצ׳יפ יש צ׳יפים — אי אפשר להסיר' : 'הסרה'}
                  >
                    <RoleSegment options={ROLE_OPTIONS} value={b.role} disabled={submitting}
                      onChange={(v) => patch(b.key, { role: v as ChipResidentRole })} />
                    <div className="ci-mainrow">
                      <div className="ci-fld">
                        <label htmlFor={`oh-name-${b.key}`}>שם מלא</label>
                        <input id={`oh-name-${b.key}`} type="text" value={b.name} disabled={submitting} placeholder="שם מלא"
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
                        <input id={`oh-phone-${b.key}`} type="tel" inputMode="tel" value={b.phone} disabled={submitting}
                          className={cn('ci-num ci-ltr', phoneBad && 'ci-bad')}
                          onChange={(e) => patch(b.key, { phone: e.target.value })} onBlur={() => patch(b.key, { phoneTouched: true })} />
                      </div>
                      <div className="ci-fld">
                        <label htmlFor={`oh-email-${b.key}`}>מייל</label>
                        <input id={`oh-email-${b.key}`} type="email" inputMode="email" value={b.email} disabled={submitting}
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
                    {b.source !== 'staff' && (b.role === 'owner' || b.role === 'tenant' || b.role === 'operator') && (
                      <AmberNote>שינוי השם או הטלפון כאן חל על בעל הצ׳יפ בהזמנה ועל הצ׳יפים שלו — מרשם הדיירים לא מתעדכן.</AmberNote>
                    )}
                    {registryRole && (
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
                      addBlocked={b.pending.length >= MAX_PENDING_PER_BLOCK || !canEditOrders}
                      saved={b.chips}
                      existing={b.existing}
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
                        נוספו יותר צ׳יפים ממה שהוזמן (<span className="ci-num">{activeLinked + b.pending.length}</span> מתוך <span className="ci-num">{b.qty}</span>). אפשר לשמור — הם יקושרו גם הם להזמנה.
                      </p>
                    )}
                    {invalid && <p className="ci-err mt-2">⚠️ {invalid}</p>}
                  </HolderBlock>
                );
              })}
              <button type="button" className="ci-addowner" onClick={addHolder} disabled={submitting || !canEditOrders}>
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
              pending={totalPending}
              canEditOrders={canEditOrders}
              disabled={submitting}
              onChanged={() => { reload(); onIssued(); }}
              onGone={() => { onIssued(); onOpenChange(false); }}
              onModalChange={setModalOpen}
            />
            <div className="ci-feegrid">
              <div className="ci-fld">
                <label htmlFor="order-fee">עמלת הנפקה (₪)</label>
                <input id="order-fee" type="text" inputMode="decimal" dir="ltr" placeholder="0" value={fee} disabled={submitting}
                  className={cn('ci-num ci-ltr', feeError && 'ci-bad')} onChange={(e) => { setDirty(true); setFee(e.target.value); }} />
                {feeError && <span className="ci-err">⚠️ {feeError}</span>}
              </div>
              <label className="ci-chk">
                <input type="checkbox" checked={feeCharged} disabled={submitting} onChange={(e) => { setDirty(true); setFeeCharged(e.target.checked); }} />
                החיוב בוצע
              </label>
            </div>
            <div className="ci-fld ci-notefld">
              <label htmlFor="order-note">הערה</label>
              <textarea id="order-note" value={note} disabled={submitting} maxLength={2000} placeholder="הערות פנימיות על ההנפקה..."
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
