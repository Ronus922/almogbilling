'use client';

// Issue-chip side panel — chips-skin (declared exception): the visual layer is
// derived 1:1 from ref/proof/whatsapp-broadcast/Chip.{html,md} (the ref covers
// exactly this window); the Sheet shell + dirty-guard + error states keep the
// DESIGN.md structure. Flow (unchanged): pick an apartment from the contacts
// registry (async combobox) → pick the chip holder (role cards 2×2, snapshots
// editable per-chip) → chip type (segmented) → 1-5 chip numbers (add-row →
// tags) → fee / notes. Soft-limit (4 active chips per contact) surfaces an
// amber warning + required override reason; server 409/422 render inline.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle, Building2, Check, ChevronsUpDown, CreditCard, Hash, Info,
  Loader2, Plus, Search, Smartphone, Users, Wallet, X,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { validatePhone } from '@/lib/validation';
import { cn } from '@/lib/utils';
import {
  APP_PLATFORMS, APP_PLATFORM_LABEL, CHIP_RESIDENT_ROLES, CHIP_TYPE_LABEL,
  RESIDENT_ROLE_LABEL, UNIT_TYPE_LABEL,
} from '@/lib/constants/chips';
import type {
  AppPlatform, ChipResidentRole, ChipType, ContactResidentCard, ContactResidents,
} from '@/lib/types/chips';

// ── Ref field tokens (Chip.md: input 44px, radius 11, border 1.5, focus ring) ─

const INPUT_CLS =
  'h-11 rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel)] px-[14px] text-[14.5px] text-[var(--chip-ink)] ' +
  'placeholder:text-[var(--chip-ink-soft)] ' +
  'focus-visible:border-[var(--chip-brand)] focus-visible:ring-4 focus-visible:ring-[rgba(61,90,254,0.12)]';

const LABEL_CLS = 'flex items-center gap-1 text-[13px] font-bold text-[var(--chip-ink-muted)]';

const SOFT_LIMIT = 4;
const MAX_NUMBERS = 5;

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
      <div className="px-5 py-[18px]">{children}</div>
    </section>
  );
}

/** Ref `.note` — amber inline note (snapshot scope, "לא נמחק" caption). */
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

  // Holder
  const [role, setRole] = useState<ChipResidentRole | null>(null);
  const [holderName, setHolderName] = useState('');
  const [holderPhone, setHolderPhone] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);

  // Chip type + numbers (ref pattern: add-row input → pending tags, up to 5)
  const [chipType, setChipType] = useState<ChipType>('physical');
  const [appPlatform, setAppPlatform] = useState<AppPlatform>('unknown');
  const [numInput, setNumInput] = useState('');
  const [pendingNumbers, setPendingNumbers] = useState<string[]>([]);

  // Fee / notes / override
  const [fee, setFee] = useState('');
  const [feeCharged, setFeeCharged] = useState(false);
  const [notes, setNotes] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

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
    const initRole =
      init?.residentRole && (CHIP_RESIDENT_ROLES as readonly string[]).includes(init.residentRole)
        ? (init.residentRole as ChipResidentRole)
        : null;
    setRole(initRole);
    setHolderName(init?.holderName ?? '');
    setHolderPhone(init?.holderPhone ?? '');
    setPhoneTouched(false);
    setChipType('physical');
    setAppPlatform('unknown');
    setNumInput('');
    setPendingNumbers([]);
    setFee('');
    setFeeCharged(false);
    setNotes('');
    setOverrideReason('');
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

  // Residents + active-chip count for the selected contact.
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
          const data = (await cRes.json()) as { active_count?: number };
          if (!cancelled) {
            setActiveCount(typeof data.active_count === 'number' ? data.active_count : 0);
          }
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
  }, [open, contactId]);

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

  // The add-row remnant counts too — typing one number and submitting without
  // clicking "הוסף מספר" still issues it (pre-redesign single-row behavior).
  const filledNumbers = useMemo(() => {
    const remnant = numInput.trim();
    if (remnant && !pendingNumbers.includes(remnant)) {
      return [...pendingNumbers, remnant];
    }
    return pendingNumbers;
  }, [pendingNumbers, numInput]);

  const phoneError = useMemo(() => {
    if (!holderPhone.trim()) return null;
    const v = validatePhone(holderPhone);
    return v.valid ? null : v.error ?? 'מספר טלפון לא תקין';
  }, [holderPhone]);

  const feeError = useMemo(() => {
    if (!fee.trim()) return null;
    const n = Number(fee);
    return Number.isFinite(n) && n >= 0 ? null : 'סכום לא תקין';
  }, [fee]);

  // Soft limit: issuing `filledNumbers` (at least 1) on top of active_count
  // must not exceed 4 — unless an override reason is supplied.
  const overLimit =
    activeCount != null && activeCount + Math.max(filledNumbers.length, 1) > SOFT_LIMIT;

  const canSubmit =
    !!contactId &&
    filledNumbers.length >= 1 &&
    filledNumbers.length <= MAX_NUMBERS &&
    !phoneError &&
    !feeError &&
    (!overLimit || overrideReason.trim() !== '') &&
    !submitting;

  // ── ESC layering (LIFO: confirm > picker > panel) ────────────────────────

  useEscapeKey(open && !confirmCloseOpen && !pickerOpen, () => requestClose());
  useEscapeKey(open && pickerOpen && !confirmCloseOpen, () => setPickerOpen(false));
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

  // ── Mutators (every user edit marks the panel dirty) ─────────────────────

  function selectContact(id: string, apartmentNumber: string) {
    setDirty(true);
    setContactId(id);
    setContactLabel(apartmentNumber);
    setRole(null);
    setHolderName('');
    setHolderPhone('');
    setPhoneTouched(false);
    setServerError(null);
    setPickerOpen(false);
    setQuery('');
    setResults([]);
    setCreateError(null);
  }

  function pickContact(item: ContactSearchItem) {
    selectContact(item.id, item.apartment_number);
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
        // Search with the server's canonical key (digits, no leading zeros) —
        // the conflicting row is stored under it; exact hits float first.
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

  function selectResidentCard(card: ContactResidentCard) {
    setDirty(true);
    setRole(card.role);
    setHolderName(card.name ?? '');
    setHolderPhone(card.phone ?? '');
    setPhoneTouched(false);
    setServerError(null);
  }

  function selectOther() {
    setDirty(true);
    setRole('other');
    setHolderName('');
    setHolderPhone('');
    setPhoneTouched(false);
    setServerError(null);
  }

  /** Add the typed number as a pending tag (Enter or the button, ref UX). */
  function addNumber() {
    const v = numInput.trim();
    if (!v) return;
    if (pendingNumbers.length >= MAX_NUMBERS) return;
    setDirty(true);
    setServerError(null);
    if (!pendingNumbers.includes(v)) {
      setPendingNumbers((prev) => [...prev, v]);
    }
    setNumInput('');
  }

  /** Remove a PENDING (not-yet-issued) number — nothing was persisted yet, so
   *  this is a typo fix, not a chip deletion (issued chips are never deleted). */
  function removePending(value: string) {
    setDirty(true);
    setPendingNumbers((prev) => prev.filter((n) => n !== value));
  }

  // ── Submit ───────────────────────────────────────────────────────────────

  async function handleSubmit() {
    if (!canSubmit || !contactId) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const payload = {
        contact_id: contactId,
        chip_type: chipType,
        chip_numbers: filledNumbers,
        resident_role: role,
        holder_name: holderName.trim() || null,
        holder_phone: holderPhone.trim() ? validatePhone(holderPhone).normalized : null,
        app_platform: chipType === 'app' ? appPlatform : null,
        issuance_fee: fee.trim() ? Number(fee) : null,
        fee_charged: feeCharged,
        limit_override_reason: overLimit ? overrideReason.trim() : null,
        notes: notes.trim() || null,
      };
      const res = await fetch('/api/chips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        items?: unknown[];
        error?: string;
      };
      if (!res.ok) {
        const msg = data.error ?? 'הנפקת הצ׳יפ נכשלה';
        if (res.status === 400 || res.status === 409 || res.status === 422) setServerError(msg);
        else toast.error(msg);
        return;
      }
      const count = Array.isArray(data.items) ? data.items.length : filledNumbers.length;
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

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="chips-skin w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-[var(--chip-panel)]"
        >
          {/* Header — ref gradient (115deg, #2B3FB8 → #3D5AFE 62% → #5872FF) */}
          <SheetHeader className="flex-none gap-2 bg-[image:var(--chip-header-gradient)] px-[28px] py-[22px] text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-[21px] font-extrabold tracking-[-0.02em] text-white">
                  הנפקת צ׳יפ
                </SheetTitle>
                <p className="mt-[4px] text-[13.5px] font-medium text-white/[0.82]">
                  בחר דירה, בעל צ׳יפ ומספרי צ׳יפ — עד 5 צ׳יפים בהנפקה אחת.
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

          {/* Body — ref `.mbody`: screen-bg behind white section cards */}
          <div className="flex-1 overflow-y-auto bg-[var(--chip-bg)] p-[22px]">
            <div className="mx-auto flex max-w-[820px] flex-col gap-[18px]">
              {/* Section 1 — apartment / unit (tone blue) */}
              <ChipSection title="דירה / יחידה" icon={Building2} iconTone="blue">
                <div className="space-y-2">
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
                                  {/* Inline registry create — action row (min 44px touch target) */}
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

              {/* Section 2 — chip holder (tone violet, role cards 2×2 per ref) */}
              {contactId && (
                <ChipSection
                  title="בעל הצ׳יפ"
                  sub="בחר את מקבל הצ׳יפ מתוך מרשם הדיירים"
                  icon={Users}
                  iconTone="violet"
                >
                  <div className="space-y-4">
                    {residentsLoading ? (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="h-[92px] animate-pulse rounded-[13px] bg-[var(--chip-hover)]" />
                        <div className="h-[92px] animate-pulse rounded-[13px] bg-[var(--chip-hover)]" />
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {residentCards.map((card) => {
                          const livesHere = residents?.resident_type === card.role;
                          const selected = role === card.role;
                          if (!card.exists) {
                            // Empty registry slot — dashed card + "השלם פרטים ›" (ref)
                            return (
                              <div
                                key={card.role}
                                className="relative flex min-h-[92px] flex-col rounded-[13px] border-[1.5px] border-dashed border-[var(--chip-border)] bg-[var(--chip-panel)] p-[13px]"
                              >
                                <div className="mb-[7px] flex items-center gap-2">
                                  <span className="text-[14px] font-extrabold text-[var(--chip-ink-soft)]">
                                    {RESIDENT_ROLE_LABEL[card.role]}
                                  </span>
                                  {livesHere && (
                                    <span className="inline-flex h-5 items-center rounded-[6px] bg-[var(--chip-brand-soft)] px-2 text-[11px] font-bold text-[var(--chip-brand-ink)]">
                                      גר בדירה
                                    </span>
                                  )}
                                </div>
                                <span className="text-[12.5px] font-medium text-[var(--chip-ink-soft)]">
                                  לא הוזנו פרטים
                                </span>
                                <Link
                                  href="/contacts"
                                  className="mt-auto inline-flex items-center gap-1 pt-2 text-[12.5px] font-bold text-[var(--chip-brand)] hover:text-[var(--chip-brand-hover)]"
                                >
                                  השלם פרטים ›
                                </Link>
                              </div>
                            );
                          }
                          return (
                            <button
                              key={card.role}
                              type="button"
                              disabled={submitting}
                              onClick={() => selectResidentCard(card)}
                              className={cn(
                                'relative flex min-h-[92px] flex-col rounded-[13px] border-[1.5px] p-[13px] text-start transition-all',
                                selected
                                  ? 'border-[var(--chip-brand)] bg-[var(--chip-brand-soft)] shadow-[0_0_0_3px_rgba(61,90,254,0.1)]'
                                  : 'border-[var(--chip-border)] bg-[var(--chip-panel)] hover:border-[var(--chip-ink-ghost)] hover:bg-[var(--chip-hover)]',
                              )}
                            >
                              {/* ✓ circle — ref `.rcheck` (inline-start corner) */}
                              <span
                                className={cn(
                                  'absolute start-3 top-3 grid h-5 w-5 place-items-center rounded-full border-2 text-white transition-colors',
                                  selected
                                    ? 'border-[var(--chip-brand)] bg-[var(--chip-brand)]'
                                    : 'border-[var(--chip-border-strong)]',
                                )}
                              >
                                <Check
                                  className={cn('h-3 w-3 transition-opacity', selected ? 'opacity-100' : 'opacity-0')}
                                  strokeWidth={3.2}
                                />
                              </span>
                              <div className="mb-[7px] flex items-center gap-2 pe-7">
                                <span className="text-[14px] font-extrabold text-[var(--chip-ink)]">
                                  {RESIDENT_ROLE_LABEL[card.role]}
                                </span>
                                {livesHere && (
                                  <span
                                    className={cn(
                                      'inline-flex h-5 items-center rounded-[6px] px-2 text-[11px] font-bold text-[var(--chip-brand-ink)]',
                                      selected ? 'bg-white' : 'bg-[var(--chip-brand-soft)]',
                                    )}
                                  >
                                    גר בדירה
                                  </span>
                                )}
                              </div>
                              <span className="text-[13.5px] font-semibold text-[var(--chip-ink)]">
                                {card.name}
                              </span>
                              {card.phone && (
                                <span className="chip-num mt-[2px] text-start text-[12.5px] text-[var(--chip-ink-muted)]">
                                  {card.phone}
                                </span>
                              )}
                            </button>
                          );
                        })}
                        {/* 4th card — free entry (ref: "אחר") */}
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={selectOther}
                          className={cn(
                            'relative flex min-h-[92px] flex-col rounded-[13px] border-[1.5px] p-[13px] text-start transition-all',
                            role === 'other'
                              ? 'border-[var(--chip-brand)] bg-[var(--chip-brand-soft)] shadow-[0_0_0_3px_rgba(61,90,254,0.1)]'
                              : 'border-dashed border-[var(--chip-border)] bg-[var(--chip-panel)] hover:border-[var(--chip-ink-ghost)] hover:bg-[var(--chip-hover)]',
                          )}
                        >
                          <span
                            className={cn(
                              'absolute start-3 top-3 grid h-5 w-5 place-items-center rounded-full border-2 text-white transition-colors',
                              role === 'other'
                                ? 'border-[var(--chip-brand)] bg-[var(--chip-brand)]'
                                : 'border-[var(--chip-border-strong)]',
                            )}
                          >
                            <Check
                              className={cn('h-3 w-3 transition-opacity', role === 'other' ? 'opacity-100' : 'opacity-0')}
                              strokeWidth={3.2}
                            />
                          </span>
                          <span className="mb-[7px] pe-7 text-[14px] font-extrabold text-[var(--chip-ink)]">אחר</span>
                          <span className="text-[12.5px] font-medium text-[var(--chip-ink-soft)]">
                            הזנה חופשית של שם וטלפון
                          </span>
                        </button>
                      </div>
                    )}

                    {/* Holder snapshot — editable, applies to this chip only */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="chip-holder-name" className={LABEL_CLS}>שם בעל הצ׳יפ</Label>
                        <Input
                          id="chip-holder-name"
                          value={holderName}
                          onChange={(e) => { setDirty(true); setHolderName(e.target.value); }}
                          disabled={submitting}
                          placeholder="שם מלא"
                          className={INPUT_CLS}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="chip-holder-phone" className={LABEL_CLS}>טלפון בעל הצ׳יפ</Label>
                        <Input
                          id="chip-holder-phone"
                          value={holderPhone}
                          onChange={(e) => { setDirty(true); setHolderPhone(e.target.value); }}
                          onBlur={() => setPhoneTouched(true)}
                          disabled={submitting}
                          dir="ltr"
                          inputMode="tel"
                          autoComplete="tel"
                          placeholder="052-1234567"
                          className={cn(
                            INPUT_CLS,
                            'chip-num',
                            phoneTouched && phoneError &&
                              'border-red-400 bg-red-50 focus-visible:border-red-400 focus-visible:ring-red-200',
                          )}
                        />
                        {phoneTouched && phoneError && (
                          <p className="text-right text-[12px] font-semibold text-red-500">⚠️ {phoneError}</p>
                        )}
                      </div>
                    </div>
                    <AmberNote>
                      שינוי השם או הטלפון כאן חל על הצ׳יפ הזה בלבד — מרשם הדיירים לא מתעדכן.
                    </AmberNote>
                  </div>
                </ChipSection>
              )}

              {/* Section 3 — chip type (tone amber, ref segmented) */}
              <ChipSection title="סוג צ׳יפ" icon={CreditCard} iconTone="amber">
                <div className="space-y-4">
                  <div className="inline-flex gap-[6px] rounded-[13px] border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel-alt)] p-[5px]">
                    {(['physical', 'app'] as const).map((t) => {
                      const TypeIcon = t === 'physical' ? CreditCard : Smartphone;
                      const on = chipType === t;
                      return (
                        <button
                          key={t}
                          type="button"
                          disabled={submitting}
                          onClick={() => { setDirty(true); setChipType(t); }}
                          className={cn(
                            'inline-flex h-10 cursor-pointer items-center gap-2 rounded-[9px] px-[22px] text-[14px] font-bold transition-all',
                            on
                              ? 'bg-[var(--chip-brand)] text-white shadow-[0_3px_10px_-3px_rgba(61,90,254,0.5)]'
                              : 'bg-transparent text-[var(--chip-ink-muted)]',
                          )}
                        >
                          <TypeIcon className={cn('h-4 w-4', on ? 'opacity-100' : 'opacity-70')} />
                          {CHIP_TYPE_LABEL[t]}
                        </button>
                      );
                    })}
                  </div>
                  {chipType === 'app' && (
                    <div className="space-y-2 sm:max-w-xs">
                      <Label className={LABEL_CLS}>פלטפורמה</Label>
                      <Select
                        value={appPlatform}
                        onValueChange={(v) => {
                          if (typeof v === 'string' && v) {
                            setDirty(true);
                            setAppPlatform(v as AppPlatform);
                          }
                        }}
                        disabled={submitting}
                      >
                        <SelectTrigger className="w-full rounded-[11px] border-[1.5px] border-[var(--chip-border)] font-semibold data-[size=default]:h-11">
                          <SelectValue placeholder="בחר פלטפורמה…">
                            {(value: string | null) =>
                              value ? APP_PLATFORM_LABEL[value as AppPlatform] : null}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {APP_PLATFORMS.map((p) => (
                            <SelectItem key={p} value={p}>{APP_PLATFORM_LABEL[p]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </ChipSection>

              {/* Section 4 — chip numbers (tone blue; ref core: add-row → tags) */}
              <ChipSection
                title="מספרי צ׳יפ"
                sub="עד 5 צ׳יפים בהנפקה אחת"
                icon={Hash}
                iconTone="blue"
              >
                <div className="space-y-[14px]">
                  {/* Add row — mono input + brand button, Enter adds (ref) */}
                  <div className="flex gap-[10px]">
                    <Input
                      value={numInput}
                      onChange={(e) => { setDirty(true); setServerError(null); setNumInput(e.target.value); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addNumber();
                        }
                      }}
                      disabled={submitting || pendingNumbers.length >= MAX_NUMBERS}
                      dir="ltr"
                      placeholder="מספר צ׳יפ"
                      aria-label="מספר צ׳יפ"
                      className={cn(INPUT_CLS, 'chip-num flex-1')}
                    />
                    <Button
                      type="button"
                      onClick={addNumber}
                      disabled={submitting || !numInput.trim() || pendingNumbers.length >= MAX_NUMBERS}
                      className="h-11 gap-2 rounded-[11px] bg-[var(--chip-brand)] px-[18px] text-[14px] font-bold text-white hover:bg-[var(--chip-brand-hover)]"
                    >
                      <Plus className="h-[17px] w-[17px]" strokeWidth={2.6} />
                      הוסף מספר
                    </Button>
                  </div>

                  {/* Pending tags (ref `.pchip` anatomy — green active tag).
                      Removal here is a typo fix on a NOT-YET-ISSUED number. */}
                  {pendingNumbers.length > 0 ? (
                    <div className="flex flex-wrap gap-[9px]">
                      {pendingNumbers.map((num) => (
                        <span
                          key={num}
                          className="inline-flex h-[38px] items-center gap-[9px] rounded-[11px] border-[1.5px] border-[var(--chip-green-border)] bg-[var(--chip-green-soft)] ps-[13px] pe-[6px]"
                        >
                          <span className="chip-num text-[14px] font-semibold tracking-[0.02em] text-[var(--chip-green-ink)]">
                            {num}
                          </span>
                          <span className="inline-flex h-[22px] items-center gap-1 rounded-[6px] bg-white px-2 text-[11px] font-bold text-[var(--chip-green-ink)]">
                            <span className="h-[6px] w-[6px] rounded-full bg-[var(--chip-green)]" />
                            להנפקה
                          </span>
                          <button
                            type="button"
                            aria-label={`הסר את המספר ${num} מהרשימה`}
                            disabled={submitting}
                            onClick={() => removePending(num)}
                            className="grid h-[30px] w-[30px] cursor-pointer place-items-center rounded-[8px] border border-[var(--chip-green-border)] bg-white text-[var(--chip-green-ink)] transition-colors hover:border-[var(--chip-red)] hover:bg-[var(--chip-red-soft)] hover:text-[var(--chip-red)]"
                          >
                            <X className="h-[15px] w-[15px]" strokeWidth={2.2} />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    !numInput.trim() && (
                      <div className="rounded-[12px] border-[1.5px] border-dashed border-[var(--chip-border-strong)] p-4 text-center text-[13px] font-semibold text-[var(--chip-ink-soft)]">
                        עדיין לא נוספו מספרי צ׳יפ
                      </div>
                    )
                  )}

                  {/* Ref caption — the no-delete product rule, stated in the UI */}
                  <div className="flex items-center gap-[6px] text-[12px] font-semibold text-[var(--chip-ink-soft)]">
                    <Info className="h-[14px] w-[14px] shrink-0" />
                    <span>צ׳יפ שהונפק לא נמחק — אפשר להשבית ולהחזיר לפעיל בכל עת.</span>
                  </div>

                  {/* Soft-limit warning + required override reason */}
                  {overLimit && (
                    <div className="space-y-2.5 rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] p-4">
                      <div className="flex items-start gap-2 text-sm font-semibold text-[var(--chip-amber-ink)]">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                          לדירה זו כבר {activeCount} צ׳יפים פעילים — הנפקה זו חורגת מהמגבלה
                          של {SOFT_LIMIT} צ׳יפים לדירה.
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
                </div>
              </ChipSection>

              {/* Section 5 — fee + notes (tone green per ref) */}
              <ChipSection title="עמלה והערות" icon={Wallet} iconTone="green">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="chip-fee" className={LABEL_CLS}>עמלת הנפקה (₪)</Label>
                    <Input
                      id="chip-fee"
                      value={fee}
                      onChange={(e) => { setDirty(true); setFee(e.target.value); }}
                      disabled={submitting}
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
                      <p className="text-right text-[12px] font-semibold text-red-500">⚠️ {feeError}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-[9px] sm:pt-8">
                    {/* Ref checkbox — 22px, radius 7, GREEN when checked */}
                    <Checkbox
                      id="chip-fee-charged"
                      checked={feeCharged}
                      onCheckedChange={(v) => { setDirty(true); setFeeCharged(v === true); }}
                      disabled={submitting}
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
                      disabled={submitting}
                      placeholder="הערות פנימיות על ההנפקה…"
                      className="min-h-[74px] rounded-[11px] border-[1.5px] border-[var(--chip-border)] px-[14px] py-[11px] text-[14px]"
                    />
                  </div>
                </div>
              </ChipSection>

              {/* Server-side 400/409/422 — inline error box (DESIGN.md error state) */}
              {serverError && (
                <div className="rounded-[11px] border border-red-400 bg-red-50 p-4 text-sm font-semibold text-red-700">
                  {serverError}
                </div>
              )}
            </div>
          </div>

          {/* Footer — ref `.mfoot`: primary at start, spacer, "סגור" at end */}
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

      {/* Dirty-guard — confirm exit without saving (Dialog is for confirmations) */}
      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>האם לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>
              הפרטים שהוזנו יימחקו והצ׳יפ לא יונפק.
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
