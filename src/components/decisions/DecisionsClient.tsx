'use client';

// /decisions — the decisions and protocols the owners portal publishes.
// Every row the table holds, hidden ones included (the portal sees only the
// published ones), newest decision first. Per row: the type tag, the date, the
// size, the "מוצג בפורטל" switch, and view / edit / delete.
//
// The switch writes immediately (PATCH), because that is the one action an
// admin takes to pull a document off the portal — it should not need a panel
// and a save. Delete is a native confirm() and removes the row AND the object.

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Eye, Gavel, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  decisionTypeTag, formatDecisionDate, formatFileSize, type DecisionType,
} from '@/lib/decisions';
import type { DecisionAdminView } from '@/lib/decisionsView';
import { DecisionPanel } from './DecisionPanel';

/** DESIGN §2 tones — the same pairing the portal's row tags use: a decision in
 *  brand-soft, a protocol in green-soft. */
const TYPE_TONE: Record<DecisionType, string> = {
  decision: 'bg-brand-soft text-brand-dark',
  protocol: 'bg-emerald-50 text-emerald-700',
};

export function DecisionsClient({ initial, canEdit }: { initial: DecisionAdminView[]; canEdit: boolean }) {
  const [rows, setRows] = useState<DecisionAdminView[]>(initial);
  const [panelOpen, setPanelOpen] = useState(false);
  const [editing, setEditing] = useState<DecisionAdminView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/decisions', { credentials: 'include' });
      if (!res.ok) return;
      const body = await res.json();
      if (Array.isArray(body.decisions)) setRows(body.decisions);
    } catch {
      /* the list on screen stays — a failed refresh is not a reason to blank it */
    }
  }, []);

  async function togglePublished(row: DecisionAdminView, next: boolean) {
    if (busyId) return;
    setBusyId(row.id);
    // Optimistic: the switch is the one control whose whole value is being
    // instant. A failure puts it back and says so.
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, published: next } : r)));
    try {
      const res = await fetch(`/api/decisions/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: row.title,
          summary: row.summary,
          doc_type: row.doc_type,
          decision_number: row.decision_number,
          decided_at: row.decided_at,
          published: next,
        }),
      });
      if (!res.ok) throw new Error('patch failed');
      toast.success(next ? 'המסמך מוצג בפורטל' : 'המסמך הוסתר מהפורטל');
    } catch {
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, published: !next } : r)));
      toast.error('העדכון נכשל');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: DecisionAdminView) {
    if (busyId) return;
    if (!window.confirm(`למחוק את "${row.title}"? הקובץ יימחק גם מהאחסון ולא ניתן לשחזר.`)) return;
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/decisions/${row.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      toast.success('המסמך נמחק');
    } catch {
      toast.error('המחיקה נכשלה');
    } finally {
      setBusyId(null);
    }
  }

  function openCreate() {
    setEditing(null);
    setPanelOpen(true);
  }

  function openEdit(row: DecisionAdminView) {
    setEditing(row);
    setPanelOpen(true);
  }

  const published = rows.filter((r) => r.published).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">החלטות ופרוטוקולים</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            המסמכים שבעלי הדירות רואים בפורטל, בטאב &quot;החלטות&quot;. כל מסמך הוא קובץ PDF אחד.
            מסמך שהמתג שלו כבוי אינו נגיש לדיירים כלל — לא ברשימה ולא בקובץ.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="inline-flex h-11 items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-2">
            <Gavel className="h-4 w-4 text-brand" aria-hidden />
            <span className="font-num tabular-nums">{published}</span> מוצגים מתוך{' '}
            <span className="font-num tabular-nums">{rows.length}</span>
          </span>
          {canEdit && (
            <Button type="button" onClick={openCreate} className="gap-2">
              <Plus className="h-4 w-4" />
              העלאת מסמך
            </Button>
          )}
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
          עדיין לא הועלו החלטות או פרוטוקולים.
          {canEdit && ' לחצו על "העלאת מסמך" כדי להוסיף את הראשון.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-white shadow-soft-xs">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-slate-50/80 text-start">
                <th className="px-4 py-3 text-start font-semibold text-ink-2">מסמך</th>
                <th className="px-4 py-3 text-start font-semibold text-ink-2">סוג</th>
                <th className="px-4 py-3 text-start font-semibold text-ink-2">תאריך</th>
                <th className="px-4 py-3 text-start font-semibold text-ink-2">גודל</th>
                <th className="px-4 py-3 text-start font-semibold text-ink-2">מוצג בפורטל</th>
                <th className="px-4 py-3 text-start font-semibold text-ink-2">פעולות</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  data-decision={row.id}
                  className={cn('border-b border-line last:border-0 transition-colors hover:bg-row-hover', !row.published && 'bg-slate-50/40')}
                >
                  <td className="px-4 py-3">
                    <p className={cn('font-semibold text-ink', !row.published && 'text-ink-3')}>{row.title}</p>
                    {row.summary && (
                      <p className="mt-0.5 line-clamp-1 max-w-[42ch] text-xs text-ink-3">{row.summary}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', TYPE_TONE[row.doc_type])}>
                      {decisionTypeTag(row.doc_type, row.decision_number)}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-num tabular-nums text-ink-2">{formatDecisionDate(row.decided_at)}</td>
                  <td className="px-4 py-3 font-num tabular-nums text-ink-3">{formatFileSize(row.file_size)}</td>
                  <td className="px-4 py-3">
                    <Switch
                      checked={row.published}
                      onCheckedChange={(v) => togglePublished(row, v)}
                      disabled={!canEdit || busyId !== null}
                      aria-label={`מוצג בפורטל — ${row.title}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <a
                        href={row.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`צפייה ב-${row.title}`}
                        title="צפייה"
                        className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-slate-100 hover:text-ink"
                      >
                        <Eye className="h-4 w-4" />
                      </a>
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            onClick={() => openEdit(row)}
                            aria-label={`עריכת ${row.title}`}
                            title="עריכה"
                            className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-slate-100 hover:text-ink"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => remove(row)}
                            disabled={busyId !== null}
                            aria-label={`מחיקת ${row.title}`}
                            title="מחיקה"
                            className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <DecisionPanel
          open={panelOpen}
          decision={editing}
          onOpenChange={setPanelOpen}
          onSaved={reload}
        />
      )}
    </div>
  );
}
