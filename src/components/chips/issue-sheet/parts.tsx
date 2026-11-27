'use client';

// Shared pieces of the chip issue window (v2 design of 24/11/2026,
// ref/chip-order/chip-issue-admin-v2.html, styles in app/styles/chip-issue-sheet.css):
// the sheet frame (header / scrolling body / footer), a section, a holder
// block, the role buttons, and the chip allocation of one person — add a
// number (card / app, "הוסף" or Enter), the person's chips as rows with an
// active / disabled switch, and the inline number fix (click the number).
// Used by BOTH modes of the window (with and without an order).

import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Loader2, X } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import type { ChipStatus, ChipType } from '@/lib/types/chips';

// ── Icons of the reference ──────────────────────────────────────────────────

/** `join={false}` — the few icons the reference draws without round joins. */
export function Ico({ size = 16, sw = 1.9, join = true, children }: { size?: number; sw?: number; join?: boolean; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round"
      strokeLinejoin={join ? 'round' : undefined} aria-hidden="true">
      {children}
    </svg>
  );
}
export const CardIco = () => <Ico size={12}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></Ico>;
export const AppIco = () => <Ico size={12}><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></Ico>;
export const UsersIco = () => (
  <Ico><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></Ico>
);
export const WalletIco = () => (
  <Ico><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4Z" /></Ico>
);
export const BuildingIco = () => <Ico><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1M9 13h1m4 0h1M9 17h1m4 0h1" /></Ico>;
export const TrashIco = ({ size = 15 }: { size?: number }) => (
  <Ico size={size}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></Ico>
);
/** 14px in "הוסף", 15px in "הוסף בעל צ׳יפ" — the reference's two sizes. */
export const PlusIco = ({ size = 14 }: { size?: number }) => <Ico size={size} sw={2.4} join={false}><path d="M12 5v14M5 12h14" /></Ico>;
export const SaveIco = () => <Ico size={16} sw={2}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8M7 3v5h8" /></Ico>;
export const CheckIco = () => <Ico size={14} sw={2.4}><path d="M20 6 9 17l-5-5" /></Ico>;
/** The circled "!" of the amber note (14px) and of the hint line (12px). */
export const AlertIco = ({ size = 14 }: { size?: number }) => <Ico size={size} sw={2} join={false}><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></Ico>;
/** The pencil of "עדכן בכרטיס הדייר". */
export const PencilIco = () => <Ico size={13}><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></Ico>;
const MarkIco = () => <Ico size={20}><path d="M14 4.1 12 6M5.1 8 2.8 10.3a3 3 0 0 0 0 4.2l6.7 6.7a3 3 0 0 0 4.2 0L16 19M15 9l6-6M9 15l6-6" /></Ico>;

// ── Frame ────────────────────────────────────────────────────────────────────

export function IssueSheetFrame({
  open, onRequestClose, closeDisabled, footer, children,
}: {
  open: boolean;
  onRequestClose: () => void;
  closeDisabled?: boolean;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onRequestClose(); }}>
      {/* The width lives in chip-issue-sheet.css (`.ci-panel`): 60% of the viewport
          (--ci-panel-w), never under 780px (--ci-panel-min), never wider than the
          screen — anchored to the left edge. */}
      <SheetContent
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="ci-skin ci-panel flex flex-col gap-0 overflow-hidden p-0 data-[side=left]:border-r-0"
      >
        <header className="ci-head">
          <span className="ci-mic"><MarkIco /></span>
          <div className="min-w-0 flex-1">
            <SheetTitle className="m-0 text-[19px] leading-[normal] font-extrabold text-white">הנפקת צ׳יפ</SheetTitle>
            <p>דירה אחת · כמה בעלי צ׳יפ · לכל אחד הצ׳יפים שלו</p>
          </div>
          <button type="button" className="ci-close" aria-label="סגירה" title="סגירה" disabled={closeDisabled} onClick={onRequestClose}>
            <Ico size={16} sw={2.2} join={false}><path d="M18 6 6 18M6 6l12 12" /></Ico>
          </button>
        </header>
        <div className="ci-body" data-testid="chip-issue-body">{children}</div>
        <footer className="ci-foot">{footer}</footer>
      </SheetContent>
    </Sheet>
  );
}

export function IssueSheetFooter({ onSave, saveDisabled, saving, onClose, closeDisabled }: {
  onSave: () => void;
  saveDisabled: boolean;
  saving: boolean;
  onClose: () => void;
  closeDisabled?: boolean;
}) {
  // The reference's order: "סגור" first, the footer packs to the end — so
  // "שמור שינויים" sits at the left edge and "סגור" right beside it.
  return (
    <>
      <button type="button" className="ci-cancel" onClick={onClose} disabled={closeDisabled} data-testid="chip-issue-close">סגור</button>
      <button type="button" className="ci-save" onClick={onSave} disabled={saveDisabled} data-testid="chip-issue-save">
        {saving ? <Loader2 className="ci-spin h-4 w-4" /> : <SaveIco />}
        {saving ? 'שומר…' : 'שמור שינויים'}
      </button>
    </>
  );
}

export function DiscardDialog({ open, onOpenChange, onDiscard }: { open: boolean; onOpenChange: (o: boolean) => void; onDiscard: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>האם לצאת ללא שמירה?</AlertDialogTitle>
          <AlertDialogDescription>המספרים הממתינים יימחקו ולא יונפקו. צ׳יפים קיימים לא מושפעים.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
          <AlertDialogAction onClick={onDiscard} className="bg-destructive text-white hover:bg-destructive/90">צא ללא שמירה</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function Section({ icon, tone, title, sub, children }: {
  icon: ReactNode;
  tone?: 'green';
  title: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <section className="ci-sec">
      <div className="ci-shead">
        <span className={cn('ci-sic', tone === 'green' && 'ci-green')}>{icon}</span>
        <div><b>{title}</b>{sub && <small>{sub}</small>}</div>
      </div>
      <div className="ci-sbody">{children}</div>
    </section>
  );
}

export function AmberNote({ children }: { children: ReactNode }) {
  return (
    <div className="ci-note">
      <AlertIco />
      <span>{children}</span>
    </div>
  );
}

// ── Holder block ────────────────────────────────────────────────────────────

/** The window's names of the roles. The fourth state of "אני" is "אורח" (v2
 *  reference) — the stored value stays `other`; nothing in the schema moved. */
export const ROLE_SHORT: Record<string, string> = {
  owner: 'בעלים', tenant: 'שוכר', operator: 'מפעיל', other: 'אורח', staff: 'צוות',
};

/** The role tag: owner = brand, renter = amber, everyone else = grey. */
export function roleTone(role: string | null): 'ci-renter' | 'ci-other' | undefined {
  if (role === 'tenant') return 'ci-renter';
  return role === 'owner' ? undefined : 'ci-other';
}

export function HolderBlock({
  index, name, role, apartment, onRemove, removeDisabled, removeTitle, children,
}: {
  index: number;
  name: string;
  role: string | null;
  apartment: string | null;
  onRemove?: () => void;
  removeDisabled?: boolean;
  removeTitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="ci-block" data-testid="chip-holder-block">
      <div className="ci-bhead">
        <span className="ci-avnum ci-num">{index + 1}</span>
        <b>{name.trim() || 'בעל צ׳יפ חדש'}</b>
        {role && <span className={cn('ci-rolechip', roleTone(role))}>{ROLE_SHORT[role] ?? role}</span>}
        {apartment && <span className="ci-meta">דירה <span className="ci-num">{apartment}</span></span>}
        {onRemove && (
          <button type="button" className="ci-bdel" title={removeTitle ?? 'הסרה'} aria-label={`הסרת בעל צ׳יפ ${index + 1}`}
            disabled={removeDisabled} onClick={onRemove}>
            <TrashIco />
          </button>
        )}
      </div>
      <div className="ci-bbody">{children}</div>
    </div>
  );
}

export interface RoleOption {
  value: string;
  label: string;
  disabled?: boolean;
  title?: string;
}

export function RoleSegment({ label = 'אני', options, value, onChange, disabled }: {
  label?: string;
  options: RoleOption[];
  value: string | null;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ci-fld">
      <span className="ci-lbl ci-strong">{label}</span>
      <div className="ci-roleseg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.title}
            className={cn(value === o.value && 'ci-on')} disabled={disabled || (o.disabled && value !== o.value)}
            onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Immediate actions on a saved chip (toggle, number fix) ──────────────────

export interface SavedChipLike {
  id: string;
  chip_number: string;
  chip_type: ChipType;
  status: ChipStatus;
  /** Decision 3.6: why a disabled chip may not be switched on again. */
  reactivation_lock?: string | null;
}

/**
 * The two IMMEDIATE actions on a saved chip, the same in both modes: the
 * active / disabled switch (switching OFF asks once — reason 'unknown', the
 * schema needs one — switching ON asks nothing) and the number fix (click the
 * number, edit inline, Enter / blur saves; 409 when another active chip holds
 * it). Optimistic: the row changes at once and rolls back on a failure.
 * `version` changes whenever the parent reloads its chips — the optimistic
 * overrides of older data stop applying.
 */
export function useChipQuickActions(version: number, onChanged: () => void) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [over, setOver] = useState<{ v: number; map: Record<string, Partial<SavedChipLike>> }>({ v: version, map: {} });
  const [edit, setEditState] = useState<{ chipId: string; value: string } | null>(null);
  const editRef = useRef<{ chipId: string; value: string } | null>(null);
  const setEdit = (e: { chipId: string; value: string } | null) => { editRef.current = e; setEditState(e); };
  const map = over.v === version ? over.map : {};
  const patch = (id: string, p: Partial<SavedChipLike> | null) =>
    setOver((o) => {
      const base = o.v === version ? { ...o.map } : {};
      if (p) base[id] = { ...base[id], ...p };
      else delete base[id];
      return { v: version, map: base };
    });

  function view<T extends SavedChipLike>(c: T): T {
    return { ...c, ...map[c.id] };
  }

  async function toggle(chip: SavedChipLike, blocked: boolean) {
    if (busyId || blocked) return;
    const cur = view(chip);
    const wasActive = cur.status === 'active';
    if (wasActive && !window.confirm(`להשבית את צ׳יפ ${cur.chip_number}?`)) return;
    setBusyId(chip.id);
    patch(chip.id, { status: wasActive ? 'inactive' : 'active' });
    try {
      const res = await fetch(`/api/chips/${chip.id}/${wasActive ? 'deactivate' : 'reactivate'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(wasActive ? { reason: 'unknown' } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as { chip?: unknown; error?: string };
      if (!res.ok || !data.chip) throw new Error(data.error ?? (wasActive ? 'ההשבתה נכשלה' : 'ההפעלה נכשלה'));
      toast.success(wasActive ? 'הצ׳יפ הושבת' : 'הצ׳יפ הופעל');
      onChanged();
    } catch (e) {
      patch(chip.id, null);
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  /** Commit the inline fix. `inWindow(n)` — the number is already in the window. */
  async function commitNumber(chips: SavedChipLike[], inWindow: (n: string, chipId: string) => boolean, blocked: boolean) {
    const e = editRef.current;
    if (!e) return;
    setEdit(null);
    const chip = chips.find((c) => c.id === e.chipId);
    if (!chip || busyId || blocked) return;
    const next = e.value.trim();
    const cur = view(chip).chip_number;
    if (!next || next === cur) return;
    if (inWindow(next, chip.id)) {
      toast.error(`המספר ${next} כבר נמצא בחלון הזה`);
      return;
    }
    setBusyId(chip.id);
    patch(chip.id, { chip_number: next });
    try {
      const res = await fetch(`/api/chips/${chip.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ chip_number: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { chip?: unknown; error?: string };
      if (!res.ok || !data.chip) throw new Error(data.error ?? 'תיקון המספר נכשל');
      toast.success('המספר תוקן');
      onChanged();
    } catch (err) {
      patch(chip.id, null);
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return { busyId, edit, setEdit, view, toggle, commitNumber };
}

// ── The chip allocation of one person ───────────────────────────────────────

export interface PendingChip {
  number: string;
  chip_type: ChipType;
}

export function ChipAllocation({
  title, sub, assigned, of, firstName,
  numInput, onNumInput, numType, onNumType, onAdd, addBlocked,
  saved, existing, extras, pending, conflictNumber, dupHint, disabled,
  quick, onToggle, onCommitNumber, onRemovePending,
}: {
  title: string;
  sub?: ReactNode;
  /** Active chips counted for this person (saved active + pending). */
  assigned: number;
  /** What was ordered for this person; null = no ordered quantity (no counter "מתוך"). */
  of: number | null;
  firstName: string | null;
  numInput: string;
  onNumInput: (v: string) => void;
  numType: ChipType;
  onNumType: (t: ChipType) => void;
  onAdd: () => void;
  /** The add row is full (most new numbers per save). */
  addBlocked?: boolean;
  saved: SavedChipLike[];
  /** Earlier chips of the same person (order mode) — tagged "קודם". */
  existing?: SavedChipLike[];
  /** Extra chips added for the person beyond what the order paid for, and
   *  paid at the reception (order mode) — tagged "נוסף · קבלה". */
  extras?: SavedChipLike[];
  pending: PendingChip[];
  conflictNumber?: string | null;
  dupHint?: string | null;
  disabled: boolean;
  quick: ReturnType<typeof useChipQuickActions>;
  onToggle: (chip: SavedChipLike) => void;
  onCommitNumber: () => void;
  onRemovePending: (n: string) => void;
}) {
  const full = of !== null ? assigned >= of && of > 0 : assigned > 0;
  const rows: { chip: SavedChipLike; earlier: boolean; extra?: boolean }[] = [
    ...saved.map((c) => ({ chip: c, earlier: false })),
    ...(extras ?? []).map((c) => ({ chip: c, earlier: false, extra: true })),
    ...(existing ?? []).map((c) => ({ chip: c, earlier: true })),
  ];
  return (
    <div className="ci-chipsec">
      <div className="ci-cshead">
        <b>{title}</b>
        {sub && <small>{sub}</small>}
        <span className={cn('ci-alloc', full && 'ci-full')} data-testid="chip-alloc-counter">
          שויכו <span className="ci-num">{assigned}</span>{of !== null && <> מתוך <span className="ci-num">{of}</span></>}
        </span>
      </div>
      <div className="ci-addrow">
        <div className="ci-fld">
          <input
            type="text"
            inputMode="numeric"
            className="ci-num ci-ltr"
            value={numInput}
            disabled={disabled || addBlocked}
            placeholder={firstName ? `מספר צ׳יפ ייעודי ל${firstName}` : 'מספר צ׳יפ'}
            aria-label={firstName ? `מספר צ׳יפ ל${firstName}` : 'מספר צ׳יפ'}
            onChange={(e) => onNumInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); } }}
          />
        </div>
        <div className="ci-kindseg" role="radiogroup" aria-label="סוג">
          {(['physical', 'app'] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={numType === t} className={cn(numType === t && 'ci-on')}
              disabled={disabled} onClick={() => onNumType(t)}>
              {t === 'physical' ? <CardIco /> : <AppIco />}
              {t === 'physical' ? 'כרטיס' : 'אפליקציה'}
            </button>
          ))}
        </div>
        <button type="button" className="ci-addbtn" disabled={disabled || addBlocked || !numInput.trim()} onClick={onAdd}>
          <PlusIco />
          הוסף
        </button>
      </div>
      {dupHint && <p className="ci-err mt-2">⚠️ {dupHint}</p>}
      <div className="ci-chiplist">
        {rows.length === 0 && pending.length === 0 ? (
          <div className="ci-chipempty">עדיין לא הונפקו צ׳יפים ל{firstName ?? 'בעל הצ׳יפ'}</div>
        ) : (
          <>
            {rows.map(({ chip: raw, earlier, extra }) => {
              const chip = quick.view(raw);
              const on = chip.status === 'active';
              const busy = quick.busyId === chip.id;
              const lock = raw.reactivation_lock ?? null;
              return (
                <div key={chip.id} className={cn('ci-chiprow', !on && 'ci-off')}>
                  {quick.edit?.chipId === chip.id ? (
                    <input
                      autoFocus
                      className="ci-cnumedit"
                      value={quick.edit.value}
                      aria-label={`תיקון מספר צ׳יפ ${chip.chip_number}`}
                      onChange={(e) => quick.setEdit({ chipId: chip.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); onCommitNumber(); }
                        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); quick.setEdit(null); }
                      }}
                      onBlur={onCommitNumber}
                    />
                  ) : (
                    <button type="button" className="ci-cnum" title="לחיצה לתיקון המספר" aria-label={`תקן את המספר ${chip.chip_number}`}
                      disabled={disabled || quick.busyId !== null} onClick={() => quick.setEdit({ chipId: chip.id, value: chip.chip_number })}>
                      {chip.chip_number}
                    </button>
                  )}
                  <span className="ci-kind">{chip.chip_type === 'app' ? <AppIco /> : <CardIco />}{chip.chip_type === 'app' ? 'אפליקציה' : 'כרטיס'}</span>
                  {earlier && <span className="ci-tag-mini" title="צ׳יפ קודם של אותו אדם בדירה — לא חלק מההזמנה">קודם</span>}
                  {extra && <span className="ci-tag-mini" title="צ׳יפ שנוסף מעבר לכמות ששולמה באתר, ושולם בקבלה — שייך להזמנת קבלה נפרדת" data-testid="chip-extra-tag">נוסף · קבלה</span>}
                  <button type="button" className="ci-tgl" aria-pressed={on}
                    aria-label={on ? `השבת את ${chip.chip_number}` : lock ? `${chip.chip_number}: ${lock}` : `החזר לפעיל את ${chip.chip_number}`}
                    title={!on && lock ? lock : undefined}
                    data-locked={!on && lock ? 'true' : undefined}
                    disabled={disabled || quick.busyId !== null || (!on && !!lock)} onClick={() => onToggle(raw)}>
                    {busy ? <Loader2 className="ci-spin h-3.5 w-3.5" /> : on ? 'פעיל' : 'מושבת'}
                    <span className="ci-sw" />
                  </button>
                  {!on && lock && <span className="ci-lockwhy" data-testid="chip-reactivation-lock">{lock}</span>}
                </div>
              );
            })}
            {pending.map((p) => {
              const conflict = conflictNumber === p.number;
              return (
                <div key={p.number} className={cn('ci-chiprow ci-pending', conflict && 'ci-conflict')}>
                  <span className="ci-num ci-pnum">{p.number}</span>
                  <span className="ci-kind">{p.chip_type === 'app' ? <AppIco /> : <CardIco />}{p.chip_type === 'app' ? 'אפליקציה' : 'כרטיס'}</span>
                  <span className={cn('ci-tag-mini', conflict ? 'ci-red' : 'ci-amber')}>{conflict ? 'מספר תפוס' : 'ממתין לשמירה'}</span>
                  <button type="button" className="ci-rm" title="הסר (טרם נשמר)" aria-label={`הסר את המספר ${p.number} מהרשימה`}
                    disabled={disabled} onClick={() => onRemovePending(p.number)}>
                    <X className="h-3 w-3" strokeWidth={2.4} />
                  </button>
                </div>
              );
            })}
          </>
        )}
      </div>
      <div className="ci-chiphint">
        <AlertIco size={12} />
        <span>צ׳יפ שהונפק לא נמחק — משביתים ומחזירים לפעיל במתג, ומתקנים מספר בלחיצה עליו.</span>
      </div>
    </div>
  );
}
