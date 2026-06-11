'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, MessageSquareText } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { WhatsAppTemplateSheet } from './WhatsAppTemplateSheet';
import type { WhatsAppTemplate } from '@/types/whatsapp';

export function WhatsAppTemplatesManager() {
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WhatsAppTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WhatsAppTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function refetch() {
    try {
      const r = await fetch('/api/whatsapp/templates?scope=all', { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTemplates((await r.json()) as WhatsAppTemplate[]);
    } catch (err) {
      toast.error(`טעינת התבניות נכשלה: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refetch(); }, []);

  function openCreate() { setEditing(null); setFormOpen(true); }
  function openEdit(t: WhatsAppTemplate) { setEditing(t); setFormOpen(true); }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/whatsapp/templates/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      toast.success('התבנית הוסרה');
      setDeleteTarget(null);
      await refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card className="ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-600">
            <MessageSquareText className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-slate-900">תבניות WhatsApp</h2>
            <p className="mt-1 text-sm text-slate-500">הודעות מוכנות עם משתנים אישיים</p>
          </div>
        </div>
        <Button type="button" onClick={openCreate} className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700">
          <Plus className="h-4 w-4" />
          תבנית חדשה
        </Button>
      </div>

      <div className="mt-5">
        {loading ? (
          <div className="space-y-2">
            <div className="h-12 rounded-lg bg-slate-100 animate-pulse" />
            <div className="h-12 rounded-lg bg-slate-100 animate-pulse" />
          </div>
        ) : templates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-white p-10 text-center">
            <p className="text-sm text-muted-foreground">טרם נוצרו תבניות. צור תבנית ראשונה כדי להתחיל.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <Table>
              <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
                <TableRow className="bg-slate-50 hover:bg-slate-50">
                  <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">שם</TableHead>
                  <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">תוכן</TableHead>
                  <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">סטטוס</TableHead>
                  <TableHead className="h-11 px-4 text-left text-sm font-semibold text-slate-500">פעולות</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => (
                  <TableRow
                    key={t.id}
                    className={cn('border-b border-slate-100 hover:bg-slate-50 h-12', !t.is_active && 'opacity-60')}
                  >
                    <TableCell className="px-4 py-3 text-right text-sm font-bold text-slate-900">{t.name}</TableCell>
                    <TableCell className="px-4 py-3 text-right text-sm text-slate-600 max-w-xs truncate">
                      {t.content}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-center">
                      <span className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                        t.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500',
                      )}>
                        <span className={cn('h-1.5 w-1.5 rounded-full', t.is_active ? 'bg-emerald-500' : 'bg-slate-400')} />
                        {t.is_active ? 'פעיל' : 'מושבת'}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-3 text-left">
                      <div dir="ltr" className="flex items-center justify-start gap-1">
                        <Tooltip>
                          <TooltipTrigger render={<span className="inline-flex" />}>
                            <Button type="button" variant="ghost" size="icon" onClick={() => openEdit(t)} aria-label="עריכה">
                              <Pencil className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>עריכה</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger render={<span className="inline-flex" />}>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => setDeleteTarget(t)}
                              aria-label="מחיקה"
                              className="text-red-500 hover:text-red-600"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>מחיקה</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <WhatsAppTemplateSheet
        open={formOpen}
        editing={editing}
        onOpenChange={setFormOpen}
        onSaved={async () => { await refetch(); setFormOpen(false); }}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>להסיר את התבנית?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && `התבנית "${deleteTarget.name}" תושבת ולא תוצע יותר במסך השליחה. ניתן ליצור אותה מחדש בהמשך.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleting}
              className="gap-2 bg-destructive text-white hover:bg-destructive/90"
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? 'מסיר…' : 'הסר תבנית'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
