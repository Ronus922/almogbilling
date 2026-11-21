'use client';

// The apartment picker of one order row (20/11/2026 design, `.combo` of the
// reference): a button that opens a panel with a search box and the list of
// apartment NUMBERS. Search is by number only — the public page never receives
// a name (listOrderableApartments returns numbers only).

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export function ApartmentCombo({
  apartments, value, onChange, open, onOpenChange, disabled, invalid, label,
}: {
  apartments: readonly string[];
  value: string;
  onChange: (apartment: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  invalid?: boolean;
  /** Accessible name of the button ("דירה, שורה 2"). */
  label: string;
}) {
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const hits = useMemo(() => {
    const t = term.trim();
    return t ? apartments.filter((a) => a.includes(t)) : apartments;
  }, [apartments, term]);

  // Focus the search on every open; close on a click outside.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => search.current?.focus(), 10);
    function onDoc(e: MouseEvent) {
      if (root.current && !root.current.contains(e.target as Node)) onOpenChange(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open, onOpenChange]);

  function pick(a: string) {
    onChange(a);
    onOpenChange(false);
  }

  return (
    <div className="cr-combo" ref={root}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          if (!open) { setTerm(''); setActive(0); }
          onOpenChange(!open);
        }}
        className={cn('cr-aptsel', !value && 'cr-empty', open && 'cr-open', invalid && 'cr-bad')}
      >
        {value ? <span>דירה <span className="cr-num">{value}</span></span> : 'בחר דירה...'}
      </button>
      {open && (
        <div className="cr-combopanel">
          <div className="cr-combosearch">
            <input
              ref={search}
              type="text"
              inputMode="numeric"
              value={term}
              placeholder="חיפוש לפי מספר דירה..."
              aria-label="חיפוש לפי מספר דירה"
              onChange={(e) => { setTerm(e.target.value); setActive(0); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); onOpenChange(false); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); if (hits[active]) pick(hits[active]); }
              }}
            />
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </div>
          <div className="cr-combolist" role="listbox" aria-label="דירות">
            {hits.length === 0 ? (
              <div className="cr-combonone">לא נמצאה דירה</div>
            ) : (
              hits.map((a, i) => (
                <button
                  key={a}
                  type="button"
                  role="option"
                  aria-selected={a === value}
                  className={cn('cr-comboitem', i === active && 'cr-active')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(a)}
                >
                  <span className="cr-cn cr-num">{a}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
