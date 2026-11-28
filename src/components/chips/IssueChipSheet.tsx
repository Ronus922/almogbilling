'use client';

// The chip issue window "הנפקת צ׳יפ" — v2 design of 24/11/2026 after
// ref/chip-order/chip-issue-admin-v2.html (DESIGN.md "מודול צ׳יפים" (ו), styles
// in app/styles/chip-issue-sheet.css). THIS WINDOW IS THE ONLY PLACE CHIPS ARE
// MANAGED: every chip click in the app (table row, holder panel, tenant tab,
// ?chip= deep link, an Orders-tab row) lands here. Two modes, one window:
//
//   · WITH an order (an Orders-tab row, `initial.orderItemId`) —
//     issue-sheet/OrderIssueSheet.tsx: one block per person of the order,
//     "פירוט עסקה והערות", one save for everything.
//   · WITHOUT an order (below) — issuing a chip at the reception: pick an
//     apartment (async registry combobox, inline create) → one or more holder
//     blocks, each one person (registry role or "אורח" — the stored role
//     `other` — + snapshot name / phone / email, a renter's lease and its end
//     date, + new numbers of a chosen type) → who ordered → how the new chips
//     are paid + a note → ONE save = ONE server transaction, all-or-nothing:
//     it issues every pending number of every block AND applies holder edits
//     (name / phone / role / email / lease) to the block's saved chips (diffed
//     against the values the block was seeded with).
//
//     25/11/2026 (Ronen): the window collects what the public order form
//     collects, and none of it is required of the manager. "עמלת הנפקה (₪)"
//     and "החיוב בוצע" are gone (both modes); in their place the payment of
//     the NEW chips of the save — the amount read only (chips × the price of
//     /settings) and a method with no default: "אשראי" (not active yet —
//     disabled, drawn for admin and super admin only), "מזומן או העברה" (the
//     save makes a chip order, source 'reception', already paid and collected)
//     or "ללא חיוב" (no order; the details are kept and shown again on the
//     block). Editing saved chips alone asks for no payment.
//     26/11/2026: "מזומן או העברה" is two options, "מזומן" and "העברה
//     בנקאית" — each the confirmation of the sum on the screen, stored as its
//     own method (an order recorded before keeps "מזומן או העברה"). "אשראי"
//     (admins only) is a real card payment through PayPlus Hosted Fields
//     (issue-sheet/receptionCard.tsx): the card is charged first, then the
//     save puts the chips on the paid order; its sandbox test mode ends at the
//     payment and never issues chips.
//
// Two actions are IMMEDIATE in both modes, never part of the save: the active
// / disabled switch of a saved chip (switching off asks once) and the chip
// number fix (click the number, edit inline, Enter / blur). A pending number's
// X removes a NOT-YET-ISSUED number — saved chips are never deleted.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Check, ChevronsUpDown, Loader2, Plus, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { validatePhone } from '@/lib/validation';
import { cn } from '@/lib/utils';
import { CHIP_RESIDENT_ROLES, UNIT_TYPE_LABEL } from '@/lib/constants/chips';
import { chipHolderDetails, isSnapshotRole, resolveChipHolder } from '@/lib/chips/holder';
import { leaseFileProblem } from '@/lib/chipOrders/lease';
import { formatIlsAfter } from '@/lib/chipOrders/model';
import {
  EMPTY_ORDERER_FIELDS, RECEPTION_CONFIRMED_METHODS, RECEPTION_PAYMENT_LABEL, STORED_PAYMENT_LABEL, looksLikeEmail, ordererProblems,
  receptionAmount, receptionMethodInForce, receptionPaymentReason, receptionRecordsOf, type OrdererFields, type ReceptionContext,
  type ReceptionPaymentMethod,
} from '@/lib/chipOrders/reception';
import {
  MAX_CHIPS_PER_GROUP, holderUpdatesForBlock, type HolderSnapshot,
} from '@/lib/chips/issueGroups';
import type {
  ChipHolderUpdate, ChipLeaseRef, ChipResidentRole, ChipType, ChipWithHolder,
  ContactResidentCard, ContactResidents, IssueChipGroup,
} from '@/lib/types/chips';
import {
  AmberNote, BuildingIco, ChipAllocation, DiscardDialog, HolderBlock, IssueSheetFrame, IssueSheetFooter,
  PlusIco, ROLE_SHORT, RoleSegment, Section, UsersIco, WalletIco, useChipQuickActions, type PendingChip,
} from './issue-sheet/parts';
import { OrderIssueSheet } from './issue-sheet/OrderIssueSheet';
import { LeaseField, OrdererForm, ReceptionPayment, ReceptionRecords, UserIco } from './issue-sheet/reception';
import { ReceptionWebOrders } from './issue-sheet/webOrders';
import { ReceptionCardPanel, receptionCardReason, type ReceptionCardState } from './issue-sheet/receptionCard';

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
  /** 25/11/2026 — the holder's email; a renter's lease (already in Storage —
   *  the save writes its reference on the chips) and its end date
   *  (YYYY-MM-DD, '' = none). All optional. */
  email: string;
  lease: ChipLeaseRef | null;
  leaseEnd: string;
  leaseBusy: boolean;
  leaseError: string | null;
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
    email: '', lease: null, leaseEnd: '', leaseBusy: false, leaseError: null,
    numInput: '', numType: 'physical', pending: [], saved: [], orig: null, dupHint: null,
  };
}

/** The block's email as it is stored (trimmed, lower case), or null. */
const blockEmail = (b: Pick<HolderBlockState, 'email'>): string | null => b.email.trim().toLowerCase() || null;

/** The email, the lease and its end date as a block's saved chips hold them. */
function detailsOf(saved: ChipWithHolder[]): Pick<HolderBlockState, 'email' | 'lease' | 'leaseEnd'> {
  const d = chipHolderDetails(saved);
  return { email: d.email ?? '', lease: d.lease, leaseEnd: d.leaseEnd ?? '' };
}

/** Holder edits this block would send on save (its saved chips only). */
function blockUpdates(b: HolderBlockState): ChipHolderUpdate[] {
  const phoneRaw = b.holderPhone.trim();
  const phone = phoneRaw ? validatePhone(phoneRaw).normalized || phoneRaw : null;
  return holderUpdatesForBlock(
    b.saved.map((c) => c.id),
    { name: b.holderName.trim() || null, phone, role: b.role, email: blockEmail(b), lease: b.lease, leaseEnd: b.leaseEnd || null },
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
  /** Admin / super admin — in an order's window: "בטל הזמנת קבלה", "זיכוי"
   *  and "הפק חשבונית שוב" (each route checks the role again). */
  canAdminOrders?: boolean;
  /** Super admin — "סגירה ידנית" of a stuck "ביטול וזיכוי" in an order's
   *  window (27/11/2026; the route checks the role again). */
  canCloseByHand?: boolean;
}

export function IssueChipSheet(props: IssueChipSheetProps) {
  // Decision 3.1 (27/11/2026): "פתח" on a web order of the window without an
  // order switches this window to that order's — kept for the window that
  // asked (its `initial`), dropped when the window closes.
  const [opened, setOpened] = useState<{ itemId: string; initial: IssueChipSheetProps['initial'] } | null>(null);
  const fromReception = opened && props.open && opened.initial === props.initial ? opened.itemId : null;
  const orderItemId = props.initial?.orderItemId ?? fromReception;
  if (orderItemId) {
    return (
      <OrderIssueSheet
        {...props}
        orderItemId={orderItemId}
        onOpenChange={(v) => { if (!v) setOpened(null); props.onOpenChange(v); }}
      />
    );
  }
  return <RegistryIssueSheet {...props} onOpenOrder={(itemId) => setOpened({ itemId, initial: props.initial })} />;
}

// ── The window WITHOUT an order ─────────────────────────────────────────────

function RegistryIssueSheet({
  open, onOpenChange, initial, onIssued, canAdminOrders = false, canEditOrders = false, onOpenOrder,
}: IssueChipSheetProps & { onOpenOrder?: (itemId: string) => void }) {
  // Contact selection
  const [contactId, setContactId] = useState<string | null>(null);
  const [contactLabel, setContactLabel] = useState('');
  const [residents, setResidents] = useState<ContactResidents | null>(null);
  const [residentsLoading, setResidentsLoading] = useState(false);

  // Holder blocks
  const blockSeq = useRef(1);
  const [blocks, setBlocks] = useState<HolderBlockState[]>([emptyBlock(0)]);
  const [chipsVersion, setChipsVersion] = useState(0); // bump → refetch saved chips

  // Who ordered (25/11/2026). Name and phone follow the first chip holder of
  // this save until the manager types in them.
  const [orderer, setOrderer] = useState<OrdererFields>(EMPTY_ORDERER_FIELDS);
  const [ordererOwn, setOrdererOwn] = useState({ name: false, phone: false });
  // How the NEW chips of this save are paid — nothing is chosen by default.
  // "מזומן" / "העברה בנקאית" confirm a SUM: the one on the screen when it was chosen.
  const [method, setMethod] = useState<ReceptionPaymentMethod | null>(null);
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null);
  // "אשראי" (26/11/2026): the reception order the window's card payment pays,
  // and whether the server saw it paid (receptionCard.tsx).
  const [card, setCard] = useState<ReceptionCardState | null>(null);
  // Closing after a REAL card payment that was not saved asks first — and so
  // does closing while a card charge is in flight or not confirmed yet.
  const [cardCloseOpen, setCardCloseOpen] = useState(false);
  // A card charge in flight or not confirmed yet (the panel's 'paying' /
  // 'verifying' / 'unverified'): until it settles the window holds still, as
  // after a payment — no other method, no other apartment.
  const [cardCharging, setCardCharging] = useState(false);
  // The card panel the window listens to. Another apartment, another method or
  // a reopening starts a new one, and what an earlier panel still reports (a
  // late "paid", the end of its charge) is dropped.
  const cardSessionRef = useRef(0);
  const [cardSession, setCardSession] = useState(0);
  // The window as it is now: an apartment switch or a reopening starts block
  // keys over, so whatever was still on its way to the window before that (a
  // lease upload) no longer has a block to land on.
  const sessionRef = useRef(0);
  // The price per chip, what the viewer may see, the apartment's earlier saves.
  const [reception, setReception] = useState<ReceptionContext | null>(null);
  const [notes, setNotes] = useState('');

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
    blockSeq.current = 1;
    setBlocks([emptyBlock(0)]);
    setChipsVersion(0);
    setOrderer(EMPTY_ORDERER_FIELDS);
    setOrdererOwn({ name: false, phone: false });
    setMethod(null);
    setConfirmedAmount(null);
    setCard(null);
    setCardCharging(false);
    cardSessionRef.current += 1;
    setCardSession(cardSessionRef.current);
    setCardCloseOpen(false);
    setReception(null);
    sessionRef.current += 1;
    setNotes('');
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
      setReception(null);
      return;
    }
    let cancelled = false;
    setResidentsLoading(true);
    (async () => {
      try {
        const [rRes, cRes, xRes] = await Promise.all([
          fetch(`/api/contacts/${contactId}/residents`, { credentials: 'include' }),
          fetch(`/api/contacts/${contactId}/chips`, { credentials: 'include' }),
          fetch(`/api/chips/reception?contact_id=${contactId}`, { credentials: 'include' }),
        ]);
        if (rRes.ok) {
          const data = (await rRes.json()) as ContactResidents;
          if (!cancelled) setResidents(data);
        }
        // The price per chip and the apartment's earlier reception saves. If it
        // cannot be loaded the window still works: no amount is shown, and only
        // "ללא חיוב" can be chosen.
        if (xRes.ok) {
          const data = (await xRes.json()) as ReceptionContext;
          if (!cancelled) setReception({ ...data, records: Array.isArray(data.records) ? data.records : [] });
        }
        if (cRes.ok) {
          const data = (await cRes.json()) as { items?: ChipWithHolder[] };
          if (cancelled) return;
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
                  ? {
                      name: b.holderName.trim() || null, phone: b.holderPhone.trim() || null, role: b.role,
                      email: blockEmail(b), lease: b.lease, leaseEnd: b.leaseEnd || null,
                    }
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
              const details = detailsOf(saved);
              next.push({
                ...emptyBlock(blockSeq.current++),
                role: first.resident_role,
                holderName: name,
                holderPhone: phone,
                ...details,
                saved,
                orig: {
                  name: name || null, phone: phone || null, role: first.resident_role,
                  email: details.email || null, lease: details.lease, leaseEnd: details.leaseEnd || null,
                },
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
        // Panel stays usable without the resident cards.
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

  // The orderer defaults to the first chip holder of THIS save — the first
  // block that gets a new number, else the first block — until the manager
  // types a name / a phone of their own.
  const firstHolder = blocks.find((b) => effectivePending(b).length > 0) ?? blocks[0];
  const ordererShown: OrdererFields = {
    ...orderer,
    name: ordererOwn.name ? orderer.name : firstHolder?.holderName ?? '',
    phone: ordererOwn.phone ? orderer.phone : firstHolder?.holderPhone ?? '',
  };
  const ordererBad = ordererProblems(ordererShown, (p) => {
    const v = validatePhone(p);
    return v.valid ? null : v.error ?? 'מספר טלפון לא תקין';
  });

  // The amount of this save: NEW chips × the price per chip of /settings. The
  // server computes it again and refuses a save whose amount moved.
  const unitPrice = reception?.unit_price ?? null;
  const amount = unitPrice === null ? null : receptionAmount(totalPending, unitPrice);
  // The choice that still stands: a chip added or removed after "מזומן" or
  // "העברה בנקאית" was chosen changes the sum, and the old confirmation is
  // not a confirmation of the new one.
  // "אשראי" stands once the server saw THIS window's card paid (not a test),
  // for exactly the new chips it paid for; its sum is the one the card paid.
  const cardPaidReal = card?.paid === true && !card.test;
  const methodNow = method === 'card'
    ? (receptionCardReason(card, totalPending) === null && totalPending > 0 ? 'card' : null)
    : receptionMethodInForce({ method, amount, confirmedAmount });
  const payReason = method === 'card'
    ? receptionCardReason(card, totalPending) ?? receptionPaymentReason({ newChips: totalPending, method, amount: card?.amount ?? amount, confirmedAmount: card?.amount ?? null })
    : receptionPaymentReason({ newChips: totalPending, method, amount, confirmedAmount });
  const leaseBusy = blocks.some((b) => b.leaseBusy);

  /** Per-block validity — only blocks that issue or edit something matter. */
  const blockInvalid = (b: HolderBlockState): string | null => {
    const pending = effectivePending(b);
    if (pending.length === 0 && blockUpdates(b).length === 0) return null; // nothing to save here
    if (!b.role) return 'בחר תפקיד לבעל הצ׳יפ';
    if (isSnapshotRole(b.role) && !b.holderName.trim()) return `לבעל צ׳יפ מסוג "${ROLE_SHORT[b.role] ?? b.role}" נדרש שם מלא`;
    if (phoneErrorOf(b)) return phoneErrorOf(b);
    if (b.email.trim() && !looksLikeEmail(b.email)) return 'כתובת מייל לא תקינה';
    if (b.pending.length > MAX_CHIPS_PER_GROUP) return `עד ${MAX_CHIPS_PER_GROUP} מספרים חדשים לבלוק בשמירה אחת`;
    return null;
  };

  const canSubmit =
    !!contactId &&
    (totalPending >= 1 || totalUpdates >= 1) &&
    blocks.every((b) => blockInvalid(b) === null) &&
    // New chips need a payment method, and what was typed about the orderer
    // must be storable; edits of saved chips alone need neither.
    payReason === null &&
    (totalPending === 0 || Object.keys(ordererBad).length === 0) &&
    !leaseBusy &&
    // A card charge in flight or unconfirmed: settle it first (the save would
    // close the window past the card warning).
    !cardCharging &&
    !submitting;

  // ── ESC layering (LIFO: confirm > number edit > picker > panel) ──────────

  useEscapeKey(open && !confirmCloseOpen && !cardCloseOpen && !pickerOpen && !quick.edit, () => requestClose());
  useEscapeKey(open && pickerOpen && !confirmCloseOpen, () => setPickerOpen(false));
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (submitting) return;
    // A real charge whose chips were not saved — or a charge still in flight /
    // not confirmed: said plainly, before anything else.
    if (cardPaidReal || cardCharging) setCardCloseOpen(true);
    else if (dirty) setConfirmCloseOpen(true);
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

  /** The lease of a renter block: checked here as the server checks it, sent
   *  to Storage at once, and kept on the block as a reference — the save
   *  writes it on the holder's chips. */
  async function uploadLease(key: number, file: File) {
    const problem = leaseFileProblem({ name: file.name, size: file.size, type: file.type });
    if (problem) {
      patchBlock(key, { leaseError: problem });
      return;
    }
    // The file belongs to THIS apartment's block. If the apartment is switched
    // (or the window reopened) while it is on its way, block keys start over —
    // and a lease must never land on another apartment's block of the same key.
    const session = sessionRef.current;
    patchBlock(key, { leaseBusy: true, leaseError: null });
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/chips/leases', { method: 'POST', credentials: 'include', body });
      const data = (await res.json().catch(() => ({}))) as { lease?: ChipLeaseRef; error?: string };
      if (sessionRef.current !== session) return;
      if (!res.ok || !data.lease) throw new Error(data.error ?? 'העלאת החוזה נכשלה');
      patchBlock(key, { lease: data.lease, leaseBusy: false, leaseError: null });
    } catch (e) {
      if (sessionRef.current !== session) return;
      patchBlock(key, { leaseBusy: false, leaseError: (e as Error).message || 'העלאת החוזה נכשלה' });
    }
  }

  function changeOrderer(field: keyof OrdererFields, value: string) {
    setDirty(true);
    setServerError(null);
    setOrderer((o) => ({ ...o, [field]: value }));
    if (field === 'name' || field === 'phone') setOrdererOwn((own) => ({ ...own, [field]: true }));
  }

  /** The reception saves this block's chips came from (shown again, read only). */
  const recordsOf = (b: HolderBlockState) => receptionRecordsOf(b.saved, reception?.records ?? []);

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
    // A card charge in flight or not confirmed holds the apartment (the picker is disabled too).
    if (cardCharging) return;
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
    // Another apartment is another save: who orders and how it is paid start over.
    setOrderer(EMPTY_ORDERER_FIELDS);
    setOrdererOwn({ name: false, phone: false });
    setMethod(null);
    setConfirmedAmount(null);
    setCard(null);
    setCardCharging(false);
    cardSessionRef.current += 1;
    setCardSession(cardSessionRef.current);
    setReception(null);
    sessionRef.current += 1;
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
            holder_email: blockEmail(b),
            lease: b.lease,
            lease_end_date: b.leaseEnd || null,
            // A block with cards AND app chips is two groups of ONE person.
            block: b.key,
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
          notes: notes.trim() || null,
          // Who ordered and how it is paid — only a save of NEW chips carries them.
          ...(totalPending > 0
            ? {
                orderer: {
                  name: ordererShown.name.trim() || null,
                  phone: ordererShown.phone.trim() || null,
                  email: ordererShown.email.trim() || null,
                  street: ordererShown.street.trim() || null,
                  city: ordererShown.city.trim() || null,
                  zip: ordererShown.zip.trim() || null,
                },
                // The amount is what the window SHOWED; the server computes its own.
                // "אשראי": the sum the CARD paid and the order it paid — the
                // server checks both against what PayPlus confirmed.
                payment: methodNow === 'card' && card
                  ? { method: 'card', amount: card.amount, card_token: card.token }
                  : methodNow
                    ? { method: methodNow, amount: RECEPTION_CONFIRMED_METHODS.includes(methodNow) ? amount ?? 0 : 0 }
                    : null,
              }
            : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        items?: unknown[]; error?: string; code?: string; chip_number?: string; group_index?: number | null;
        order?: { order_number: number; total: number; method?: string | null } | null; record?: { id: string } | null;
      };
      if (!res.ok) {
        const msg = data.error ?? 'הנפקת הצ׳יפ נכשלה';
        if (res.status === 409 && data.chip_number != null) {
          // Nothing was saved (all-or-nothing) — mark the offending number red.
          const blockKey = typeof data.group_index === 'number' ? groupToBlock[data.group_index] ?? null : null;
          if (blockKey != null) setConflict({ blockKey, number: data.chip_number });
          setServerError(msg);
        } else if (res.status === 409 && data.code === 'amount_mismatch') {
          // The price per chip moved while the window was open. Nothing was
          // saved: the new sum is loaded, and the payment is asked again.
          setMethod(null);
          setConfirmedAmount(null);
          setChipsVersion((v) => v + 1);
          setServerError(msg);
        } else if (data.code === 'card_not_paid' || data.code === 'card_amount_mismatch' || data.code === 'test_card_payment') {
          // The card payment and the save disagree — said where the save is.
          setServerError(msg);
        } else if (res.status === 400 || res.status === 422) {
          setServerError(msg);
        } else {
          toast.error(msg);
        }
        return;
      }
      const count = Array.isArray(data.items) ? data.items.length : 0;
      // How the payment was recorded — the server's word for it (`order.method`),
      // else the method the window sent.
      const paidBy = data.order?.method ? STORED_PAYMENT_LABEL[data.order.method] : methodNow ? RECEPTION_PAYMENT_LABEL[methodNow] : null;
      toast.success(
        count > 1 ? `${count} צ׳יפים הונפקו` : count === 1 ? 'הצ׳יפ הונפק' : 'השינויים נשמרו',
        data.order
          ? { description: `נרשם תשלום ${formatIlsAfter(data.order.total)}${paidBy ? ` — ${paidBy}` : ''} · הזמנה ${data.order.order_number}` }
          : data.record ? { description: RECEPTION_PAYMENT_LABEL.none } : undefined,
      );
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
                <PopoverTrigger id="chip-contact" disabled={submitting || cardPaidReal || cardCharging} className="ci-aptbtn">
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
          {/* Decision 3.1: the apartment's open web orders, read only — "פתח" opens the order's window. */}
          {contactId && onOpenOrder && (reception?.web_orders?.length ?? 0) > 0 && (
            <ReceptionWebOrders
              orders={reception?.web_orders ?? []}
              canEditNote={canEditOrders}
              // What "פתח" would drop: chip numbers typed in, a note, or a card
              // charge under way (choosing the apartment itself loses nothing).
              openBlocked={submitting || totalPending > 0 || notes.trim() !== '' || cardCharging || cardPaidReal}
              onOpen={onOpenOrder}
            />
          )}
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
                const emailBad = block.email.trim() !== '' && !looksLikeEmail(block.email);
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
                        { value: 'other', label: ROLE_SHORT.other, title: 'הזנה חופשית של שם וטלפון' },
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
                    <div className="ci-ordrow ci-inblock">
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
                      <div className="ci-fld">
                        <label htmlFor={`holder-email-${block.key}`}>מייל</label>
                        <input id={`holder-email-${block.key}`} type="email" inputMode="email" autoComplete="off" value={block.email}
                          disabled={submitting} className={cn('ci-num ci-ltr', emailBad && 'ci-bad')}
                          onChange={(e) => patchBlock(block.key, { email: e.target.value })} />
                      </div>
                    </div>
                    {/* A renter (or an operator, on a management agreement): the lease and its end date. */}
                    {(block.role === 'tenant' || block.role === 'operator' || block.lease) && (
                      <LeaseField
                        idBase={`holder-${block.key}`}
                        lease={block.lease}
                        leaseEnd={block.leaseEnd}
                        busy={block.leaseBusy}
                        error={block.leaseError}
                        canView={reception?.lease_view ?? false}
                        disabled={submitting}
                        onPick={(file) => void uploadLease(block.key, file)}
                        onRemove={() => patchBlock(block.key, { lease: null, leaseError: null })}
                        onLeaseEnd={(v) => patchBlock(block.key, { leaseEnd: v })}
                      />
                    )}
                    {block.role && !isSnapshotRole(block.role) && (
                      <AmberNote>שינוי השם או הטלפון כאן חל על הצ׳יפים של הבלוק הזה בלבד — מרשם הדיירים לא מתעדכן.</AmberNote>
                    )}
                    <ChipAllocation
                      title={`הקצאת צ׳יפים — ${block.holderName.trim() || 'בעל הצ׳יפ'}`}
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
                    {/* "ביטול וזיכוי" on a paid reception order's line (27/11/2026) —
                        admin and super admin; afterwards the chips and the line load again. */}
                    <ReceptionRecords
                      records={recordsOf(block)}
                      canCancel={canAdminOrders}
                      onChanged={() => { setChipsVersion((v) => v + 1); onIssued(); }}
                    />
                    {invalid && <p className="ci-err mt-2">⚠️ {invalid}</p>}
                  </HolderBlock>
                );
              })}
              <button type="button" className="ci-addowner" onClick={addBlock} disabled={disabledAll}>
                <PlusIco size={15} />
                הוסף בעל צ׳יפ
              </button>
            </>
          )}
        </Section>

        {/* Who ordered — every field optional; kept with the NEW chips of the save */}
        <Section icon={<UserIco />} title="פרטי המזמין" sub="לא חובה · נשמרים עם הצ׳יפים החדשים שבשמירה הזו">
          <OrdererForm value={ordererShown} problems={ordererBad} disabled={disabledAll} onChange={changeOrderer} />
        </Section>

        {/* No order: the payment of the new chips (in place of the old fee fields) + the note */}
        <Section icon={<WalletIco />} tone="green" title="תשלום והערות" sub="חל על כל הצ׳יפים החדשים בשמירה הזו">
          <ReceptionPayment
            newChips={totalPending}
            unitPrice={unitPrice}
            // "אשראי" stays chosen while its payment is under way (methodNow
            // turns to it only once the server saw it paid).
            method={method === 'card' ? 'card' : methodNow}
            onMethod={(m) => {
              // A card payment that went through fixes the method (and a test
              // payment is cancelled from its own panel first) — and so does a
              // charge still in flight or not confirmed.
              if (card?.paid || cardCharging) return;
              setDirty(true);
              setServerError(null);
              setMethod(m);
              // A card session of another choice is left unpaid (its order is
              // purged with the unpaid ones); what its panel still reports is dropped.
              if (m !== 'card') {
                setCard(null);
                cardSessionRef.current += 1;
                setCardSession(cardSessionRef.current);
              }
              // What the manager confirms by choosing cash or a transfer: the sum on the screen now.
              setConfirmedAmount(RECEPTION_CONFIRMED_METHODS.includes(m) ? amount : null);
            }}
            cardOption={reception?.card_option ?? false}
            cardLive={reception?.card_live ?? false}
            cardTest={reception?.card_test ?? false}
            lockedTo={card?.paid || cardCharging ? 'card' : null}
            cardPanel={method === 'card' && contactId && (reception?.card_live || reception?.card_test) ? (
              <ReceptionCardPanel
                contactId={contactId}
                newChips={totalPending}
                amount={amount}
                role={firstHolder?.role ?? 'other'}
                orderer={ordererShown}
                live={reception.card_live}
                testAvailable={reception.card_test}
                disabled={disabledAll}
                card={card}
                // Only the window's current panel is heard (`cardSession`).
                onCard={(c) => {
                  if (cardSession !== cardSessionRef.current) return;
                  setCard(c);
                  if (c?.paid) setServerError(null);
                }}
                onCharging={(on) => { if (cardSession === cardSessionRef.current) setCardCharging(on); }}
              />
            ) : null}
            disabled={disabledAll}
            reason={payReason}
          />
          <div className="ci-fld ci-notefld">
            <label htmlFor="chip-notes">הערה</label>
            <textarea id="chip-notes" value={notes} disabled={disabledAll} maxLength={2000} placeholder="הערות פנימיות על ההנפקה…"
              onChange={(e) => { setDirty(true); setNotes(e.target.value); }} />
          </div>
        </Section>

        {serverError && <div className="ci-alert" role="alert">{serverError}</div>}
      </IssueSheetFrame>

      <DiscardDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}
        onDiscard={() => { setConfirmCloseOpen(false); onOpenChange(false); }} />

      {/* Closing after a REAL card payment whose chips were not saved — or
          while a card charge is in flight / not confirmed. */}
      <AlertDialog open={cardCloseOpen} onOpenChange={setCardCloseOpen}>
        <AlertDialogContent dir="rtl" className="p-6" data-testid="chip-reception-card-close">
          <AlertDialogHeader>
            <AlertDialogTitle>{cardPaidReal ? 'לסגור בלי לשמור את הצ׳יפים?' : 'לסגור לפני שהחיוב באשראי אושר?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {cardPaidReal
                ? 'התשלום בוצע אך הצ׳יפים לא נשמרו — ההזמנה נשארת בטבלת ההזמנות; משם אפשר לבטל ולזכות.'
                : 'החיוב נשלח ועדיין לא התקבל עליו אישור. אם יאושר, ההזמנה תופיע בטבלת ההזמנות בלי צ׳יפים — משם אפשר לבטל ולזכות.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11 px-4">חזרה לחלון</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => { setCardCloseOpen(false); onOpenChange(false); }}
              className="h-11 bg-destructive px-4 text-white hover:bg-destructive/90"
            >
              סגור בלי לשמור
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
