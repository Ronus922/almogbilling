'use client';

// The chip issue window "הנפקת צ׳יפ" — redesigned 20/11/2026 after
// ref/chip-order/chip-issue-admin.html (DESIGN.md "מודול צ׳יפים" (ו), styles
// in app/styles/chip-issue-sheet.css). THIS WINDOW IS THE ONLY PLACE CHIPS ARE
// MANAGED: every chip click in the app (table row, holder panel, tenant tab,
// ?chip= deep link, an Orders-tab row) lands here. Two modes, one window:
//
//   · WITH an order (an Orders-tab row, `initial.orderItemId`) —
//     issue-sheet/OrderIssueSheet.tsx: one block per person of the order,
//     "פירוט עסקה והערות", one save for everything.
//   · WITHOUT an order (below) — the window as it was, in the new look: pick
//     an apartment (async registry combobox, inline create) → one or more
//     holder blocks, each one person (registry role or "אחר" + snapshot
//     name/phone + new numbers of a chosen type) → fee / note → ONE save = ONE
//     server transaction, all-or-nothing: it issues every pending number of
//     every block AND applies holder edits (name / phone / role) to the block's
//     saved chips (diffed against the values the block was seeded with).
//
// Two actions are IMMEDIATE in both modes, never part of the save: the active
// / disabled switch of a saved chip (switching off asks once) and the chip
// number fix (click the number, edit inline, Enter / blur). A pending number's
// X removes a NOT-YET-ISSUED number — saved chips are never deleted.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { AlertTriangle, Check, ChevronsUpDown, Loader2, Plus, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { validatePhone } from '@/lib/validation';
import { cn } from '@/lib/utils';
import { CHIP_RESIDENT_ROLES, UNIT_TYPE_LABEL } from '@/lib/constants/chips';
import { isSnapshotRole, resolveChipHolder } from '@/lib/chips/holder';
import {
  MAX_CHIPS_PER_GROUP, exceedsSoftLimit, holderUpdatesForBlock, type HolderSnapshot,
} from '@/lib/chips/issueGroups';
import type {
  ChipHolderUpdate, ChipResidentRole, ChipType, ChipWithHolder,
  ContactResidentCard, ContactResidents, IssueChipGroup,
} from '@/lib/types/chips';
import {
  AmberNote, BuildingIco, ChipAllocation, DiscardDialog, HolderBlock, IssueSheetFrame, IssueSheetFooter,
  PlusIco, ROLE_SHORT, RoleSegment, Section, UsersIco, WalletIco, useChipQuickActions, type PendingChip,
} from './issue-sheet/parts';
import { OrderIssueSheet } from './issue-sheet/OrderIssueSheet';

// ── Contact search item (GET /api/contacts/search) ─────────────────────────

interface ContactSearchItem {
  id: string;
  apartment_number: string;
  unit_type: string;
  owner_name: string | null;
  tenant_name: string | null;
  resident_type: string;
  needs_review: boolean;
}

// ── Holder blocks ──────────────────────────────────────────────────────────

interface HolderBlockState {
  key: number;
  role: ChipResidentRole | null;
  holderName: string;
  holderPhone: string;
  phoneTouched: boolean;
  numInput: string;
  /** Current type selector value — captured into each number on add. */
  numType: ChipType;
  pending: PendingChip[];
  /** Existing chips of this holder — rows with the immediate switch + number
   *  fix; name/phone/role edits reach them on save. */
  saved: ChipWithHolder[];
  /** The name/phone/role the block was SEEDED with from its saved chips —
   *  the baseline every save diffs against. null for a brand-new block. */
  orig: HolderSnapshot | null;
  dupHint: string | null;
}

function emptyBlock(key: number): HolderBlockState {
  return {
    key, role: null, holderName: '', holderPhone: '', phoneTouched: false,
    numInput: '', numType: 'physical', pending: [], saved: [], orig: null, dupHint: null,
  };
}

/** Holder edits this block would send on save (its saved chips only). */
function blockUpdates(b: HolderBlockState): ChipHolderUpdate[] {
  const phoneRaw = b.holderPhone.trim();
  const phone = phoneRaw ? validatePhone(phoneRaw).normalized || phoneRaw : null;
  return holderUpdatesForBlock(
    b.saved.map((c) => c.id),
    { name: b.holderName.trim() || null, phone, role: b.role },
    b.orig,
  );
}

/** Person identity of a saved chip → grouping key (contact is fixed here). */
function holderKeyOf(chip: ChipWithHolder): string {
  return isSnapshotRole(chip.resident_role)
    ? `${chip.resident_role}:${chip.holder_name ?? ''}`
    : chip.resident_role;
}

function blockIdentityKey(b: HolderBlockState): string | null {
  if (!b.role) return null;
  return isSnapshotRole(b.role) ? `${b.role}:${b.holderName.trim()}` : b.role;
}

/** Effective pending of a block — the add-row remnant counts too (typing one
 *  number and saving without clicking "הוסף" still issues it). */
function effectivePending(b: HolderBlockState): PendingChip[] {
  const remnant = b.numInput.trim();
  if (remnant && !b.pending.some((p) => p.number === remnant)) {
    return [...b.pending, { number: remnant, chip_type: b.numType }];
  }
  return b.pending;
}

const REGISTRY_ROLES: readonly ChipResidentRole[] = ['owner', 'tenant', 'operator'];

export interface IssueChipSheetProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: {
    contactId: string;
    apartmentNumber: string;
    residentRole?: string | null;
    holderName?: string | null;
    holderPhone?: string | null;
    /** Chip orders: opened from an Orders-tab row — that apartment line.
     *  Absent = the window without an order. */
    orderItemId?: string | null;
  } | null;
  onIssued: () => void;
  /** chips_orders_manage:edit — the order's buttons and saving for an order. */
  canEditOrders?: boolean;
  /** contacts:edit — "עדכן בכרטיס הדייר" (the server checks it again). */
  canWriteContacts?: boolean;
}

export function IssueChipSheet(props: IssueChipSheetProps) {
  const orderItemId = props.initial?.orderItemId ?? null;
  return orderItemId
    ? <OrderIssueSheet {...props} orderItemId={orderItemId} />
    : <RegistryIssueSheet {...props} />;
}

// ── The window WITHOUT an order ─────────────────────────────────────────────

function RegistryIssueSheet({ open, onOpenChange, initial, onIssued }: IssueChipSheetProps) {
  // Contact selection
  const [contactId, setContactId] = useState<string | null>(null);
  const [contactLabel, setContactLabel] = useState('');
  const [residents, setResidents] = useState<ContactResidents | null>(null);
  const [residentsLoading, setResidentsLoading] = useState(false);
  const [activeCount, setActiveCount] = useState<number | null>(null);

  // Holder blocks
  const blockSeq = useRef(1);
  const [blocks, setBlocks] = useState<HolderBlockState[]>([emptyBlock(0)]);
  const [chipsVersion, setChipsVersion] = useState(0); // bump → refetch saved chips

  // Global fee / notes / override
  const [fee, setFee] = useState('');
  const [feeCharged, setFeeCharged] = useState(false);
  const [notes, setNotes] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  // 409 marking: the offending pending number turns red
  const [conflict, setConflict] = useState<{ blockKey: number; number: string } | null>(null);

  // Panel plumbing
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);

  // Async apartment picker
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContactSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);

  // Inline "apartment missing — add it" (zero search results → POST /api/contacts)
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const locked = Boolean(initial);

  function afterQuickAction() {
    setChipsVersion((v) => v + 1); // refetch + regroup (pending preserved)
    onIssued(); // parent list/KPIs refresh
  }
  const quick = useChipQuickActions(chipsVersion, afterQuickAction);

  // Fresh state on every open (initial read via ref so a new object identity
  // from the parent's render can't wipe user input mid-session).
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    if (!open) return;
    const init = initialRef.current;
    setContactId(init?.contactId ?? null);
    setContactLabel(init?.apartmentNumber ?? '');
    setResidents(null);
    setActiveCount(null);
    blockSeq.current = 1;
    setBlocks([emptyBlock(0)]);
    setChipsVersion(0);
    setFee('');
    setFeeCharged(false);
    setNotes('');
    setOverrideReason('');
    setConflict(null);
    setServerError(null);
    setSubmitting(false);
    setDirty(false);
    setConfirmCloseOpen(false);
    setPickerOpen(false);
    setQuery('');
    setResults([]);
    setSearching(false);
    setCreating(false);
    setCreateError(null);
  }, [open]);

  // Residents + the apartment's chips — chips regroup into holder blocks,
  // PRESERVING local pending/inputs by holder identity across refetches.
  useEffect(() => {
    if (!open || !contactId) {
      setResidents(null);
      setActiveCount(null);
      return;
    }
    let cancelled = false;
    setResidentsLoading(true);
    (async () => {
      try {
        const [rRes, cRes] = await Promise.all([
          fetch(`/api/contacts/${contactId}/residents`, { credentials: 'include' }),
          fetch(`/api/contacts/${contactId}/chips`, { credentials: 'include' }),
        ]);
        if (rRes.ok) {
          const data = (await rRes.json()) as ContactResidents;
          if (!cancelled) setResidents(data);
        }
        if (cRes.ok) {
          const data = (await cRes.json()) as { items?: ChipWithHolder[]; active_count?: number };
          if (cancelled) return;
          setActiveCount(typeof data.active_count === 'number' ? data.active_count : 0);
          const items = Array.isArray(data.items) ? data.items : [];

          // Group saved chips by holder identity, then merge into current blocks.
          const grouped = new Map<string, ChipWithHolder[]>();
          for (const chip of items) {
            const k = holderKeyOf(chip);
            grouped.set(k, [...(grouped.get(k) ?? []), chip]);
          }

          setBlocks((prev) => {
            const next: HolderBlockState[] = [];
            const used = new Set<string>();
            // 1. Existing blocks keep their position + local edits (and their
            //    edit baseline); saved refreshes. A user-made block that just
            //    gained saved chips adopts its current values as the baseline.
            for (const b of prev) {
              const idKey = blockIdentityKey(b);
              const saved = idKey ? grouped.get(idKey) ?? [] : [];
              if (idKey) used.add(idKey);
              const orig =
                b.orig ?? (saved.length > 0
                  ? { name: b.holderName.trim() || null, phone: b.holderPhone.trim() || null, role: b.role }
                  : null);
              next.push({ ...b, saved, orig });
            }
            // 2. Holders with chips but no block yet → new blocks seeded from
            //    the chips' OWN snapshot (what an edit actually changes and
            //    what a save diffs against), falling back to the live registry
            //    value only when the snapshot is empty.
            for (const [k, saved] of grouped) {
              if (used.has(k)) continue;
              const first = saved[0];
              const holder = resolveChipHolder(first);
              const name = first.holder_name?.trim() || (holder.name === '—' ? '' : holder.name);
              const phone = first.holder_phone?.trim() || holder.phone || '';
              next.push({
                ...emptyBlock(blockSeq.current++),
                role: first.resident_role,
                holderName: name,
                holderPhone: phone,
                saved,
                orig: { name: name || null, phone: phone || null, role: first.resident_role },
              });
            }
            // 3. Drop empty placeholder blocks if real ones arrived; always ≥1.
            const cleaned = next.filter(
              (b) => b.role !== null || b.pending.length > 0 || b.saved.length > 0 || b.numInput.trim() !== '',
            );
            const result = cleaned.length > 0 ? cleaned : [emptyBlock(blockSeq.current++)];

            // 4. Reissue prefill: ensure a block exists for the initial holder.
            const init = initialRef.current;
            if (init?.residentRole) {
              const role = init.residentRole as ChipResidentRole;
              if ((CHIP_RESIDENT_ROLES as readonly string[]).includes(role)) {
                const wantKey = isSnapshotRole(role) ? `${role}:${(init.holderName ?? '').trim()}` : role;
                if (!result.some((b) => blockIdentityKey(b) === wantKey)) {
                  result.push({
                    ...emptyBlock(blockSeq.current++),
                    role,
                    holderName: init.holderName ?? '',
                    holderPhone: init.holderPhone ?? '',
                  });
                }
              }
            }
            return result;
          });
        }
      } catch {
        // Panel stays usable without the resident cards / limit meter.
      } finally {
        if (!cancelled) setResidentsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, chipsVersion]);

  // Debounced registry search (250ms, min 1 char).
  useEffect(() => {
    if (!pickerOpen) return;
    const term = query.trim();
    if (term.length < 1) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(term)}`, { credentials: 'include' });
          if (!res.ok) throw new Error('search_failed');
          const data = (await res.json()) as { items?: ContactSearchItem[] };
          if (searchSeq.current === seq) setResults(data.items ?? []);
        } catch {
          if (searchSeq.current === seq) setResults([]);
        } finally {
          if (searchSeq.current === seq) setSearching(false);
        }
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [query, pickerOpen]);

  // ── Derived validation ───────────────────────────────────────────────────

  const totalPending = useMemo(() => blocks.reduce((s, b) => s + effectivePending(b).length, 0), [blocks]);
  /** Saved chips whose holder snapshot changed in this window (all blocks). */
  const totalUpdates = useMemo(() => blocks.reduce((s, b) => s + blockUpdates(b).length, 0), [blocks]);

  /** Registry roles already used by OTHER blocks → "נבחר בבלוק אחר". */
  const takenRoles = useMemo(() => {
    const map = new Map<ChipResidentRole, number>(); // role -> blockKey
    for (const b of blocks) {
      if (b.role && REGISTRY_ROLES.includes(b.role)) map.set(b.role, b.key);
    }
    return map;
  }, [blocks]);

  const phoneErrorOf = (b: HolderBlockState): string | null => {
    if (!b.holderPhone.trim()) return null;
    const v = validatePhone(b.holderPhone);
    return v.valid ? null : v.error ?? 'מספר טלפון לא תקין';
  };

  const feeError = useMemo(() => {
    if (!fee.trim()) return null;
    const n = Number(fee);
    return Number.isFinite(n) && n >= 0 ? null : 'סכום לא תקין';
  }, [fee]);

  // Soft limit: existing actives + ALL pending numbers across ALL blocks.
  const overLimit = activeCount != null && exceedsSoftLimit(activeCount, Math.max(totalPending, 1));

  /** Per-block validity — only blocks that issue or edit something matter. */
  const blockInvalid = (b: HolderBlockState): string | null => {
    const pending = effectivePending(b);
    if (pending.length === 0 && blockUpdates(b).length === 0) return null; // nothing to save here
    if (!b.role) return 'בחר תפקיד לבעל הצ׳יפ';
    if (isSnapshotRole(b.role) && !b.holderName.trim()) return 'לבעל צ׳יפ מסוג "אחר" נדרש שם מלא';
    if (phoneErrorOf(b)) return phoneErrorOf(b);
    if (b.pending.length > MAX_CHIPS_PER_GROUP) return `עד ${MAX_CHIPS_PER_GROUP} מספרים חדשים לבלוק`;
    return null;
  };

  const canSubmit =
    !!contactId &&
    (totalPending >= 1 || totalUpdates >= 1) &&
    blocks.every((b) => blockInvalid(b) === null) &&
    !feeError &&
    (!overLimit || overrideReason.trim() !== '') &&
    !submitting;

  // ── ESC layering (LIFO: confirm > number edit > picker > panel) ──────────

  useEscapeKey(open && !confirmCloseOpen && !pickerOpen && !quick.edit, () => requestClose());
  useEscapeKey(open && pickerOpen && !confirmCloseOpen, () => setPickerOpen(false));
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (submitting) return;
    if (dirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }

  // ── Block mutators (every user edit marks the panel dirty) ───────────────

  function patchBlock(key: number, patch: Partial<HolderBlockState>) {
    setDirty(true);
    setServerError(null);
    setBlocks((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }

  function addBlock() {
    setDirty(true);
    setBlocks((prev) => [...prev, emptyBlock(blockSeq.current++)]);
  }

  /** Remove a block — only while it has NO saved chips. If it was the last
   *  one, a fresh empty block takes its place (the window keeps ≥1). */
  function removeBlock(key: number) {
    setDirty(true);
    setConflict((c) => (c?.blockKey === key ? null : c));
    setBlocks((prev) => {
      const next = prev.filter((b) => b.key !== key);
      return next.length > 0 ? next : [emptyBlock(blockSeq.current++)];
    });
  }

  function selectRole(block: HolderBlockState, value: string, cards: ContactResidentCard[]) {
    if (value === 'other') {
      patchBlock(block.key, { role: 'other', holderName: '', holderPhone: '', phoneTouched: false });
      return;
    }
    const card = cards.find((c) => c.role === value);
    if (!card) return;
    patchBlock(block.key, { role: card.role, holderName: card.name ?? '', holderPhone: card.phone ?? '', phoneTouched: false });
  }

  /** All numbers already present in the window (pending + saved, all blocks). */
  function numberExistsInWindow(num: string, exceptChipId?: string): boolean {
    return blocks.some(
      (b) => b.pending.some((p) => p.number === num) || b.saved.some((c) => c.id !== exceptChipId && c.chip_number === num),
    );
  }

  /** Add the typed number as a pending row, capturing the current type. */
  function addNumber(block: HolderBlockState) {
    const v = block.numInput.trim();
    if (!v) return;
    if (block.pending.length >= MAX_CHIPS_PER_GROUP) return;
    if (numberExistsInWindow(v)) {
      patchBlock(block.key, { dupHint: `המספר ${v} כבר נמצא בחלון הזה` });
      return;
    }
    patchBlock(block.key, { pending: [...block.pending, { number: v, chip_type: block.numType }], numInput: '', dupHint: null });
  }

  /** Remove a PENDING (not-yet-issued) number — a typo fix, not a deletion. */
  function removePending(block: HolderBlockState, num: string) {
    setConflict((c) => (c?.blockKey === block.key && c.number === num ? null : c));
    patchBlock(block.key, { pending: block.pending.filter((p) => p.number !== num) });
  }

  /**
   * Inline registry create — the search returned nothing, so POST /api/contacts
   * with the minimal body { apartment_number: <typed query> } and select the
   * created row exactly like a search pick. 409 means the apartment DOES exist
   * (normalized key collision) — re-run the search and select the found row.
   */
  async function createApartmentFromQuery() {
    const term = query.trim();
    if (!term || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ apartment_number: term }),
      });
      const data = (await res.json().catch(() => ({}))) as { contact?: { id: string; apartment_number: string }; error?: string };
      if (res.status === 409) {
        const norm = term.replace(/\D/g, '').replace(/^0+/, '') || '0';
        const sRes = await fetch(`/api/contacts/search?q=${encodeURIComponent(norm)}`, { credentials: 'include' });
        const sData = (await sRes.json().catch(() => ({}))) as { items?: ContactSearchItem[] };
        const items = sData.items ?? [];
        if (items.length > 0) selectContact(items[0].id, items[0].apartment_number);
        else setCreateError('הדירה כבר קיימת במרשם — חפש ובחר אותה');
        return;
      }
      if (res.status === 403) {
        setCreateError('אין לך הרשאה להוסיף דירות למרשם');
        return;
      }
      if (!res.ok || !data.contact) {
        setCreateError(data.error ?? 'הוספת הדירה נכשלה');
        return;
      }
      selectContact(data.contact.id, data.contact.apartment_number);
    } catch {
      setCreateError('הוספת הדירה נכשלה');
    } finally {
      setCreating(false);
    }
  }

  function selectContact(id: string, apartmentNumber: string) {
    setDirty(true);
    setContactId(id);
    setContactLabel(apartmentNumber);
    blockSeq.current = 1;
    setBlocks([emptyBlock(0)]);
    setConflict(null);
    setServerError(null);
    setPickerOpen(false);
    setQuery('');
    setResults([]);
    setCreateError(null);
  }

  // ── Submit — ALL pending numbers from ALL blocks, one transaction ────────

  async function handleSubmit() {
    if (!canSubmit || !contactId) return;
    setSubmitting(true);
    setServerError(null);
    setConflict(null);
    try {
      // Split each block's pending by captured type → per-type groups (the API
      // is chip_type-per-group); keep the mapping so a 409's group_index lands
      // back on the right block + number.
      const groups: IssueChipGroup[] = [];
      const groupToBlock: number[] = [];
      for (const b of blocks) {
        const pending = effectivePending(b);
        if (pending.length === 0 || !b.role) continue;
        for (const type of ['physical', 'app'] as const) {
          const numbers = pending.filter((p) => p.chip_type === type).map((p) => p.number);
          if (numbers.length === 0) continue;
          groups.push({
            resident_role: b.role,
            holder_name: b.holderName.trim() || null,
            holder_phone: b.holderPhone.trim() ? validatePhone(b.holderPhone).normalized : null,
            chip_type: type,
            numbers,
          });
          groupToBlock.push(b.key);
        }
      }
      // Holder edits of already-saved chips ride in the SAME request.
      const updates = blocks.flatMap(blockUpdates);

      const res = await fetch('/api/chips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          contact_id: contactId,
          groups,
          updates,
          issuance_fee: fee.trim() ? Number(fee) : null,
          fee_charged: feeCharged,
          notes: notes.trim() || null,
          limit_override_reason: overLimit ? overrideReason.trim() : null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        items?: unknown[]; error?: string; chip_number?: string; group_index?: number | null;
      };
      if (!res.ok) {
        const msg = data.error ?? 'הנפקת הצ׳יפ נכשלה';
        if (res.status === 409 && data.chip_number != null) {
          // Nothing was saved (all-or-nothing) — mark the offending number red.
          const blockKey = typeof data.group_index === 'number' ? groupToBlock[data.group_index] ?? null : null;
          if (blockKey != null) setConflict({ blockKey, number: data.chip_number });
          setServerError(msg);
        } else if (res.status === 400 || res.status === 422) {
          setServerError(msg);
        } else {
          toast.error(msg);
        }
        return;
      }
      const count = Array.isArray(data.items) ? data.items.length : 0;
      toast.success(count > 1 ? `${count} צ׳יפים הונפקו` : count === 1 ? 'הצ׳יפ הונפק' : 'השינויים נשמרו');
      onIssued();
      onOpenChange(false);
    } catch {
      toast.error('הנפקת הצ׳יפ נכשלה');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const residentCards = residents?.residents ?? [];
  const residentType = residents?.resident_type ?? null;
  const disabledAll = !contactId || submitting;
  const allSaved = blocks.flatMap((b) => b.saved);

  return (
    <>
      <IssueSheetFrame
        open={open}
        onRequestClose={requestClose}
        closeDisabled={submitting}
        footer={
          <IssueSheetFooter onSave={() => void handleSubmit()} saveDisabled={!canSubmit} saving={submitting}
            onClose={requestClose} closeDisabled={submitting} />
        }
      >
        {/* Apartment / unit — the window without an order picks it */}
        <Section icon={<BuildingIco />} title="דירה / יחידה">
          <div className="ci-fld">
            <span className="ci-lbl">בחירת דירה <span className="ci-req">*</span></span>
            {locked ? (
              <div className="ci-aptbtn ci-locked">
                <BuildingIco />
                <span>דירה <span className="ci-num">{contactLabel}</span></span>
              </div>
            ) : (
              <Popover
                open={pickerOpen}
                onOpenChange={(o) => {
                  if (submitting) return;
                  setPickerOpen(o);
                  if (!o) { setQuery(''); setCreateError(null); }
                }}
              >
                <PopoverTrigger id="chip-contact" disabled={submitting} className="ci-aptbtn">
                  <BuildingIco />
                  <span className={cn('truncate', !contactId && 'text-[#b4bacb]')}>
                    {contactId ? <>דירה <span className="ci-num">{contactLabel}</span></> : 'בחר דירה או יחידה…'}
                  </span>
                  <ChevronsUpDown className="ci-chev h-4 w-4" />
                </PopoverTrigger>
                <PopoverContent align="start" sideOffset={6} className="w-(--anchor-width) min-w-72 p-0">
                  <div dir="rtl" className="chips-skin flex flex-col">
                    <div className="flex items-center gap-2 border-b border-[var(--chip-border)] px-3">
                      {searching
                        ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--chip-ink-soft)]" />
                        : <Search className="h-4 w-4 shrink-0 text-[var(--chip-ink-soft)]" />}
                      <input
                        autoFocus
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setCreateError(null); }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && results.length > 0) {
                            e.preventDefault();
                            selectContact(results[0].id, results[0].apartment_number);
                          }
                        }}
                        placeholder="מספר דירה או שם דייר…"
                        className="h-11 w-full bg-transparent text-sm text-[var(--chip-ink)] outline-none placeholder:text-[var(--chip-ink-ghost)]"
                      />
                    </div>
                    <div className="max-h-64 overflow-y-auto p-1">
                      {query.trim().length < 1 ? (
                        <p className="px-3 py-6 text-center text-sm text-[var(--chip-ink-soft)]">הקלד מספר דירה או שם דייר לחיפוש</p>
                      ) : results.length === 0 ? (
                        searching ? (
                          <p className="px-3 py-6 text-center text-sm text-[var(--chip-ink-soft)]">מחפש…</p>
                        ) : (
                          <div className="space-y-1">
                            <p className="px-3 pb-1 pt-4 text-center text-sm text-[var(--chip-ink-soft)]">לא נמצאו תוצאות</p>
                            <button
                              type="button"
                              onClick={() => void createApartmentFromQuery()}
                              disabled={creating}
                              className="flex min-h-11 w-full items-center gap-2 rounded-[9px] px-3 py-2 text-start text-sm font-bold text-[var(--chip-brand)] transition-colors hover:bg-[var(--chip-brand-soft)] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {creating ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Plus className="h-4 w-4 shrink-0" />}
                              <span className="min-w-0 flex-1">
                                דירה <span className="chip-num">{query.trim()}</span> לא קיימת במרשם — הוסף אותה
                              </span>
                            </button>
                            {createError && (
                              <div className="rounded-md border border-red-400 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{createError}</div>
                            )}
                          </div>
                        )
                      ) : (
                        results.map((item) => {
                          const isSel = item.id === contactId;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => selectContact(item.id, item.apartment_number)}
                              className={cn(
                                'flex min-h-11 w-full items-center gap-2 rounded-[9px] px-2 py-2 text-start text-sm transition-colors',
                                isSel ? 'bg-[var(--chip-brand-soft)] text-[var(--chip-brand-ink)]' : 'text-[var(--chip-ink-muted)] hover:bg-[var(--chip-hover)]',
                              )}
                            >
                              <Check className={cn('h-4 w-4 shrink-0', isSel ? 'text-[var(--chip-brand)] opacity-100' : 'opacity-0')} />
                              <span className="chip-num font-bold text-[var(--chip-ink)]">{item.apartment_number}</span>
                              <span className="min-w-0 flex-1 truncate">{item.owner_name || item.tenant_name || '—'}</span>
                              {item.unit_type !== 'apartment' && (
                                <span className="inline-flex shrink-0 items-center rounded-[6px] bg-[var(--chip-hover)] px-2 py-0.5 text-[11px] font-bold text-[var(--chip-ink-muted)]">
                                  {UNIT_TYPE_LABEL[item.unit_type] ?? item.unit_type}
                                </span>
                              )}
                              {item.needs_review && (
                                <span className="inline-flex shrink-0 items-center rounded-[6px] bg-[var(--chip-amber-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--chip-amber-ink)]">לבדיקה</span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </Section>

        {/* בעלי הצ׳יפ — one block per person */}
        <Section icon={<UsersIco />} title="בעלי הצ׳יפ" sub="כל בלוק = אדם אחד והצ׳יפים שלו · ניתן להוסיף עוד">
          {!contactId ? (
            <div className="ci-chipempty">בחר דירה כדי להוסיף בעלי צ׳יפ</div>
          ) : residentsLoading && blocks.every((b) => b.saved.length === 0 && b.role === null) ? (
            <div className="ci-skel" />
          ) : (
            <>
              {blocks.map((block, bi) => {
                const hasSaved = block.saved.length > 0;
                const takenBy = (role: ChipResidentRole) => {
                  const by = takenRoles.get(role);
                  return by !== undefined && by !== block.key;
                };
                const missing = residentCards.filter((c) => !c.exists);
                const takenHints = residentCards.filter((c) => takenBy(c.role));
                const firstName = block.holderName.trim().split(/\s+/)[0] || null;
                const phoneError = block.phoneTouched ? phoneErrorOf(block) : null;
                const invalid = blockInvalid(block);
                return (
                  <HolderBlock
                    key={block.key}
                    index={bi}
                    name={block.holderName}
                    role={block.role}
                    apartment={contactLabel}
                    onRemove={() => removeBlock(block.key)}
                    removeDisabled={submitting || hasSaved}
                    removeTitle={hasSaved ? 'לבעל הצ׳יפ יש צ׳יפים — אי אפשר להסיר' : 'הסרה'}
                  >
                    <RoleSegment
                      options={[
                        ...residentCards.map((card) => ({
                          value: card.role,
                          label: ROLE_SHORT[card.role],
                          disabled: takenBy(card.role) || !card.exists,
                          title: takenBy(card.role) ? 'נבחר בבלוק אחר' : !card.exists ? 'לא הוזנו פרטים במרשם' : undefined,
                        })),
                        { value: 'other', label: 'אחר', title: 'הזנה חופשית של שם וטלפון' },
                      ]}
                      value={block.role}
                      onChange={(v) => selectRole(block, v, residentCards)}
                      disabled={submitting}
                    />
                    {((block.role && residentType === block.role) || missing.length > 0 || takenHints.length > 0) && (
                      <div className="ci-hint">
                        {block.role && residentType === block.role && <span>גר בדירה</span>}
                        {takenHints.map((c) => <span key={c.role}>{ROLE_SHORT[c.role]} — נבחר בבלוק אחר</span>)}
                        {missing.length > 0 && (
                          <span>
                            {missing.map((c) => ROLE_SHORT[c.role]).join(' / ')} — לא הוזנו פרטים · <Link href="/contacts">השלם פרטים ›</Link>
                          </span>
                        )}
                      </div>
                    )}
                    <div className="ci-frow">
                      <div className="ci-fld">
                        <label htmlFor={`holder-name-${block.key}`}>שם מלא</label>
                        <input id={`holder-name-${block.key}`} type="text" value={block.holderName} disabled={submitting} placeholder="שם מלא"
                          onChange={(e) => patchBlock(block.key, { holderName: e.target.value })} />
                      </div>
                      <div className="ci-fld">
                        <label htmlFor={`holder-phone-${block.key}`}>טלפון נייד</label>
                        <input id={`holder-phone-${block.key}`} type="tel" inputMode="tel" autoComplete="tel" value={block.holderPhone}
                          disabled={submitting} placeholder="052-1234567" className={cn('ci-num ci-ltr', phoneError && 'ci-bad')}
                          onChange={(e) => patchBlock(block.key, { holderPhone: e.target.value })}
                          onBlur={() => patchBlock(block.key, { phoneTouched: true })} />
                        {phoneError && <span className="ci-err">⚠️ {phoneError}</span>}
                      </div>
                    </div>
                    {block.role && !isSnapshotRole(block.role) && (
                      <AmberNote>שינוי השם או הטלפון כאן חל על הצ׳יפים של הבלוק הזה בלבד — מרשם הדיירים לא מתעדכן.</AmberNote>
                    )}
                    <ChipAllocation
                      title={`הקצאת צ׳יפים — ${block.holderName.trim() || 'בעל הצ׳יפ'}`}
                      sub={`עד ${MAX_CHIPS_PER_GROUP} חדשים בשמירה`}
                      assigned={block.saved.filter((c) => quick.view(c).status === 'active').length + block.pending.length}
                      of={null}
                      firstName={firstName}
                      numInput={block.numInput}
                      onNumInput={(v) => patchBlock(block.key, { numInput: v, dupHint: null })}
                      numType={block.numType}
                      onNumType={(t) => patchBlock(block.key, { numType: t })}
                      onAdd={() => addNumber(block)}
                      addBlocked={block.pending.length >= MAX_CHIPS_PER_GROUP}
                      saved={block.saved}
                      pending={block.pending}
                      conflictNumber={conflict?.blockKey === block.key ? conflict.number : null}
                      dupHint={block.dupHint}
                      disabled={submitting}
                      quick={quick}
                      onToggle={(chip) => void quick.toggle(chip, submitting)}
                      onCommitNumber={() => void quick.commitNumber(allSaved, (n, id) => numberExistsInWindow(n, id), submitting)}
                      onRemovePending={(n) => removePending(block, n)}
                    />
                    {invalid && <p className="ci-err mt-2">⚠️ {invalid}</p>}
                  </HolderBlock>
                );
              })}
              <button type="button" className="ci-addowner" onClick={addBlock} disabled={disabledAll}>
                <PlusIco />
                הוסף בעל צ׳יפ
              </button>
            </>
          )}
        </Section>

        {/* Window-global soft-limit warning + required override reason */}
        {overLimit && (
          <div className="ci-over">
            <p>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>סך הצ׳יפים הפעילים בדירה ({activeCount} קיימים + {Math.max(totalPending, 1)} חדשים בכל הבלוקים) חורג מהמגבלה של 4 צ׳יפים לדירה.</span>
            </p>
            <div className="ci-fld">
              <label htmlFor="chip-override">סיבת חריגה <span className="ci-req">*</span></label>
              <textarea id="chip-override" value={overrideReason} disabled={submitting} placeholder="לדוגמה: משפחה מורחבת, עובד סיעודי…"
                onChange={(e) => { setDirty(true); setOverrideReason(e.target.value); }} />
            </div>
          </div>
        )}

        {/* No order: the transaction details are hidden; fee + note stay */}
        <Section icon={<WalletIco />} tone="green" title="עמלה והערות" sub="חל על כל הצ׳יפים החדשים בשמירה הזו">
          <div className="ci-feegrid">
            <div className="ci-fld">
              <label htmlFor="chip-fee">עמלת הנפקה (₪)</label>
              <input id="chip-fee" type="text" inputMode="decimal" dir="ltr" placeholder="0" value={fee} disabled={disabledAll}
                className={cn('ci-num ci-ltr', feeError && 'ci-bad')} onChange={(e) => { setDirty(true); setFee(e.target.value); }} />
              {feeError && <span className="ci-err">⚠️ {feeError}</span>}
            </div>
            <label className="ci-chk">
              <input type="checkbox" checked={feeCharged} disabled={disabledAll} onChange={(e) => { setDirty(true); setFeeCharged(e.target.checked); }} />
              החיוב בוצע
            </label>
          </div>
          <div className="ci-fld mt-[14px]">
            <label htmlFor="chip-notes">הערה</label>
            <textarea id="chip-notes" value={notes} disabled={disabledAll} placeholder="הערות פנימיות על ההנפקה…"
              onChange={(e) => { setDirty(true); setNotes(e.target.value); }} />
          </div>
        </Section>

        {serverError && <div className="ci-alert" role="alert">{serverError}</div>}
      </IssueSheetFrame>

      <DiscardDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}
        onDiscard={() => { setConfirmCloseOpen(false); onOpenChange(false); }} />
    </>
  );
}
