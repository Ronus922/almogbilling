'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// One cell of the /parking table — the numbers an apartment (or חוף הכרמל /
// נציגות) holds, and the whole editor for them.
//
// There is no pencil and no actions column: the cell IS the control. It marks
// itself on hover, opens on click, and closes on Enter or a click outside.
// Escape puts back what was there.
//
// The component knows nothing about spots or units. It edits a list of numbers
// and hands the result to the page, which owns the rows and does the writing —
// so the same cell serves parking (where a number can be double) and storage
// (where it cannot).

export type AssetCellKind = 'parking' | 'storage';

/** One number inside a cell. */
export interface CellItem {
  /** Stable React key — client-only. */
  key: string;
  /** The row that already carries this number, or null for a number typed here. */
  id: string | null;
  number: string;
  /** Parking only. null = "the user did not say": a number that turns out to
   *  belong to an existing spot keeps that spot's own shape. */
  double: boolean | null;
}

/**
 * What the page makes of a saved cell. A number already held elsewhere is not a
 * refusal here — the table sees both sides of the move, so it asks.
 */
export type CellSaveResult =
  | { status: 'ok' }
  | { status: 'confirm'; itemKey: string; question: string }
  | { status: 'error'; message: string };

export function AssetCell({
  kind,
  items,
  editable,
  editing,
  onOpen,
  onClose,
  onSave,
}: {
  kind: AssetCellKind;
  items: CellItem[];
  editable: boolean;
  editing: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSave: (draft: CellItem[], approved: Set<string>) => Promise<CellSaveResult>;
}) {
  const [draft, setDraft] = useState<CellItem[]>(items);
  const [addValue, setAddValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<{ itemKey: string; question: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  /** The typed numbers the user has already agreed to take from their current
   *  holder, by item key. Lives for one edit session — cleared on every open. */
  const approvedRef = useRef<Set<string>>(new Set());
  /** Makes each typed number a distinct item even when the text repeats. */
  const seqRef = useRef(0);
  /** Mirrors of the live values, so the outside-click listener (bound once) is
   *  never reading a stale draft. */
  const stateRef = useRef({ draft, addValue, saving });
  stateRef.current = { draft, addValue, saving };

  // Opening resets everything: the draft starts from what the cell shows.
  useEffect(() => {
    if (!editing) return;
    setDraft(items);
    setAddValue('');
    setError(null);
    setQuestion(null);
    approvedRef.current = new Set();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on open only; `items` moves as the page saves.
  }, [editing]);

  const label = kind === 'parking' ? 'חניה' : 'מחסן';

  const run = useCallback(async (rows: CellItem[]) => {
    setSaving(true);
    setError(null);
    try {
      const result = await onSave(rows, approvedRef.current);
      if (result.status === 'ok') { onClose(); return; }
      if (result.status === 'confirm') { setQuestion({ itemKey: result.itemKey, question: result.question }); return; }
      setError(result.message);
      setQuestion(null);
    } finally {
      setSaving(false);
    }
  }, [onSave, onClose]);

  /** Fold whatever sits in the "add" box into the draft, then save. */
  const commitAndSave = useCallback(async () => {
    if (stateRef.current.saving) return;
    const pending = stateRef.current.addValue.trim();
    const rows = pending
      ? [...stateRef.current.draft, { key: `new-${seqRef.current++}`, id: null, number: pending, double: null as boolean | null }]
      : stateRef.current.draft;
    if (pending) { setDraft(rows); setAddValue(''); }
    await run(rows);
  }, [run]);

  // A click anywhere outside the cell saves it — the same as pressing Enter.
  useEffect(() => {
    if (!editing) return;
    function onPointerDown(e: MouseEvent) {
      if (boxRef.current?.contains(e.target as Node)) return;
      void commitAndSave();
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [editing, commitAndSave]);

  useEffect(() => {
    if (editing) addRef.current?.focus();
  }, [editing]);

  // ── read mode ──────────────────────────────────────────────────────────────

  if (!editing) {
    const body = items.length === 0
      ? <span className="text-slate-400">—</span>
      : (
        // A comma-separated list of numbers is LTR text inside an RTL page: left
        // to itself the bidi algorithm moves the commas to the wrong side and
        // reverses "163×2". The box still sits at the start (right) of the cell.
        <span dir="ltr" className="inline-flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
          {items.map((it, i) => (
            <span key={it.key} className="tabular-nums">
              {it.number}
              {it.double ? <span className="text-[11px] font-bold text-blue-600">×2</span> : null}
              {i < items.length - 1 ? <span className="text-slate-400">,</span> : null}
            </span>
          ))}
        </span>
      );

    if (!editable) return <span className="text-sm text-slate-700">{body}</span>;

    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={`ערוך ${kind === 'parking' ? 'חניות' : 'מחסנים'}`}
        className="-mx-2 -my-1 w-full rounded-md border border-transparent px-2 py-1 text-start text-sm text-slate-700 transition-colors hover:border-slate-300 hover:bg-white"
      >
        {body}
      </button>
    );
  }

  // ── edit mode ──────────────────────────────────────────────────────────────

  function updateItem(key: string, patch: Partial<CellItem>) {
    setDraft((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
    setError(null);
    setQuestion(null);
  }

  function removeItem(key: string) {
    setDraft((prev) => prev.filter((it) => it.key !== key));
    setError(null);
    setQuestion(null);
  }

  function addPending() {
    const raw = addValue.trim();
    if (!raw) return;
    setDraft((prev) => [...prev, { key: `new-${seqRef.current++}`, id: null, number: raw, double: null }]);
    setAddValue('');
    setError(null);
    setQuestion(null);
    addRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); void commitAndSave(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }

  return (
    <div ref={boxRef} onKeyDown={onKeyDown} className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {draft.map((it) => (
          <span
            key={it.key}
            className="inline-flex h-9 items-center gap-0.5 rounded-md border border-slate-300 bg-white ps-2 pe-1"
          >
            <input
              value={it.number}
              onChange={(e) => updateItem(it.key, { number: e.target.value })}
              inputMode="numeric"
              aria-label={`מספר ${label}`}
              className="h-7 w-12 bg-transparent text-sm tabular-nums text-slate-900 outline-none"
            />
            {kind === 'parking' && (
              <button
                type="button"
                onClick={() => updateItem(it.key, { double: !it.double })}
                title="חניה כפולה"
                dir="ltr"
                aria-pressed={!!it.double}
                className={cn(
                  'inline-flex h-8 w-8 items-center justify-center rounded text-[11px] font-bold transition-colors',
                  it.double
                    ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                    : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600',
                )}
              >
                ×2
              </button>
            )}
            <button
              type="button"
              onClick={() => removeItem(it.key)}
              aria-label={`הסר ${label} ${it.number}`}
              className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}

        <span className="inline-flex h-9 items-center rounded-md border border-dashed border-slate-300 bg-white ps-2 pe-1">
          <input
            ref={addRef}
            value={addValue}
            onChange={(e) => { setAddValue(e.target.value); setError(null); setQuestion(null); }}
            inputMode={kind === 'parking' ? 'numeric' : 'text'}
            placeholder="הוסף"
            aria-label={`הוסף ${label}`}
            className="h-7 w-14 bg-transparent text-sm tabular-nums text-slate-900 outline-none placeholder:text-slate-400"
          />
          <button
            type="button"
            onClick={addPending}
            aria-label="הוסף לרשימה"
            className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <Plus className="h-4 w-4" />
          </button>
        </span>
      </div>

      {question && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">
          <span>{question.question}</span>
          <button
            type="button"
            onClick={() => { approvedRef.current.add(question.itemKey); setQuestion(null); void commitAndSave(); }}
            className="inline-flex h-7 items-center gap-1 rounded bg-amber-600 px-2 font-semibold text-white transition-colors hover:bg-amber-700"
          >
            <Check className="h-3.5 w-3.5" /> העבר
          </button>
          <button
            type="button"
            onClick={() => { setDraft((prev) => prev.filter((it) => it.key !== question.itemKey)); setQuestion(null); }}
            className="inline-flex h-7 items-center rounded px-2 font-semibold text-amber-800 transition-colors hover:bg-amber-100"
          >
            ביטול
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs font-medium text-red-700">
          {error}
        </p>
      )}

      {saving && <p className="text-xs text-slate-400">שומר…</p>}
    </div>
  );
}
