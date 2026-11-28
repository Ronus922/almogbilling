'use client';

// Decision 3.1 (Ronen, 27/11/2026) — the issue window WITHOUT an order (the
// reception's) shows the apartment's OPEN web orders: one read-only line each,
// "הזמנה מהאתר N — פתח", which opens that order's own window (where its chips
// are assigned). Until then the window never showed a web order, and an order
// paid on the site could be missed at the desk. The line carries the orderer's
// note (read only) and the guard note — which whoever issues the chips may
// write here too (POST /api/chip-orders/[id]/guard-note; the order window
// saves the same note).

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { CHIP_NOTE_MAX, GUARD_NOTE_LABEL, ORDERER_NOTE_LABEL } from '@/lib/chipOrders/notes';
import { CHIP_ORDER_TEST_LABEL } from '@/lib/chipOrders/model';
import type { ReceptionWebOrder } from '@/lib/chipOrders/reception';
import { ChipNoteBlock } from '../ChipOrderNotes';

const STAGE = (o: ReceptionWebOrder) =>
  o.status === 'ready' ? 'מוכן לאיסוף' : `שויכו ${o.chips_linked} מתוך ${o.chips_count} צ׳יפים`;

function GuardNoteEditor({ order, onSaved }: { order: ReceptionWebOrder; onSaved: (note: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(order.guard_note ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/chip-orders/${order.order_id}/guard-note`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guard_note: value.trim() || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; guard_note?: string | null; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'שמירת ההערה לשומר נכשלה');
      toast.success('ההערה לשומר נשמרה');
      onSaved(data.guard_note ?? null);
      setEditing(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button type="button" className="ci-linkbtn" onClick={() => { setValue(order.guard_note ?? ''); setEditing(true); }}
        data-testid="reception-web-order-guard-note-edit">
        {order.guard_note ? `ערוך ${GUARD_NOTE_LABEL}` : `הוסף ${GUARD_NOTE_LABEL}`}
      </button>
    );
  }
  return (
    <div className="ci-fld ci-notefld">
      <label htmlFor={`guard-note-${order.order_id}`}>
        {GUARD_NOTE_LABEL} <span className="ci-lblnote">— מוצגת לשומר במסך „מסירת צ׳יפים”</span>
      </label>
      <textarea id={`guard-note-${order.order_id}`} value={value} rows={3} maxLength={CHIP_NOTE_MAX} disabled={busy}
        onChange={(e) => setValue(e.target.value)} data-testid="reception-web-order-guard-note" />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ci-btn ci-primary" disabled={busy} onClick={() => void save()} data-testid="reception-web-order-guard-note-save">
          {busy && <Loader2 className="ci-spin h-4 w-4" />}
          שמור הערה לשומר
        </button>
        <button type="button" className="ci-btn ci-line" disabled={busy} onClick={() => setEditing(false)}>ביטול</button>
      </div>
    </div>
  );
}

export function ReceptionWebOrders({
  orders, canEditNote, openBlocked, onOpen,
}: {
  orders: ReceptionWebOrder[];
  /** chips_orders_manage:edit — the guard note may be written here. */
  canEditNote: boolean;
  /** The window holds unsaved changes: "פתח" would drop them — it waits. */
  openBlocked: boolean;
  onOpen: (itemId: string) => void;
}) {
  // What this window saved since it loaded (the line shows it at once).
  const [saved, setSaved] = useState<Record<string, string | null>>({});
  if (orders.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5" data-testid="reception-web-orders">
      {orders.map((raw) => {
        const o = raw.order_id in saved ? { ...raw, guard_note: saved[raw.order_id] ?? null } : raw;
        return (
          <div key={o.order_id} className="ci-weborder" data-testid="reception-web-order">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-bold text-[var(--ci-ink)]">
                הזמנה מהאתר <span className="ci-num">{o.order_number}</span>
              </span>
              {o.is_test && <span className="ci-tag-mini">{CHIP_ORDER_TEST_LABEL}</span>}
              <span className="text-[12.5px] font-semibold text-[var(--ci-muted)]">{STAGE(o)}</span>
              <button
                type="button"
                className="ci-btn ci-line ms-auto"
                disabled={openBlocked}
                title={openBlocked ? 'יש שינויים שלא נשמרו — שמרו אותם או סגרו את החלון לפני פתיחת ההזמנה' : undefined}
                onClick={() => onOpen(o.item_id)}
                data-testid="reception-web-order-open"
              >
                פתח
              </button>
            </div>
            {o.orderer_note && <ChipNoteBlock label={ORDERER_NOTE_LABEL} text={o.orderer_note} testId="reception-web-order-orderer-note" />}
            {o.guard_note && <ChipNoteBlock label={GUARD_NOTE_LABEL} text={o.guard_note} testId="reception-web-order-guard-note-text" />}
            {canEditNote && <GuardNoteEditor order={o} onSaved={(note) => setSaved((m) => ({ ...m, [o.order_id]: note }))} />}
          </div>
        );
      })}
    </div>
  );
}
