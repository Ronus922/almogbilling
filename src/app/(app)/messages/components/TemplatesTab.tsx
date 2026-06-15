'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { WhatsAppTemplateSheet } from '../../whatsapp-templates/components/WhatsAppTemplateSheet';
import type { WhatsAppTemplate } from '@/types/whatsapp';

export function TemplatesTab({ canManage }: { canManage: boolean }) {
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<WhatsAppTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WhatsAppTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Managers see all (incl. inactive); inbox-only users see active templates.
      const url = canManage ? '/api/whatsapp/templates?scope=all' : '/api/whatsapp/templates';
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTemplates((await r.json()) as WhatsAppTemplate[]);
    } catch {
      toast.error('טעינת התבניות נכשלה');
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => { void load(); }, [load]);

  function openCreate() { setEditing(null); setSheetOpen(true); }
  function openEdit(t: WhatsAppTemplate) { setEditing(t); setSheetOpen(true); }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/whatsapp/templates/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error || 'מחיקה נכשלה');
      toast.success('התבנית נמחקה');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'מחיקה נכשלה');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <FileText className="h-4 w-4" />
          <span>{templates.length} תבניות</span>
        </div>
        {canManage && (
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" /> תבנית חדשה
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-muted/60" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
          אין תבניות עדיין.{canManage && ' לחץ על "תבנית חדשה" כדי ליצור אחת.'}
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{t.name}</span>
                  {!t.is_active && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                      לא פעילה
                    </span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-slate-500">{t.content}</p>
              </div>
              {canManage && (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openEdit(t)}
                    aria-label="עריכה"
                    className="rounded p-1.5 text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-700"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(t)}
                    aria-label="מחיקה"
                    className="rounded p-1.5 text-rose-500 transition-colors hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {canManage && (
        <WhatsAppTemplateSheet
          open={sheetOpen}
          editing={editing}
          onOpenChange={setSheetOpen}
          onSaved={async () => { setSheetOpen(false); await load(); }}
        />
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את התבנית?</AlertDialogTitle>
            <AlertDialogDescription>
              התבנית &quot;{deleteTarget?.name}&quot; לא תוצע יותר בשליחה. ניתן ליצור אותה מחדש בעתיד.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void confirmDelete(); }}
              disabled={deleting}
              className={cn('bg-destructive text-white hover:bg-destructive/90', deleting && 'opacity-70')}
            >
              {deleting ? 'מוחק…' : 'מחק'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
