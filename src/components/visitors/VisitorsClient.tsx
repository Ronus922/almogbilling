'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, KeyRound, Loader2, ScanLine, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DOCUMENT_TYPE_LABELS, VISITOR_PAGE_SIZE, type VisitorScan } from '@/lib/visitors/model';
import { ChangePasswordSheet } from './ChangePasswordSheet';
import { ScanSheet } from './ScanSheet';
import { VisitorDetailSheet } from './VisitorDetailSheet';
import { EMPTY_VISITOR_FILTER, VisitorFilters, type VisitorFilter } from './VisitorFilters';
import { formatStamp, fullName } from './format';

// "סריקת כניסה" — the guard's one screen (the admins use it too; no other role reaches it).
// Mobile first (an iPhone at the gate): one big "סרוק תעודה" button that opens
// the camera, a search, and the scans as cards on a phone / a table from md up.

export interface VisitorCaps {
  /** Scan a document (guard, admin, super admin). */
  canScan: boolean;
  /** Write the notes of a saved scan. */
  canEditNotes: boolean;
  /** Edit every field and delete. */
  canManage: boolean;
  /** Show "שינוי סיסמה" — the guard has no other place to change it. */
  isGuard: boolean;
}

interface Page {
  rows: VisitorScan[];
  total: number;
}

const TH = 'px-4 py-3 text-start text-sm font-semibold text-slate-500';
const TD = 'px-4 py-3 text-sm';

export function VisitorsClient({ caps }: { caps: VisitorCaps }) {
  const [filter, setFilter] = useState<VisitorFilter>(EMPTY_VISITOR_FILTER);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page>({ rows: [], total: 0 });
  const [loadedKey, setLoadedKey] = useState('');
  const [loadError, setLoadError] = useState('');
  const [tick, setTick] = useState(0);
  // Bumped per photo: ScanSheet remounts, so its state starts fresh with no reset effect.
  const [scanKey, setScanKey] = useState(0);

  const [selected, setSelected] = useState<VisitorScan | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // The search waits for a pause in typing; the dates apply at once.
  useEffect(() => {
    const t = setTimeout(() => { setQ(filter.q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [filter.q]);

  // What the table is asking for; `loading` is simply "the last answer is for another ask".
  const reqKey = [q, filter.from, filter.to, page, tick].join('|');
  const loading = loadedKey !== reqKey;

  useEffect(() => {
    const ctl = new AbortController();
    const sp = new URLSearchParams({ page: String(page) });
    if (q) sp.set('q', q);
    if (filter.from) sp.set('from', filter.from);
    if (filter.to) sp.set('to', filter.to);
    fetch(`/api/visitors?${sp.toString()}`, { credentials: 'include', signal: ctl.signal })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as Partial<Page> & { error?: string };
        if (ctl.signal.aborted) return; // a newer ask replaced this one mid-read: no banner for it
        if (!r.ok || !body.rows) throw new Error(body.error ?? 'טעינת הסריקות נכשלה');
        // The last row of the last page was deleted (here or by another admin): the page is now
        // past the end and the server answers [] with total 0 — step back instead of showing an
        // empty table with no way to page.
        if (body.rows.length === 0 && page > 1) { setPage(page - 1); return; }
        setData({ rows: body.rows, total: body.total ?? 0 });
        setLoadError('');
      })
      .catch((e: Error) => { if (e.name !== 'AbortError') setLoadError(e.message); })
      .finally(() => { if (!ctl.signal.aborted) setLoadedKey(reqKey); });
    return () => ctl.abort();
  }, [q, filter.from, filter.to, page, tick, reqKey]);

  const openCamera = useCallback(() => fileRef.current?.click(), []);

  function onFilterChange(next: VisitorFilter) {
    if (next.from !== filter.from || next.to !== filter.to) setPage(1);
    setFilter(next);
  }

  function openRow(v: VisitorScan) {
    setSelected(v);
    setDetailOpen(true);
  }

  function onChanged(v: VisitorScan) {
    setSelected(v);
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.id === v.id ? v : r)) }));
  }

  function onDeleted() {
    setDetailOpen(false);
    setTick((t) => t + 1);
  }

  const pageCount = Math.max(1, Math.ceil(data.total / VISITOR_PAGE_SIZE));
  const filtering = q !== '' || filter.from !== '' || filter.to !== '';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold text-slate-900">סריקת כניסה</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {caps.canScan
              ? 'מצלמים את תעודת המבקר, בודקים את הפרטים שנקראו, ממלאים חדר / צ׳יפ / טלפון ושומרים.'
              : 'יומן הסריקות של הכניסה — כל מי שנסרק, עם צילום התעודה.'}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {caps.canScan && (
            <Button type="button" size="lg" onClick={openCamera} data-scan-button className="w-full gap-2 sm:w-auto">
              <ScanLine className="h-5 w-5" aria-hidden />
              סרוק תעודה
            </Button>
          )}
          {caps.isGuard && (
            <Button type="button" variant="outline" size="lg" onClick={() => setPwOpen(true)} data-change-password
              className="w-full gap-2 sm:w-auto">
              <KeyRound className="h-4 w-4" aria-hidden />
              שינוי סיסמה
            </Button>
          )}
        </div>
      </div>

      {caps.canScan && (
        // accept="image/*" lets iOS hand over a JPEG (it converts HEIC itself); the server
        // still decodes a real HEIC if one arrives. capture opens the rear camera on a phone;
        // iOS may offer the library too — that is fine.
        <input
          ref={fileRef} type="file" accept="image/*" capture="environment"
          className="sr-only" tabIndex={-1} aria-label="צילום תעודה" data-visitor-file
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) { setScanKey((k) => k + 1); setScanFile(f); }
          }}
        />
      )}

      <VisitorFilters filter={filter} onChange={onFilterChange} />

      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <span>{loadError}</span>
          <Button type="button" variant="outline" onClick={() => setTick((t) => t + 1)}>נסה שוב</Button>
        </div>
      )}

      {/* Phone: cards (DESIGN §9b) */}
      <div className="space-y-2 md:hidden" data-visitor-cards>
        {data.rows.map((v) => (
          <button
            key={v.id} type="button" onClick={() => openRow(v)} data-visitor-row
            className="flex w-full flex-col gap-1.5 rounded-lg border border-slate-200 bg-white p-4 text-start transition-colors hover:bg-slate-50"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 truncate text-base font-bold text-slate-900">{fullName(v)}</span>
              <span dir="ltr" className="shrink-0 text-xs tabular-nums text-slate-500">{formatStamp(v.created_at)}</span>
            </div>
            <div className="text-sm text-slate-600">
              {DOCUMENT_TYPE_LABELS[v.document_type]} · <span dir="ltr" className="tabular-nums">{v.document_number}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
              {v.phone && <span dir="ltr" className="tabular-nums">{v.phone}</span>}
              {v.room_number && <span>חדר {v.room_number}</span>}
              {v.chip_number && <span>צ׳יפ <span dir="ltr" className="tabular-nums">{v.chip_number}</span></span>}
            </div>
          </button>
        ))}
      </div>

      {/* From md up: the table (DESIGN §9) */}
      <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white md:block">
        <table className="w-full table-auto" data-visitor-table>
          <thead className="[&_tr]:border-b [&_tr]:border-slate-200">
            <tr className="bg-slate-50">
              <th className={TH}>תאריך ושעה</th>
              <th className={TH}>שם מלא</th>
              <th className={TH}>מסמך</th>
              <th className={TH}>טלפון</th>
              <th className={TH}>חדר</th>
              <th className={TH}>צ׳יפ</th>
              <th className={TH}>נסרק ע״י</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((v) => (
              <tr
                key={v.id} tabIndex={0} data-visitor-row
                onClick={() => openRow(v)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(v); } }}
                className="h-12 cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
              >
                <td className={cn(TD, 'whitespace-nowrap text-slate-600')} dir="ltr">
                  <span className="tabular-nums">{formatStamp(v.created_at)}</span>
                </td>
                <td className={cn(TD, 'font-bold text-slate-900')}>{fullName(v)}</td>
                <td className={cn(TD, 'text-slate-700')}>
                  {DOCUMENT_TYPE_LABELS[v.document_type]} · <span dir="ltr" className="tabular-nums">{v.document_number}</span>
                </td>
                <td className={cn(TD, 'text-slate-700')}><span dir="ltr" className="tabular-nums">{v.phone ?? '—'}</span></td>
                <td className={cn(TD, 'text-slate-700')}>{v.room_number ?? '—'}</td>
                <td className={cn(TD, 'text-slate-700')}><span dir="ltr" className="tabular-nums">{v.chip_number ?? '—'}</span></td>
                <td className={cn(TD, 'text-slate-500')}>{v.scanned_by_name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {loading && data.rows.length === 0 && (
        <div role="status" className="flex items-center justify-center gap-3 rounded-lg border border-slate-200 bg-white p-8 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> טוען…
        </div>
      )}

      {!loading && !loadError && data.rows.length === 0 && (
        <div data-visitor-empty className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
          <Search className="h-6 w-6 text-slate-400" aria-hidden />
          <div className="text-base font-bold text-slate-900">{filtering ? 'לא נמצאו סריקות לסינון הזה' : 'עדיין לא נסרקו מסמכים'}</div>
          <div className="text-sm text-slate-500">
            {filtering ? 'נסה שם אחר, מספר טלפון או טווח תאריכים רחב יותר.' : caps.canScan ? 'לחץ על „סרוק תעודה” כדי להתחיל.' : 'הסריקות יופיעו כאן.'}
          </div>
        </div>
      )}

      {data.total > VISITOR_PAGE_SIZE && (
        <nav aria-label="עמודים" className="flex items-center justify-between gap-3 text-sm">
          <Button type="button" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} data-page-prev>
            <ChevronRight className="h-4 w-4" aria-hidden />
            הקודם
          </Button>
          <span className="tabular-nums text-slate-600" data-page-info>עמוד {page} מתוך {pageCount} · {data.total} סריקות</span>
          <Button type="button" variant="outline" disabled={page >= pageCount || loading} onClick={() => setPage((p) => p + 1)} data-page-next>
            הבא
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
        </nav>
      )}

      {selected && (
        <VisitorDetailSheet
          key={selected.id} scan={selected} open={detailOpen}
          caps={{ canManage: caps.canManage, canEditNotes: caps.canEditNotes }}
          onClose={() => setDetailOpen(false)} onChanged={onChanged} onDeleted={onDeleted}
        />
      )}

      <ScanSheet
        key={scanKey} file={scanFile}
        onClose={() => setScanFile(null)}
        onRetake={() => { setScanFile(null); openCamera(); }}
        onSaved={() => { setScanFile(null); setPage(1); setTick((t) => t + 1); }}
      />

      {caps.isGuard && <ChangePasswordSheet open={pwOpen} onClose={() => setPwOpen(false)} />}
    </div>
  );
}
