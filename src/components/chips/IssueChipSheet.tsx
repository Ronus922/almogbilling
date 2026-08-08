'use client';

// Issue-chip side panel — DESIGN.md §12 Sheet shell + §28.2 CREATE header +
// §28.7/§28.8 create-variant sections & fields. Flow: pick an apartment from
// the contacts registry (async combobox) → pick the chip holder (resident
// cards, snapshots editable per-chip) → chip type → 1-5 chip numbers → fee /
// notes. Soft-limit (4 active chips per contact) surfaces an amber warning +
// required override reason; server 409/422 render as an inline red box.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle, Building2, Check, ChevronsUpDown, Hash, KeyRound,
  Loader2, Plus, Search, Trash2, Users, Wallet, X,
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
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { validatePhone } from '@/lib/validation';
import { cn } from '@/lib/utils';
import { FIELD_LABEL } from '@/components/suppliers/SupplierField';
import {
  APP_PLATFORMS, APP_PLATFORM_LABEL, CHIP_RESIDENT_ROLES, CHIP_TYPE_LABEL,
  RESIDENT_ROLE_LABEL, UNIT_TYPE_LABEL,
} from '@/lib/constants/chips';
import type {
  AppPlatform, ChipResidentRole, ChipType, ContactResidentCard, ContactResidents,
} from '@/lib/types/chips';

// ── Shared field tokens (DESIGN.md §28.8) ──────────────────────────────────

const INPUT_CLS =
  'h-[42px] rounded-[10px] border-[#e2e8f0] px-[13px] text-[14px] text-[#0f172a] ' +
  'focus-visible:border-[#2563eb] focus-visible:ring-[3px] focus-visible:ring-[#2563eb]/[0.12]';

const SOFT_LIMIT = 4;

// ── Local section card (DESIGN.md §28.7 create-variant) ────────────────────

type SectionTone = 'blue' | 'amber' | 'emerald' | 'slate' | 'violet';

const SECTION_TONE: Record<SectionTone, string> = {
  blue: 'bg-[#e8f0ff] text-[#2563eb]',
  amber: 'bg-[#fff3e6] text-[#ea8a18]',
  emerald: 'bg-[#e7f7ee] text-[#16a34a]',
  slate: 'bg-[#eef2f7] text-[#475569]',
  violet: 'bg-[#eef2ff] text-[#4f46e5]',
};

function ChipSection({
  title, icon: Icon, iconTone = 'blue', children,
}: {
  title: string;
  icon: LucideIcon;
  iconTone?: SectionTone;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[14px] border border-[#e7ebf1] bg-white px-5 py-[18px]">
      <div className="mb-4 flex items-center gap-2.5">
        <span
          className={cn(
            'inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px]',
            SECTION_TONE[iconTone],
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function SectionHint({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] leading-5 text-slate-400">{children}</p>;
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

// ── Chip-number rows keep a stable id so removal doesn't remap inputs ──────

interface NumberRow {
  id: number;
  value: string;
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

  // Chip type + numbers
  const [chipType, setChipType] = useState<ChipType>('physical');
  const [appPlatform, setAppPlatform] = useState<AppPlatform>('unknown');
  const rowSeq = useRef(1);
  const [rows, setRows] = useState<NumberRow[]>([{ id: 0, value: '' }]);

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
    rowSeq.current = 1;
    setRows([{ id: 0, value: '' }]);
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

  const filledNumbers = useMemo(
    () => rows.map((r) => r.value.trim()).filter((v) => v !== ''),
    [rows],
  );

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
    filledNumbers.length <= 5 &&
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

  function setRowValue(id: number, value: string) {
    setDirty(true);
    setServerError(null);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, value } : r)));
  }

  function addRow() {
    setDirty(true);
    setRows((prev) =>
      prev.length >= 5 ? prev : [...prev, { id: rowSeq.current++, value: '' }],
    );
  }

  function removeRow(id: number) {
    setDirty(true);
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
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
        if (res.status === 409 || res.status === 422) setServerError(msg);
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
          className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          {/* Header — CREATE family (bright-blue horizontal gradient, §28.2) */}
          <SheetHeader className="flex-none gap-2 bg-[linear-gradient(to_left,#142a63_0%,#1d4ed8_70%,#2563eb_100%)] px-[26px] py-[18px] text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-[21px] font-extrabold text-white">הנפקת צ׳יפ</SheetTitle>
                <p className="mt-[3px] text-[12.5px] font-medium text-[#c7dbff]/[0.78]">
                  בחר דירה, בעל צ׳יפ ומספרי צ׳יפ — עד 5 צ׳יפים בהנפקה אחת.
                </p>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="סגור"
                disabled={submitting}
                className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] bg-white/[0.14] text-white transition-colors hover:bg-white/[0.26] disabled:opacity-60"
              >
                <X className="h-[19px] w-[19px]" strokeWidth={2.2} />
              </button>
            </div>
          </SheetHeader>

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-[#eef1f6] p-[18px]">
            <div className="space-y-[14px]">
              {/* Section 1 — apartment / unit */}
              <ChipSection title="דירה / יחידה" icon={Building2} iconTone="blue">
                <div className="space-y-1.5">
                  <Label htmlFor="chip-contact" className={FIELD_LABEL}>
                    בחירת דירה
                    <span className="text-red-500"> *</span>
                  </Label>
                  {locked ? (
                    <div className="flex min-h-[44px] items-center gap-2 rounded-[10px] border border-[#e7ebf1] bg-[#f8fafc] px-[13px] py-[10px] text-[14px] font-medium text-[#0f172a]">
                      <Building2 className="h-4 w-4 shrink-0 text-slate-400" />
                      <span>
                        דירה{' '}
                        <span dir="ltr" className="font-num tabular-nums">{contactLabel}</span>
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
                          'flex w-full items-center justify-between gap-2 border bg-white text-start transition-colors',
                          INPUT_CLS,
                          'disabled:cursor-not-allowed disabled:opacity-50',
                        )}
                      >
                        <span className={cn('truncate', contactId ? 'text-[#0f172a]' : 'text-ink-ghost')}>
                          {contactId ? contactLabel : 'בחר דירה או יחידה…'}
                        </span>
                        <ChevronsUpDown className="h-4 w-4 shrink-0 text-slate-400" />
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        sideOffset={6}
                        className="w-(--anchor-width) min-w-72 p-0"
                      >
                        <div dir="rtl" className="flex flex-col">
                          <div className="flex items-center gap-2 border-b border-slate-200 px-3">
                            {searching
                              ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" />
                              : <Search className="h-4 w-4 shrink-0 text-slate-400" />}
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
                              className="h-10 w-full bg-transparent text-sm text-slate-900 outline-none placeholder:text-ink-ghost"
                            />
                          </div>
                          <div className="max-h-64 overflow-y-auto p-1">
                            {query.trim().length < 1 ? (
                              <p className="px-3 py-6 text-center text-sm text-slate-400">
                                הקלד מספר דירה או שם דייר לחיפוש
                              </p>
                            ) : results.length === 0 ? (
                              searching ? (
                                <p className="px-3 py-6 text-center text-sm text-slate-400">מחפש…</p>
                              ) : (
                                <div className="space-y-1">
                                  <p className="px-3 pb-1 pt-4 text-center text-sm text-slate-400">
                                    לא נמצאו תוצאות
                                  </p>
                                  {/* Inline registry create — action row (min 44px touch target) */}
                                  <button
                                    type="button"
                                    onClick={() => void createApartmentFromQuery()}
                                    disabled={creating}
                                    className="flex min-h-[44px] w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm font-semibold text-blue-600 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    {creating ? (
                                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                                    ) : (
                                      <Plus className="h-4 w-4 shrink-0" />
                                    )}
                                    <span className="min-w-0 flex-1">
                                      דירה{' '}
                                      <span dir="ltr" className="font-num tabular-nums">
                                        {query.trim()}
                                      </span>{' '}
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
                                      'flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm transition-colors',
                                      isSel ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50',
                                    )}
                                  >
                                    <Check
                                      className={cn(
                                        'h-4 w-4 shrink-0',
                                        isSel ? 'text-blue-600 opacity-100' : 'opacity-0',
                                      )}
                                    />
                                    <span dir="ltr" className="font-num font-bold tabular-nums text-slate-900">
                                      {item.apartment_number}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-slate-600">
                                      {item.owner_name || item.tenant_name || '—'}
                                    </span>
                                    {item.unit_type !== 'apartment' && (
                                      <span className="inline-flex shrink-0 items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                                        {UNIT_TYPE_LABEL[item.unit_type] ?? item.unit_type}
                                      </span>
                                    )}
                                    {item.needs_review && (
                                      <span className="inline-flex shrink-0 items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
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

              {/* Section 2 — chip holder */}
              {contactId && (
                <ChipSection title="בעל הצ׳יפ" icon={Users} iconTone="violet">
                  <div className="space-y-4">
                    {residentsLoading ? (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="h-20 animate-pulse rounded-[12px] bg-muted/60" />
                        <div className="h-20 animate-pulse rounded-[12px] bg-muted/60" />
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {residentCards.map((card) => {
                          const livesHere = residents?.resident_type === card.role;
                          const selected = role === card.role;
                          if (!card.exists) {
                            return (
                              <div
                                key={card.role}
                                className="flex flex-col gap-1 rounded-[12px] border border-dashed border-slate-200 bg-slate-50/60 p-4"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-sm font-bold text-slate-400">
                                    {RESIDENT_ROLE_LABEL[card.role]}
                                  </span>
                                  {livesHere && (
                                    <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                                      גר בדירה
                                    </span>
                                  )}
                                </div>
                                <span className="text-sm text-slate-400">לא הוזנו פרטים</span>
                                <Link
                                  href="/contacts"
                                  className="text-sm font-semibold text-blue-600 hover:text-blue-700"
                                >
                                  השלם פרטים
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
                                'flex flex-col gap-1 rounded-[12px] border p-4 text-start transition-colors',
                                selected
                                  ? 'border-blue-500 bg-blue-50'
                                  : 'border-slate-200 bg-white hover:bg-slate-50',
                              )}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-bold text-slate-900">
                                  {RESIDENT_ROLE_LABEL[card.role]}
                                </span>
                                {livesHere && (
                                  <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                                    גר בדירה
                                  </span>
                                )}
                              </div>
                              <span className="text-sm font-medium text-slate-700">{card.name}</span>
                              {card.phone && (
                                <span dir="ltr" className="font-num text-end text-sm tabular-nums text-slate-500">
                                  {card.phone}
                                </span>
                              )}
                            </button>
                          );
                        })}
                        {/* 4th card — free entry */}
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={selectOther}
                          className={cn(
                            'flex flex-col gap-1 rounded-[12px] border p-4 text-start transition-colors',
                            role === 'other'
                              ? 'border-blue-500 bg-blue-50'
                              : 'border-slate-200 bg-white hover:bg-slate-50',
                          )}
                        >
                          <span className="text-sm font-bold text-slate-900">אחר</span>
                          <span className="text-sm text-slate-500">הזנה חופשית של שם וטלפון</span>
                        </button>
                      </div>
                    )}

                    {/* Holder snapshot — editable, applies to this chip only */}
                    <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="chip-holder-name" className={FIELD_LABEL}>שם בעל הצ׳יפ</Label>
                        <Input
                          id="chip-holder-name"
                          value={holderName}
                          onChange={(e) => { setDirty(true); setHolderName(e.target.value); }}
                          disabled={submitting}
                          placeholder="שם מלא"
                          className={INPUT_CLS}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="chip-holder-phone" className={FIELD_LABEL}>טלפון בעל הצ׳יפ</Label>
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
                            'font-num tabular-nums',
                            phoneTouched && phoneError &&
                              'border-red-400 bg-red-50 focus-visible:border-red-400 focus-visible:ring-red-200',
                          )}
                        />
                        {phoneTouched && phoneError && (
                          <p className="text-right text-[12px] font-semibold text-red-500">⚠️ {phoneError}</p>
                        )}
                      </div>
                    </div>
                    <SectionHint>
                      שינוי השם או הטלפון כאן חל על הצ׳יפ הזה בלבד — מרשם הדיירים לא מתעדכן.
                    </SectionHint>
                  </div>
                </ChipSection>
              )}

              {/* Section 3 — chip type */}
              <ChipSection title="סוג צ׳יפ" icon={KeyRound} iconTone="amber">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {(['physical', 'app'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        disabled={submitting}
                        onClick={() => { setDirty(true); setChipType(t); }}
                        className={cn(
                          'inline-flex h-10 items-center rounded-full px-5 text-[13.5px] transition-colors',
                          chipType === t
                            ? 'bg-[#2563eb] font-bold text-white'
                            : 'border border-[#e2e8f0] bg-white font-semibold text-[#475569] hover:bg-slate-50',
                        )}
                      >
                        {CHIP_TYPE_LABEL[t]}
                      </button>
                    ))}
                  </div>
                  {chipType === 'app' && (
                    <div className="space-y-1.5 sm:max-w-xs">
                      <Label className={FIELD_LABEL}>פלטפורמה</Label>
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
                        <SelectTrigger className="w-full rounded-[10px] border-[#e2e8f0] data-[size=default]:h-[42px]">
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

              {/* Section 4 — chip numbers */}
              <ChipSection title="מספרי צ׳יפ" icon={Hash} iconTone="slate">
                <div className="space-y-2.5">
                  {rows.map((row, i) => (
                    <div key={row.id} className="flex items-center gap-2">
                      <Input
                        value={row.value}
                        onChange={(e) => setRowValue(row.id, e.target.value)}
                        disabled={submitting}
                        dir="ltr"
                        placeholder="מספר צ׳יפ"
                        aria-label={`מספר צ׳יפ ${i + 1}`}
                        className={cn(INPUT_CLS, 'flex-1 font-num tabular-nums')}
                      />
                      {rows.length > 1 && (
                        <button
                          type="button"
                          aria-label="הסר שורה"
                          disabled={submitting}
                          onClick={() => removeRow(row.id)}
                          className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[10px] border border-[#e2e8f0] text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={addRow}
                    disabled={rows.length >= 5 || submitting}
                    className="gap-2"
                  >
                    <Plus className="h-4 w-4" />
                    הוסף מספר
                  </Button>

                  {/* Soft-limit warning + required override reason */}
                  {overLimit && (
                    <div className="space-y-2.5 rounded-[10px] border border-amber-200 bg-amber-50 p-4">
                      <div className="flex items-start gap-2 text-sm font-semibold text-amber-900">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                        <span>
                          לדירה זו כבר {activeCount} צ׳יפים פעילים — הנפקה זו חורגת מהמגבלה
                          של {SOFT_LIMIT} צ׳יפים לדירה.
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="chip-override" className={FIELD_LABEL}>
                          סיבת חריגה
                          <span className="text-red-500"> *</span>
                        </Label>
                        <Textarea
                          id="chip-override"
                          value={overrideReason}
                          onChange={(e) => { setDirty(true); setOverrideReason(e.target.value); }}
                          disabled={submitting}
                          placeholder="לדוגמה: משפחה מורחבת, עובד סיעודי…"
                          className="min-h-[74px] rounded-[10px] border-[#e2e8f0] bg-white px-[13px] py-[11px] text-[14px]"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </ChipSection>

              {/* Section 5 — fee + notes */}
              <ChipSection title="עמלה והערות" icon={Wallet} iconTone="emerald">
                <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="chip-fee" className={FIELD_LABEL}>עמלת הנפקה (₪)</Label>
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
                        'font-num tabular-nums',
                        feeError &&
                          'border-red-400 bg-red-50 focus-visible:border-red-400 focus-visible:ring-red-200',
                      )}
                    />
                    {feeError && (
                      <p className="text-right text-[12px] font-semibold text-red-500">⚠️ {feeError}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 sm:pt-7">
                    <Checkbox
                      id="chip-fee-charged"
                      checked={feeCharged}
                      onCheckedChange={(v) => { setDirty(true); setFeeCharged(v === true); }}
                      disabled={submitting}
                    />
                    <Label
                      htmlFor="chip-fee-charged"
                      className="cursor-pointer text-sm font-medium text-slate-700"
                    >
                      החיוב בוצע
                    </Label>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="chip-notes" className={FIELD_LABEL}>הערה</Label>
                    <Textarea
                      id="chip-notes"
                      value={notes}
                      onChange={(e) => { setDirty(true); setNotes(e.target.value); }}
                      disabled={submitting}
                      placeholder="הערות פנימיות על ההנפקה…"
                      className="min-h-[74px] rounded-[10px] border-[#e2e8f0] px-[13px] py-[11px] text-[14px]"
                    />
                  </div>
                </div>
              </ChipSection>

              {/* Server-side 409/422 — inline error box */}
              {serverError && (
                <div className="rounded-[10px] border border-red-400 bg-red-50 p-4 text-sm font-semibold text-red-700">
                  {serverError}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <PanelFooter
            onClose={requestClose}
            onSave={handleSubmit}
            saveDisabled={!canSubmit}
            saveLabel={submitting ? 'מנפיק…' : 'הנפק צ׳יפ'}
            saveClassName="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-[0_6px_16px_rgba(37,99,235,0.28)]"
          />
        </SheetContent>
      </Sheet>

      {/* Dirty-guard — confirm exit without saving */}
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
