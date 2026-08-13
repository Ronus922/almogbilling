'use client';

// Multi-person issue window — chips-skin (declared exception). The five
// multi-holder elements (stacked holder block, separator, "+ הוסף בעל צ׳יפ",
// taken role, pending tag) derive from ref/proof/Chip2.html; the visual
// language (palette/typography/sizes) stays Chip.md. Instruction overrides
// (approved): role picker stays the rich 2×2 cards (not Chip2's compact row),
// footer keeps primary-at-start, block-remove is hidden once a block holds
// SAVED chips, and the type mini-selector says "פיזי" (system vocabulary).
//
// Flow: pick an apartment (async registry combobox, inline create) → one or
// more HOLDER BLOCKS, each = one person (2×2 role cards + snapshot name/phone
// + per-number type capture + tags) → global fee/notes → one save issues ALL
// pending tags from all blocks in ONE transaction, all-or-nothing. Existing
// chips load grouped into blocks as read-only tags; their toggle goes through
// the Deactivate/Reactivate dialogs IMMEDIATELY (never silently, never on
// save). A pending tag's X removes a NOT-YET-ISSUED number — saved chips have
// no removal path anywhere (product law).

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle, Building2, Check, ChevronsUpDown, CreditCard, Info,
  Loader2, Plus, Power, RotateCcw, Search, Smartphone, Users, Wallet, X,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { DeactivateChipDialog } from './DeactivateChipDialog';
import { ReactivateChipDialog } from './ReactivateChipDialog';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { validatePhone } from '@/lib/validation';
import { cn } from '@/lib/utils';
import {
  CHIP_RESIDENT_ROLES, CHIP_TYPE_LABEL, RESIDENT_ROLE_LABEL, UNIT_TYPE_LABEL,
} from '@/lib/constants/chips';
import { isSnapshotRole, resolveChipHolder } from '@/lib/chips/holder';
import { MAX_CHIPS_PER_GROUP, exceedsSoftLimit } from '@/lib/chips/issueGroups';
import type {
  ChipResidentRole, ChipType, ChipWithHolder, ContactResidentCard,
  ContactResidents, IssueChipGroup,
} from '@/lib/types/chips';

// ── Ref field tokens (Chip.md: input 44px, radius 11, border 1.5, focus ring) ─

const INPUT_CLS =
  'h-11 rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel)] px-[14px] text-[14.5px] text-[var(--chip-ink)] ' +
  'placeholder:text-[var(--chip-ink-soft)] ' +
  'focus-visible:border-[var(--chip-brand)] focus-visible:ring-4 focus-visible:ring-[rgba(61,90,254,0.12)]';

const LABEL_CLS = 'flex items-center gap-1 text-[13px] font-bold text-[var(--chip-ink-muted)]';

// ── Section card (ref: white card, radius 16, head + divider, icon tile) ────

type SectionTone = 'blue' | 'violet' | 'amber' | 'green';

const SECTION_TONE: Record<SectionTone, string> = {
  blue: 'bg-[var(--chip-brand-soft)] text-[var(--chip-brand)]',
  violet: 'bg-[var(--chip-violet-soft)] text-[var(--chip-violet)]',
  amber: 'bg-[var(--chip-amber-soft)] text-[var(--chip-amber)]',
  green: 'bg-[var(--chip-green-soft)] text-[var(--chip-green)]',
};

function ChipSection({
  title, sub, icon: Icon, iconTone = 'blue', children,
}: {
  title: string;
  sub?: string;
  icon: LucideIcon;
  iconTone?: SectionTone;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[16px] border border-[var(--chip-border)] bg-[var(--chip-panel)]">
      <div className="flex items-center gap-[11px] border-b border-[var(--chip-border)] px-5 pb-[13px] pt-[15px]">
        <span
          className={cn(
            'grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px]',
            SECTION_TONE[iconTone],
          )}
        >
          <Icon className="h-[19px] w-[19px]" strokeWidth={1.9} />
        </span>
        <div className="flex-1 text-start">
          <h2 className="text-[15.5px] font-extrabold tracking-[-0.01em] text-[var(--chip-ink)]">
            {title}
          </h2>
          {sub && (
            <div className="mt-0.5 text-[12.5px] font-medium text-[var(--chip-ink-soft)]">{sub}</div>
          )}
        </div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Ref `.note` — amber inline note (snapshot scope). */
function AmberNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] px-[13px] py-[11px] text-[12.5px] font-semibold leading-relaxed text-[var(--chip-amber-ink)]">
      <Info className="mt-[1px] h-[15px] w-[15px] shrink-0" />
      <span>{children}</span>
    </div>
  );
}

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

// ── Holder blocks (Chip2 `.oblock`) ────────────────────────────────────────

interface PendingNumber {
  number: string;
  /** Captured from the mini type selector AT ADD TIME (per-number type). */
  chip_type: ChipType;
}

interface HolderBlock {
  key: number;
  role: ChipResidentRole | null;
  holderName: string;
  holderPhone: string;
  phoneTouched: boolean;
  numInput: string;
  /** Current mini-selector value — captured into each number on add. */
  numType: ChipType;
  pending: PendingNumber[];
  /** Existing chips of this holder — read-only tags, toggled via the dialogs. */
  saved: ChipWithHolder[];
  /** Client-side duplicate hint under the add row. */
  dupHint: string | null;
}

function emptyBlock(key: number): HolderBlock {
  return {
    key, role: null, holderName: '', holderPhone: '', phoneTouched: false,
    numInput: '', numType: 'physical', pending: [], saved: [], dupHint: null,
  };
}

/** Person identity of a saved chip → grouping key (contact is fixed here). */
function holderKeyOf(chip: ChipWithHolder): string {
  return isSnapshotRole(chip.resident_role)
    ? `${chip.resident_role}:${chip.holder_name ?? ''}`
    : chip.resident_role;
}

function blockIdentityKey(b: HolderBlock): string | null {
  if (!b.role) return null;
  return isSnapshotRole(b.role) ? `${b.role}:${b.holderName.trim()}` : b.role;
}

/** Effective pending of a block — the add-row remnant counts too (typing one
 *  number and saving without clicking "הוסף" still issues it). */
function effectivePending(b: HolderBlock): PendingNumber[] {
  const remnant = b.numInput.trim();
  if (remnant && !b.pending.some((p) => p.number === remnant)) {
    return [...b.pending, { number: remnant, chip_type: b.numType }];
  }
  return b.pending;
}

const REGISTRY_ROLES: readonly ChipResidentRole[] = ['owner', 'tenant', 'operator'];

interface IssueChipSheetProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: {
    contactId: string;
    apartmentNumber: string;
    residentRole?: string | null;
    holderName?: string | null;
    holderPhone?: string | null;
  } | null;
  onIssued: () => void;
}

export function IssueChipSheet({ open, onOpenChange, initial, onIssued }: IssueChipSheetProps) {
  // Contact selection
  const [contactId, setContactId] = useState<string | null>(null);
  const [contactLabel, setContactLabel] = useState('');
  const [residents, setResidents] = useState<ContactResidents | null>(null);
  const [residentsLoading, setResidentsLoading] = useState(false);
  const [activeCount, setActiveCount] = useState<number | null>(null);

  // Holder blocks
  const blockSeq = useRef(1);
  const [blocks, setBlocks] = useState<HolderBlock[]>([emptyBlock(0)]);
  const [chipsVersion, setChipsVersion] = useState(0); // bump → refetch saved chips

  // Saved-chip toggle dialogs (immediate, never silent)
  const [deactivateTarget, setDeactivateTarget] = useState<ChipWithHolder | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<ChipWithHolder | null>(null);

  // Global fee / notes / override
  const [fee, setFee] = useState('');
  const [feeCharged, setFeeCharged] = useState(false);
  const [notes, setNotes] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  // 409 marking: the offending pending tag turns red
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
    setDeactivateTarget(null);
    setReactivateTarget(null);
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
            const next: HolderBlock[] = [];
            const used = new Set<string>();
            // 1. Existing blocks keep their position + local edits; saved refreshes.
            for (const b of prev) {
              const idKey = blockIdentityKey(b);
              const saved = idKey ? grouped.get(idKey) ?? [] : [];
              if (idKey) used.add(idKey);
              next.push({ ...b, saved });
            }
            // 2. Holders with chips but no block yet → new read-only blocks.
            for (const [k, saved] of grouped) {
              if (used.has(k)) continue;
              const first = saved[0];
              const holder = resolveChipHolder(first);
              next.push({
                ...emptyBlock(blockSeq.current++),
                role: first.resident_role,
                holderName: holder.name === '—' ? '' : holder.name,
                holderPhone: holder.phone ?? '',
                saved,
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
                const wantKey = isSnapshotRole(role)
                  ? `${role}:${(init.holderName ?? '').trim()}`
                  : role;
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
          const res = await fetch(
            `/api/contacts/search?q=${encodeURIComponent(term)}`,
            { credentials: 'include' },
          );
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

  const totalPending = useMemo(
    () => blocks.reduce((s, b) => s + effectivePending(b).length, 0),
    [blocks],
  );

  /** Registry roles already used by OTHER blocks → "נבחר בבלוק אחר". */
  const takenRoles = useMemo(() => {
    const map = new Map<ChipResidentRole, number>(); // role -> blockKey
    for (const b of blocks) {
      if (b.role && REGISTRY_ROLES.includes(b.role)) map.set(b.role, b.key);
    }
    return map;
  }, [blocks]);

  const phoneErrorOf = (b: HolderBlock): string | null => {
    if (!b.holderPhone.trim()) return null;
    const v = validatePhone(b.holderPhone);
    return v.valid ? null : v.error ?? 'מספר טלפון לא תקין';
  };

  const feeError = useMemo(() => {
    if (!fee.trim()) return null;
    const n = Number(fee);
    return Number.isFinite(n) && n >= 0 ? null : 'סכום לא תקין';
  }, [fee]);

  // Soft limit: existing actives + ALL pending numbers across ALL blocks
  // (clarification 1 — the per-type group split never bypasses this count).
  const overLimit =
    activeCount != null && exceedsSoftLimit(activeCount, Math.max(totalPending, 1));

  /** Per-block validity — only blocks that actually issue something matter. */
  const blockInvalid = (b: HolderBlock): string | null => {
    const pending = effectivePending(b);
    if (pending.length === 0) return null; // nothing to issue from this block
    if (!b.role) return 'בחר תפקיד לבעל הצ׳יפ';
    if (isSnapshotRole(b.role) && !b.holderName.trim()) return 'לבעל צ׳יפ מסוג "אחר" נדרש שם מלא';
    if (phoneErrorOf(b)) return phoneErrorOf(b);
    if (b.pending.length > MAX_CHIPS_PER_GROUP) return `עד ${MAX_CHIPS_PER_GROUP} מספרים חדשים לבלוק`;
    return null;
  };

  const canSubmit =
    !!contactId &&
    totalPending >= 1 &&
    blocks.every((b) => blockInvalid(b) === null) &&
    !feeError &&
    (!overLimit || overrideReason.trim() !== '') &&
    !submitting;

  // ── ESC layering (LIFO: dialogs > confirm > picker > panel) ──────────────

  const dialogOpen = !!deactivateTarget || !!reactivateTarget;
  useEscapeKey(open && !confirmCloseOpen && !pickerOpen && !dialogOpen, () => requestClose());
  useEscapeKey(open && pickerOpen && !confirmCloseOpen && !dialogOpen, () => setPickerOpen(false));
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (submitting) return;
    if (dirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }

  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    onOpenChange(false);
  }

  // ── Block mutators (every user edit marks the panel dirty) ───────────────

  function patchBlock(key: number, patch: Partial<HolderBlock>) {
    setDirty(true);
    setServerError(null);
    setBlocks((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }

  function addBlock() {
    setDirty(true);
    setBlocks((prev) => [...prev, emptyBlock(blockSeq.current++)]);
  }

  /** Remove a block — only offered while it has NO saved chips. If it was the
   *  last one, a fresh empty block takes its place (the window keeps ≥1). */
  function removeBlock(key: number) {
    setDirty(true);
    setConflict((c) => (c?.blockKey === key ? null : c));
    setBlocks((prev) => {
      const next = prev.filter((b) => b.key !== key);
      return next.length > 0 ? next : [emptyBlock(blockSeq.current++)];
    });
  }

  function selectRoleCard(block: HolderBlock, card: ContactResidentCard) {
    patchBlock(block.key, {
      role: card.role,
      holderName: card.name ?? '',
      holderPhone: card.phone ?? '',
      phoneTouched: false,
    });
  }

  function selectOther(block: HolderBlock) {
    patchBlock(block.key, { role: 'other', holderName: '', holderPhone: '', phoneTouched: false });
  }

  /** All numbers already present in the window (pending + saved, all blocks). */
  function numberExistsInWindow(num: string): boolean {
    return blocks.some(
      (b) =>
        b.pending.some((p) => p.number === num) ||
        b.saved.some((c) => c.chip_number === num),
    );
  }

  /** Add the typed number as a pending tag, capturing the current type. */
  function addNumber(block: HolderBlock) {
    const v = block.numInput.trim();
    if (!v) return;
    if (block.pending.length >= MAX_CHIPS_PER_GROUP) return;
    if (numberExistsInWindow(v)) {
      patchBlock(block.key, { dupHint: `המספר ${v} כבר נמצא בחלון הזה` });
      return;
    }
    patchBlock(block.key, {
      pending: [...block.pending, { number: v, chip_type: block.numType }],
      numInput: '',
      dupHint: null,
    });
  }

  /** Remove a PENDING (not-yet-issued) number — a typo fix, not a deletion. */
  function removePending(block: HolderBlock, num: string) {
    setConflict((c) => (c?.blockKey === block.key && c.number === num ? null : c));
    patchBlock(block.key, { pending: block.pending.filter((p) => p.number !== num) });
  }

  /** Saved-chip toggle → the dialogs, immediately (never silent). */
  function requestToggle(chip: ChipWithHolder) {
    if (chip.status === 'active') setDeactivateTarget(chip);
    else setReactivateTarget(chip);
  }

  function afterToggle() {
    setChipsVersion((v) => v + 1); // refetch + regroup (pending preserved)
    onIssued(); // parent list/KPIs refresh
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
      const data = (await res.json().catch(() => ({}))) as {
        contact?: { id: string; apartment_number: string };
        error?: string;
      };
      if (res.status === 409) {
        const norm = term.replace(/\D/g, '').replace(/^0+/, '') || '0';
        const sRes = await fetch(
          `/api/contacts/search?q=${encodeURIComponent(norm)}`,
          { credentials: 'include' },
        );
        const sData = (await sRes.json().catch(() => ({}))) as { items?: ContactSearchItem[] };
        const items = sData.items ?? [];
        if (items.length > 0) {
          pickContact(items[0]);
        } else {
          setCreateError('הדירה כבר קיימת במרשם — חפש ובחר אותה');
        }
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

  function pickContact(item: ContactSearchItem) {
    selectContact(item.id, item.apartment_number);
  }

  // ── Submit — ALL pending tags from ALL blocks, one transaction ───────────

  async function handleSubmit() {
    if (!canSubmit || !contactId) return;
    setSubmitting(true);
    setServerError(null);
    setConflict(null);
    try {
      // Split each block's pending by captured type → per-type groups (API is
      // chip_type-per-group); keep the mapping so a 409's group_index lands
      // back on the right block + tag.
      const groups: IssueChipGroup[] = [];
      const groupToBlock: number[] = [];
      for (const b of blocks) {
        const pending = effectivePending(b);
        if (pending.length === 0 || !b.role) continue;
        const byType = new Map<ChipType, string[]>();
        for (const p of pending) {
          byType.set(p.chip_type, [...(byType.get(p.chip_type) ?? []), p.number]);
        }
        for (const [type, numbers] of byType) {
          groups.push({
            resident_role: b.role,
            holder_name: b.holderName.trim() || null,
            holder_phone: b.holderPhone.trim()
              ? validatePhone(b.holderPhone).normalized
              : null,
            chip_type: type,
            numbers,
          });
          groupToBlock.push(b.key);
        }
      }

      const res = await fetch('/api/chips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          contact_id: contactId,
          groups,
          issuance_fee: fee.trim() ? Number(fee) : null,
          fee_charged: feeCharged,
          notes: notes.trim() || null,
          limit_override_reason: overLimit ? overrideReason.trim() : null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        items?: unknown[];
        error?: string;
        chip_number?: string;
        group_index?: number | null;
      };
      if (!res.ok) {
        const msg = data.error ?? 'הנפקת הצ׳יפ נכשלה';
        if (res.status === 409 && data.chip_number != null) {
          // Nothing was saved (all-or-nothing) — mark the offending tag red.
          const blockKey =
            typeof data.group_index === 'number'
              ? groupToBlock[data.group_index] ?? null
              : null;
          if (blockKey != null) setConflict({ blockKey, number: data.chip_number });
          setServerError(msg);
        } else if (res.status === 400 || res.status === 422) {
          setServerError(msg);
        } else {
          toast.error(msg);
        }
        return;
      }
      const count = Array.isArray(data.items) ? data.items.length : totalPending;
      toast.success(count > 1 ? `${count} צ׳יפים הונפקו` : 'הצ׳יפ הונפק');
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
  const disabledAll = !contactId || submitting;

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="chips-skin w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-[var(--chip-panel)]"
        >
          {/* Header — ref gradient; Chip2 subtitle */}
          <SheetHeader className="flex-none gap-2 bg-[image:var(--chip-header-gradient)] px-[28px] py-[22px] text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-[21px] font-extrabold tracking-[-0.02em] text-white">
                  הנפקת צ׳יפ
                </SheetTitle>
                <p className="mt-[4px] text-[13.5px] font-medium text-white/[0.82]">
                  דירה אחת · כמה בעלי צ׳יפ · לכל אחד הצ׳יפים שלו
                </p>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="סגור"
                disabled={submitting}
                className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[11px] border border-white/25 bg-white/12 text-white transition-colors hover:bg-white/22 disabled:opacity-60"
              >
                <X className="h-[18px] w-[18px]" strokeWidth={2.4} />
              </button>
            </div>
          </SheetHeader>

          {/* Body — screen-bg behind white section cards */}
          <div className="flex-1 overflow-y-auto bg-[var(--chip-bg)] p-[22px]">
            <div className="mx-auto flex max-w-[820px] flex-col gap-[18px]">
              {/* Section 1 — apartment / unit (unchanged) */}
              <ChipSection title="דירה / יחידה" icon={Building2} iconTone="blue">
                <div className="space-y-2 px-1 pb-1">
                  <Label htmlFor="chip-contact" className={LABEL_CLS}>
                    בחירת דירה
                    <span className="text-[var(--chip-red)]">*</span>
                  </Label>
                  {locked ? (
                    <div className="flex min-h-11 items-center gap-2 rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel-alt)] px-[14px] py-[10px] text-[14.5px] font-semibold text-[var(--chip-ink)]">
                      <Building2 className="h-4 w-4 shrink-0 text-[var(--chip-ink-soft)]" />
                      <span>
                        דירה{' '}
                        <span className="chip-num">{contactLabel}</span>
                      </span>
                    </div>
                  ) : (
                    <Popover
                      open={pickerOpen}
                      onOpenChange={(o) => {
                        if (submitting) return;
                        setPickerOpen(o);
                        if (!o) {
                          setQuery('');
                          setCreateError(null);
                        }
                      }}
                    >
                      <PopoverTrigger
                        id="chip-contact"
                        disabled={submitting}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 text-start font-semibold transition-colors',
                          INPUT_CLS,
                          'disabled:cursor-not-allowed disabled:opacity-50',
                        )}
                      >
                        <span className={cn('truncate', contactId ? 'text-[var(--chip-ink)]' : 'text-[var(--chip-ink-ghost)]')}>
                          {contactId ? contactLabel : 'בחר דירה או יחידה…'}
                        </span>
                        <ChevronsUpDown className="h-4 w-4 shrink-0 text-[var(--chip-ink-soft)]" />
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        sideOffset={6}
                        className="w-(--anchor-width) min-w-72 p-0"
                      >
                        <div dir="rtl" className="chips-skin flex flex-col">
                          <div className="flex items-center gap-2 border-b border-[var(--chip-border)] px-3">
                            {searching
                              ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--chip-ink-soft)]" />
                              : <Search className="h-4 w-4 shrink-0 text-[var(--chip-ink-soft)]" />}
                            <input
                              autoFocus
                              value={query}
                              onChange={(e) => {
                                setQuery(e.target.value);
                                setCreateError(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && results.length > 0) {
                                  e.preventDefault();
                                  pickContact(results[0]);
                                }
                              }}
                              placeholder="מספר דירה או שם דייר…"
                              className="h-10 w-full bg-transparent text-sm text-[var(--chip-ink)] outline-none placeholder:text-[var(--chip-ink-ghost)]"
                            />
                          </div>
                          <div className="max-h-64 overflow-y-auto p-1">
                            {query.trim().length < 1 ? (
                              <p className="px-3 py-6 text-center text-sm text-[var(--chip-ink-soft)]">
                                הקלד מספר דירה או שם דייר לחיפוש
                              </p>
                            ) : results.length === 0 ? (
                              searching ? (
                                <p className="px-3 py-6 text-center text-sm text-[var(--chip-ink-soft)]">מחפש…</p>
                              ) : (
                                <div className="space-y-1">
                                  <p className="px-3 pb-1 pt-4 text-center text-sm text-[var(--chip-ink-soft)]">
                                    לא נמצאו תוצאות
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => void createApartmentFromQuery()}
                                    disabled={creating}
                                    className="flex min-h-11 w-full items-center gap-2 rounded-[9px] px-3 py-2 text-start text-sm font-bold text-[var(--chip-brand)] transition-colors hover:bg-[var(--chip-brand-soft)] disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    {creating ? (
                                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                                    ) : (
                                      <Plus className="h-4 w-4 shrink-0" />
                                    )}
                                    <span className="min-w-0 flex-1">
                                      דירה{' '}
                                      <span className="chip-num">{query.trim()}</span>{' '}
                                      לא קיימת במרשם — הוסף אותה
                                    </span>
                                  </button>
                                  {createError && (
                                    <div className="rounded-md border border-red-400 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
                                      {createError}
                                    </div>
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
                                    onClick={() => pickContact(item)}
                                    className={cn(
                                      'flex w-full items-center gap-2 rounded-[9px] px-2 py-2 text-start text-sm transition-colors',
                                      isSel
                                        ? 'bg-[var(--chip-brand-soft)] text-[var(--chip-brand-ink)]'
                                        : 'text-[var(--chip-ink-muted)] hover:bg-[var(--chip-hover)]',
                                    )}
                                  >
                                    <Check
                                      className={cn(
                                        'h-4 w-4 shrink-0',
                                        isSel ? 'text-[var(--chip-brand)] opacity-100' : 'opacity-0',
                                      )}
                                    />
                                    <span className="chip-num font-bold text-[var(--chip-ink)]">
                                      {item.apartment_number}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate">
                                      {item.owner_name || item.tenant_name || '—'}
                                    </span>
                                    {item.unit_type !== 'apartment' && (
                                      <span className="inline-flex shrink-0 items-center rounded-[6px] bg-[var(--chip-hover)] px-2 py-0.5 text-[11px] font-bold text-[var(--chip-ink-muted)]">
                                        {UNIT_TYPE_LABEL[item.unit_type] ?? item.unit_type}
                                      </span>
                                    )}
                                    {item.needs_review && (
                                      <span className="inline-flex shrink-0 items-center rounded-[6px] bg-[var(--chip-amber-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--chip-amber-ink)]">
                                        לבדיקה
                                      </span>
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
              </ChipSection>

              {/* Section 2 — holder blocks (Chip2 `.owners-card`) */}
              <ChipSection
                title="בעלי הצ׳יפ"
                sub="כל בלוק = אדם אחד והצ׳יפים שלו · ניתן להוסיף עוד"
                icon={Users}
                iconTone="violet"
              >
                {!contactId ? (
                  <div className="rounded-[13px] border-[1.5px] border-dashed border-[var(--chip-border-strong)] bg-[var(--chip-panel-alt)] p-6 text-center text-[13px] font-semibold text-[var(--chip-ink-soft)]">
                    בחר דירה כדי להוסיף בעלי צ׳יפ
                  </div>
                ) : residentsLoading && blocks.every((b) => b.saved.length === 0 && b.role === null) ? (
                  <div className="space-y-3">
                    <div className="h-[180px] animate-pulse rounded-[14px] bg-[var(--chip-hover)]" />
                  </div>
                ) : (
                  <div className="flex flex-col">
                    {blocks.map((block, bi) => (
                      <HolderBlockCard
                        key={block.key}
                        block={block}
                        index={bi}
                        residentCards={residentCards}
                        residentType={residents?.resident_type ?? null}
                        takenRoles={takenRoles}
                        conflict={conflict}
                        submitting={submitting}
                        invalid={blockInvalid(block)}
                        phoneError={block.phoneTouched ? phoneErrorOf(block) : null}
                        onPatch={(patch) => patchBlock(block.key, patch)}
                        onSelectRole={(card) => selectRoleCard(block, card)}
                        onSelectOther={() => selectOther(block)}
                        onAddNumber={() => addNumber(block)}
                        onRemovePending={(num) => removePending(block, num)}
                        onToggleSaved={requestToggle}
                        onRemoveBlock={() => removeBlock(block.key)}
                      />
                    ))}

                    {/* Chip2 `.addowner` — full-width dashed violet */}
                    <button
                      type="button"
                      onClick={addBlock}
                      disabled={disabledAll}
                      className="mt-[14px] flex h-12 w-full cursor-pointer items-center justify-center gap-[9px] rounded-[13px] border-[1.5px] border-dashed border-[var(--chip-violet-border)] bg-[var(--chip-violet-soft)] text-[14px] font-extrabold text-[var(--chip-violet-ink)] transition-colors hover:border-[var(--chip-violet)] hover:bg-[#ECE2FF] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Plus className="h-[18px] w-[18px]" strokeWidth={2.4} />
                      הוסף בעל צ׳יפ
                    </button>
                  </div>
                )}
              </ChipSection>

              {/* Window-global soft-limit warning + required override reason */}
              {overLimit && (
                <div className="space-y-2.5 rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] p-4">
                  <div className="flex items-start gap-2 text-sm font-semibold text-[var(--chip-amber-ink)]">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      סך הצ׳יפים הפעילים בדירה ({activeCount} קיימים + {Math.max(totalPending, 1)} חדשים
                      בכל הבלוקים) חורג מהמגבלה של 4 צ׳יפים לדירה.
                    </span>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="chip-override" className={LABEL_CLS}>
                      סיבת חריגה
                      <span className="text-[var(--chip-red)]">*</span>
                    </Label>
                    <Textarea
                      id="chip-override"
                      value={overrideReason}
                      onChange={(e) => { setDirty(true); setOverrideReason(e.target.value); }}
                      disabled={submitting}
                      placeholder="לדוגמה: משפחה מורחבת, עובד סיעודי…"
                      className="min-h-[74px] rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-white px-[14px] py-[11px] text-[14px]"
                    />
                  </div>
                </div>
              )}

              {/* Section 3 — fee + notes (GLOBAL: applies to every new chip) */}
              <ChipSection
                title="עמלה והערות"
                sub="חל על כל הצ׳יפים החדשים בשמירה הזו"
                icon={Wallet}
                iconTone="green"
              >
                <div className="grid grid-cols-1 gap-4 px-1 pb-1 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="chip-fee" className={LABEL_CLS}>עמלת הנפקה (₪)</Label>
                    <Input
                      id="chip-fee"
                      value={fee}
                      onChange={(e) => { setDirty(true); setFee(e.target.value); }}
                      disabled={disabledAll}
                      dir="ltr"
                      inputMode="decimal"
                      placeholder="0"
                      className={cn(
                        INPUT_CLS,
                        'chip-num',
                        feeError &&
                          'border-red-400 bg-red-50 focus-visible:border-red-400 focus-visible:ring-red-200',
                      )}
                    />
                    {feeError && (
                      <p className="text-start text-[12px] font-semibold text-red-500">⚠️ {feeError}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-[9px] sm:pt-8">
                    <Checkbox
                      id="chip-fee-charged"
                      checked={feeCharged}
                      onCheckedChange={(v) => { setDirty(true); setFeeCharged(v === true); }}
                      disabled={disabledAll}
                      className="h-[22px] w-[22px] rounded-[7px] border-[1.5px] border-[var(--chip-border-strong)] data-[state=checked]:border-[var(--chip-green)] data-[state=checked]:bg-[var(--chip-green)] data-[state=checked]:text-white"
                    />
                    <Label
                      htmlFor="chip-fee-charged"
                      className="cursor-pointer select-none text-[14px] font-semibold text-[var(--chip-ink)]"
                    >
                      החיוב בוצע
                    </Label>
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="chip-notes" className={LABEL_CLS}>הערה</Label>
                    <Textarea
                      id="chip-notes"
                      value={notes}
                      onChange={(e) => { setDirty(true); setNotes(e.target.value); }}
                      disabled={disabledAll}
                      placeholder="הערות פנימיות על ההנפקה…"
                      className="min-h-[74px] rounded-[11px] border-[1.5px] border-[var(--chip-border)] px-[14px] py-[11px] text-[14px]"
                    />
                  </div>
                </div>
              </ChipSection>

              {/* Server-side 400/409/422 — inline error box */}
              {serverError && (
                <div className="rounded-[11px] border border-red-400 bg-red-50 p-4 text-sm font-semibold text-red-700">
                  {serverError}
                </div>
              )}
            </div>
          </div>

          {/* Footer — primary at start (approved override of Chip2's order) */}
          <div className="flex flex-none items-center gap-3 border-t border-[var(--chip-border)] bg-[var(--chip-panel)] px-6 py-[15px]">
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="h-[46px] gap-2 rounded-[11px] bg-[var(--chip-brand)] px-[26px] text-[15px] font-bold text-white hover:bg-[var(--chip-brand-hover)] disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? 'מנפיק…' : 'הנפק צ׳יפ'}
            </Button>
            <span className="flex-1" />
            <Button
              type="button"
              variant="outline"
              onClick={requestClose}
              disabled={submitting}
              className="h-[46px] rounded-[11px] border-[1.5px] border-[var(--chip-border-strong)] bg-[var(--chip-panel)] px-[22px] text-[14px] font-bold text-[var(--chip-ink)] hover:bg-[var(--chip-hover)]"
            >
              סגור
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Saved-chip toggles — the SAME dialogs as the chips page (immediate) */}
      <DeactivateChipDialog
        chip={deactivateTarget}
        open={!!deactivateTarget}
        onOpenChange={(o: boolean) => { if (!o) setDeactivateTarget(null); }}
        onDone={() => {
          setDeactivateTarget(null);
          afterToggle();
        }}
      />
      <ReactivateChipDialog
        chip={reactivateTarget}
        open={!!reactivateTarget}
        onOpenChange={(o: boolean) => { if (!o) setReactivateTarget(null); }}
        onDone={() => {
          setReactivateTarget(null);
          afterToggle();
        }}
      />

      {/* Dirty-guard — confirm exit without saving */}
      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>האם לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>
              המספרים הממתינים יימחקו ולא יונפקו. צ׳יפים קיימים לא מושפעים.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDiscardClose}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   One holder block (Chip2 `.oblock`): numbered badge + name/role header +
   optional remove (only while NO saved chips) → 2×2 role cards (with the
   taken state) → snapshot name/phone → separator → add-row with per-number
   type capture → tags (saved active / saved inactive / pending amber).
   ──────────────────────────────────────────────────────────────────────────── */

function HolderBlockCard({
  block, index, residentCards, residentType, takenRoles, conflict, submitting,
  invalid, phoneError,
  onPatch, onSelectRole, onSelectOther, onAddNumber, onRemovePending,
  onToggleSaved, onRemoveBlock,
}: {
  block: HolderBlock;
  index: number;
  residentCards: ContactResidentCard[];
  residentType: string | null;
  takenRoles: Map<ChipResidentRole, number>;
  conflict: { blockKey: number; number: string } | null;
  submitting: boolean;
  invalid: string | null;
  phoneError: string | null;
  onPatch: (patch: Partial<HolderBlock>) => void;
  onSelectRole: (card: ContactResidentCard) => void;
  onSelectOther: () => void;
  onAddNumber: () => void;
  onRemovePending: (num: string) => void;
  onToggleSaved: (chip: ChipWithHolder) => void;
  onRemoveBlock: () => void;
}) {
  const hasSaved = block.saved.length > 0;
  const roleLocked = hasSaved; // block identity is fixed by its saved chips
  const firstName = block.holderName.trim().split(/\s+/)[0] || null;
  const isEmpty =
    block.role === null && block.pending.length === 0 && !hasSaved && block.numInput.trim() === '';

  return (
    <div
      className={cn(
        'relative rounded-[14px] border-[1.5px] p-4 shadow-[0_1px_0_rgba(124,77,255,0.04)]',
        index > 0 && 'mt-[14px]',
        isEmpty
          ? 'border-dashed border-[var(--chip-border-strong)] bg-[var(--chip-panel-alt)]'
          : 'border-[var(--chip-violet-border)] bg-[var(--chip-panel)]',
      )}
    >
      {/* Block header (Chip2 `.ohead`) */}
      <div className="mb-[14px] flex items-center gap-[10px]">
        <span
          className={cn(
            'chip-num grid h-7 w-7 shrink-0 place-items-center rounded-[9px] text-[14px] font-semibold',
            isEmpty
              ? 'bg-[var(--chip-hover)] text-[var(--chip-ink-soft)]'
              : 'bg-[var(--chip-violet-soft)] text-[var(--chip-violet-ink)]',
          )}
        >
          {index + 1}
        </span>
        <div className="flex min-w-0 flex-1 flex-col text-start">
          <b className="truncate text-[14.5px] font-extrabold tracking-[-0.01em] text-[var(--chip-ink)]">
            {block.holderName.trim() || 'בעל צ׳יפ חדש'}
          </b>
          <span className="text-[12px] font-semibold text-[var(--chip-ink-soft)]">
            {block.role ? RESIDENT_ROLE_LABEL[block.role] : 'בחר תפקיד'}
            {hasSaved && ` · ${block.saved.length} צ׳יפים קיימים`}
          </span>
        </div>
        {/* Remove block — ONLY while it holds no saved chips (approved rule) */}
        {!hasSaved && (
          <button
            type="button"
            title="הסר בלוק"
            aria-label="הסר בלוק"
            disabled={submitting}
            onClick={onRemoveBlock}
            className="grid h-[30px] w-[30px] shrink-0 cursor-pointer place-items-center rounded-[8px] border border-[var(--chip-border-strong)] bg-[var(--chip-panel)] text-[var(--chip-ink-muted)] transition-colors hover:border-[var(--chip-red)] hover:bg-[var(--chip-red-soft)] hover:text-[var(--chip-red)]"
          >
            <X className="h-[15px] w-[15px]" strokeWidth={2} />
          </button>
        )}
      </div>

      {/* Role selector — compact SINGLE ROW (Chip2 `.roles`/`.role`, user
          decision 09/08 replacing the earlier 2×2 override). Registry details
          moved off the buttons: selection auto-fills the name/phone fields
          below; states — sel (brand), taken (ghost ✓ + hint), no-details
          (disabled + hint with the registry link). */}
      <div className="flex gap-1.5 sm:gap-2">
        {residentCards.map((card) => {
          const selected = block.role === card.role;
          const takenBy = takenRoles.get(card.role);
          const taken = takenBy !== undefined && takenBy !== block.key;
          const lockedOut = roleLocked && !selected;
          const noDetails = !card.exists;
          return (
            <button
              key={card.role}
              type="button"
              disabled={submitting || taken || lockedOut || noDetails}
              title={
                taken ? 'נבחר בבלוק אחר'
                : noDetails ? 'לא הוזנו פרטים במרשם'
                : undefined
              }
              onClick={() => onSelectRole(card)}
              className={cn(
                'flex h-10 min-w-0 flex-auto items-center justify-center gap-[5px] rounded-[10px] border-[1.5px] px-1.5 text-[12px] font-bold transition-colors sm:flex-1 sm:px-2 sm:text-[13px]',
                selected
                  ? 'border-[var(--chip-brand)] bg-[var(--chip-brand-soft)] text-[var(--chip-brand-ink)] shadow-[0_0_0_3px_rgba(61,90,254,0.1)]'
                  : taken || lockedOut || noDetails
                    ? 'cursor-not-allowed border-[var(--chip-border)] bg-[var(--chip-panel-alt)] text-[var(--chip-ink-soft)]'
                    : 'cursor-pointer border-[var(--chip-border-strong)] bg-[var(--chip-panel)] text-[var(--chip-ink-muted)] hover:border-[var(--chip-ink-ghost)] hover:bg-[var(--chip-hover)] hover:text-[var(--chip-ink)]',
              )}
            >
              {/* ✓ renders only when visible so narrow screens keep the label */}
              {(selected || taken) && (
                <Check
                  className={cn(
                    'hidden h-4 w-4 shrink-0 sm:block',
                    selected ? 'text-[var(--chip-brand)]' : 'text-[var(--chip-ink-ghost)]',
                  )}
                  strokeWidth={3.4}
                />
              )}
              <span className="truncate">{RESIDENT_ROLE_LABEL[card.role]}</span>
            </button>
          );
        })}

        {/* "אחר" — selectable in ANY number of blocks (two cleaners = two blocks) */}
        <button
          type="button"
          disabled={submitting || (roleLocked && block.role !== 'other')}
          title="הזנה חופשית של שם וטלפון"
          onClick={onSelectOther}
          className={cn(
            'flex h-10 min-w-0 flex-auto items-center justify-center gap-[5px] rounded-[10px] border-[1.5px] px-1.5 text-[12px] font-bold transition-colors sm:flex-1 sm:px-2 sm:text-[13px]',
            block.role === 'other'
              ? 'border-[var(--chip-brand)] bg-[var(--chip-brand-soft)] text-[var(--chip-brand-ink)] shadow-[0_0_0_3px_rgba(61,90,254,0.1)]'
              : roleLocked
                ? 'cursor-not-allowed border-[var(--chip-border)] bg-[var(--chip-panel-alt)] text-[var(--chip-ink-soft)]'
                : 'cursor-pointer border-[var(--chip-border-strong)] bg-[var(--chip-panel)] text-[var(--chip-ink-muted)] hover:border-[var(--chip-ink-ghost)] hover:bg-[var(--chip-hover)] hover:text-[var(--chip-ink)]',
          )}
        >
          {block.role === 'other' && (
            <Check className="hidden h-4 w-4 shrink-0 text-[var(--chip-brand)] sm:block" strokeWidth={3.4} />
          )}
          <span className="truncate">אחר</span>
        </button>
      </div>

      {/* Hint row (Chip2 `.rhint`) — replaces the info the 2×2 cards carried */}
      {(() => {
        const livesHereSelected = block.role && residentType === block.role;
        const missing = residentCards.filter((c) => !c.exists);
        const takenHints = residentCards.filter((c) => {
          const by = takenRoles.get(c.role);
          return by !== undefined && by !== block.key;
        });
        if (!livesHereSelected && missing.length === 0 && takenHints.length === 0) return null;
        return (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] font-semibold text-[var(--chip-ink-soft)]">
            {livesHereSelected && (
              <span className="inline-flex items-center gap-[5px]">
                <Building2 className="h-[13px] w-[13px] text-[var(--chip-ink-ghost)]" />
                גר בדירה
              </span>
            )}
            {takenHints.map((c) => (
              <span key={c.role}>{RESIDENT_ROLE_LABEL[c.role]} — נבחר בבלוק אחר</span>
            ))}
            {missing.length > 0 && (
              <span className="inline-flex items-center gap-1">
                {missing.map((c) => RESIDENT_ROLE_LABEL[c.role]).join(' / ')} — לא הוזנו פרטים ·
                <Link
                  href="/contacts"
                  className="font-bold text-[var(--chip-brand)] hover:text-[var(--chip-brand-hover)]"
                >
                  השלם פרטים ›
                </Link>
              </span>
            )}
          </div>
        );
      })()}

      {/* Snapshot name + phone (override applies to this block's chips only) */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`holder-name-${block.key}`} className={LABEL_CLS}>שם בעל הצ׳יפ</Label>
          <Input
            id={`holder-name-${block.key}`}
            value={block.holderName}
            onChange={(e) => onPatch({ holderName: e.target.value })}
            disabled={submitting}
            placeholder="שם מלא"
            className={INPUT_CLS}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`holder-phone-${block.key}`} className={LABEL_CLS}>טלפון בעל הצ׳יפ</Label>
          <Input
            id={`holder-phone-${block.key}`}
            value={block.holderPhone}
            onChange={(e) => onPatch({ holderPhone: e.target.value })}
            onBlur={() => onPatch({ phoneTouched: true })}
            disabled={submitting}
            dir="ltr"
            inputMode="tel"
            autoComplete="tel"
            placeholder="052-1234567"
            className={cn(
              INPUT_CLS,
              'chip-num',
              phoneError &&
                'border-red-400 bg-red-50 focus-visible:border-red-400 focus-visible:ring-red-200',
            )}
          />
          {phoneError && (
            <p className="text-start text-[12px] font-semibold text-red-500">⚠️ {phoneError}</p>
          )}
        </div>
      </div>
      {block.role && !isSnapshotRole(block.role) && (
        <div className="mt-3">
          <AmberNote>
            שינוי השם או הטלפון כאן חל על הצ׳יפים של הבלוק הזה בלבד — מרשם הדיירים לא מתעדכן.
          </AmberNote>
        </div>
      )}

      {/* Separator (Chip2 `.sepline`) */}
      <div className="my-[14px] h-px bg-[var(--chip-border)]" />

      {/* Chip numbers of this person */}
      <div className="mb-[9px] flex items-center gap-[6px] text-[13px] font-bold text-[var(--chip-ink-muted)]">
        <span className="text-[var(--chip-brand)]">#</span>
        {firstName ? `מספרי הצ׳יפ של ${firstName}` : 'מספרי צ׳יפ'}
        <span className="font-medium text-[var(--chip-ink-soft)]">· עד {MAX_CHIPS_PER_GROUP} חדשים בשמירה</span>
      </div>

      {/* Add row: mono input + per-number type mini-selector + add (Chip2) */}
      <div className="flex flex-wrap gap-[9px]">
        <Input
          value={block.numInput}
          onChange={(e) => onPatch({ numInput: e.target.value, dupHint: null })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAddNumber();
            }
          }}
          disabled={submitting || block.pending.length >= MAX_CHIPS_PER_GROUP}
          dir="ltr"
          placeholder="מספר צ׳יפ"
          aria-label={`מספר צ׳יפ (בלוק ${index + 1})`}
          className={cn(INPUT_CLS, 'chip-num h-[42px] min-w-[140px] flex-1')}
        />
        <div className="inline-flex shrink-0 gap-1 rounded-[10px] border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel-alt)] p-1">
          {(['physical', 'app'] as const).map((t) => {
            const TypeIcon = t === 'physical' ? CreditCard : Smartphone;
            const on = block.numType === t;
            return (
              <button
                key={t}
                type="button"
                disabled={submitting}
                onClick={() => onPatch({ numType: t })}
                className={cn(
                  'inline-flex h-8 cursor-pointer items-center gap-[5px] rounded-[7px] px-[11px] text-[12.5px] font-bold transition-colors',
                  on ? 'bg-[var(--chip-brand)] text-white' : 'bg-transparent text-[var(--chip-ink-muted)]',
                )}
              >
                <TypeIcon className={cn('h-[13px] w-[13px]', on ? 'opacity-100' : 'opacity-60')} />
                {CHIP_TYPE_LABEL[t]}
              </button>
            );
          })}
        </div>
        <Button
          type="button"
          onClick={onAddNumber}
          disabled={submitting || !block.numInput.trim() || block.pending.length >= MAX_CHIPS_PER_GROUP}
          className="h-[42px] gap-[7px] rounded-[11px] bg-[var(--chip-brand)] px-4 text-[13.5px] font-bold text-white hover:bg-[var(--chip-brand-hover)]"
        >
          <Plus className="h-4 w-4" strokeWidth={2.6} />
          הוסף
        </Button>
      </div>
      {block.dupHint && (
        <p className="mt-2 text-[12px] font-semibold text-red-500">⚠️ {block.dupHint}</p>
      )}

      {/* Tags: saved (toggle via dialogs) + pending (amber, X removes) */}
      {block.saved.length > 0 || block.pending.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {block.saved.map((chip) => {
            const active = chip.status === 'active';
            const TypeIcon = chip.chip_type === 'physical' ? CreditCard : Smartphone;
            return (
              <span
                key={chip.id}
                className={cn(
                  'inline-flex h-9 items-center gap-2 rounded-[11px] border-[1.5px] ps-3 pe-[5px]',
                  active
                    ? 'border-[var(--chip-green-border)] bg-[var(--chip-green-soft)]'
                    : 'border-dashed border-[var(--chip-border-strong)] bg-[var(--chip-panel-alt)]',
                )}
              >
                <span
                  className={cn(
                    'chip-num text-[13.5px] font-semibold tracking-[0.02em]',
                    active
                      ? 'text-[var(--chip-green-ink)]'
                      : 'text-[var(--chip-ink-soft)] line-through decoration-[var(--chip-ink-ghost)]',
                  )}
                >
                  {chip.chip_number}
                </span>
                <span
                  className={cn(
                    'inline-flex h-[21px] items-center gap-1 rounded-[6px] px-2 text-[10.5px] font-bold',
                    active ? 'bg-white text-[var(--chip-green-ink)]' : 'bg-[var(--chip-hover)] text-[var(--chip-ink-soft)]',
                  )}
                >
                  <span
                    className={cn(
                      'h-[6px] w-[6px] rounded-full',
                      active ? 'bg-[var(--chip-green)]' : 'bg-[var(--chip-ink-ghost)]',
                    )}
                  />
                  {active ? 'פעיל' : 'לא פעיל'}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 border-s ps-2 text-[11px] font-bold',
                    active
                      ? 'border-[var(--chip-green-border)] text-[var(--chip-green-ink)]'
                      : 'border-[var(--chip-border-strong)] text-[var(--chip-ink-soft)]',
                  )}
                >
                  <TypeIcon className="h-[13px] w-[13px] opacity-75" />
                  {CHIP_TYPE_LABEL[chip.chip_type]}
                </span>
                {/* Toggle — 30px visual, 44px hit area via padding-less grid +
                    touch margin; opens the dialogs, NEVER silent */}
                <button
                  type="button"
                  title={active ? 'השבת' : 'החזר לפעיל'}
                  aria-label={active ? `השבת את ${chip.chip_number}` : `החזר לפעיל את ${chip.chip_number}`}
                  disabled={submitting}
                  onClick={() => onToggleSaved(chip)}
                  className={cn(
                    'grid h-[30px] w-[30px] cursor-pointer place-items-center rounded-[8px] border transition-colors',
                    active
                      ? 'border-[var(--chip-green-border)] bg-white text-[var(--chip-green-ink)] hover:border-[var(--chip-green)] hover:bg-[var(--chip-green)] hover:text-white'
                      : 'border-[var(--chip-border-strong)] bg-white text-[var(--chip-ink-muted)] hover:border-[var(--chip-brand)] hover:bg-[var(--chip-brand)] hover:text-white',
                  )}
                >
                  {active ? (
                    <Power className="h-[14px] w-[14px]" strokeWidth={2.2} />
                  ) : (
                    <RotateCcw className="h-[14px] w-[14px]" strokeWidth={2.2} />
                  )}
                </button>
              </span>
            );
          })}

          {block.pending.map((p) => {
            const isConflict =
              conflict?.blockKey === block.key && conflict.number === p.number;
            const TypeIcon = p.chip_type === 'physical' ? CreditCard : Smartphone;
            return (
              <span
                key={p.number}
                className={cn(
                  'inline-flex h-9 items-center gap-2 rounded-[11px] border-[1.5px] border-dashed ps-3 pe-[5px]',
                  isConflict
                    ? 'border-[var(--chip-red)] bg-[var(--chip-red-soft)]'
                    : 'border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)]',
                )}
              >
                <span
                  className={cn(
                    'chip-num text-[13.5px] font-semibold tracking-[0.02em]',
                    isConflict ? 'text-[var(--chip-red)]' : 'text-[var(--chip-amber-ink)]',
                  )}
                >
                  {p.number}
                </span>
                <span
                  className={cn(
                    'inline-flex h-[21px] items-center gap-1 rounded-[6px] bg-white px-2 text-[10.5px] font-bold',
                    isConflict ? 'text-[var(--chip-red)]' : 'text-[var(--chip-amber-ink)]',
                  )}
                >
                  <span
                    className={cn(
                      'h-[6px] w-[6px] rounded-full',
                      isConflict ? 'bg-[var(--chip-red)]' : 'bg-[var(--chip-amber)]',
                    )}
                  />
                  {isConflict ? 'מספר תפוס' : 'ממתין להנפקה'}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 border-s ps-2 text-[11px] font-bold',
                    isConflict
                      ? 'border-[var(--chip-red)]/40 text-[var(--chip-red)]'
                      : 'border-[var(--chip-amber-border)] text-[var(--chip-amber-ink)]',
                  )}
                >
                  <TypeIcon className="h-[13px] w-[13px] opacity-75" />
                  {CHIP_TYPE_LABEL[p.chip_type]}
                </span>
                <button
                  type="button"
                  title="הסר (טרם נשמר)"
                  aria-label={`הסר את המספר ${p.number} מהרשימה`}
                  disabled={submitting}
                  onClick={() => onRemovePending(p.number)}
                  className={cn(
                    'grid h-7 w-7 cursor-pointer place-items-center rounded-[8px] border bg-white transition-colors hover:border-[var(--chip-red)] hover:bg-[var(--chip-red)] hover:text-white',
                    isConflict
                      ? 'border-[var(--chip-red)] text-[var(--chip-red)]'
                      : 'border-[var(--chip-amber-border)] text-[var(--chip-amber-ink)]',
                  )}
                >
                  <X className="h-[14px] w-[14px]" strokeWidth={2.4} />
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        !block.numInput.trim() && (
          <div className="mt-3 rounded-[11px] border-[1.5px] border-dashed border-[var(--chip-border-strong)] p-[14px] text-center text-[12.5px] font-semibold text-[var(--chip-ink-soft)]">
            עדיין לא נוספו מספרי צ׳יפ
          </div>
        )
      )}

      {/* Ref caption — the no-delete product rule, stated per block (Chip2) */}
      <div className="mt-[10px] flex items-center gap-[6px] text-[11.5px] font-semibold text-[var(--chip-ink-soft)]">
        <Info className="h-[13px] w-[13px] shrink-0" />
        <span>צ׳יפ שהונפק לא נמחק — אפשר להשבית ולהחזיר לפעיל בכל עת.</span>
      </div>

      {/* Per-block validation hint (only when the block actually issues) */}
      {invalid && (
        <p className="mt-2 text-[12px] font-semibold text-red-500">⚠️ {invalid}</p>
      )}
    </div>
  );
}
