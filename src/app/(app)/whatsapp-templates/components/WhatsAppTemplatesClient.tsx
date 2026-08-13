'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Search, Pencil, Trash2, MessageSquareText } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { WhatsAppTemplateSheet } from './WhatsAppTemplateSheet';
import type { WhatsAppTemplate } from '@/types/whatsapp';

export function WhatsAppTemplatesClient() {
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((t) => {
      if (activeOnly && !t.is_active) return false;
      if (q) {
        const inName = t.name.toLowerCase().includes(q);
        const inContent = t.content.toLowerCase().includes(q);
        if (!inName && !inContent) return false;
      }
      return true;
    });
  }, [templates, query, activeOnly]);

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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">תבניות WhatsApp</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            הודעות מוכנות מראש עם משתנים אישיים לשליחה מהירה לחייבים.
          </p>
        </div>
        <Button
          type="button"
          onClick={openCreate}
          className="gap-2"
        >
          <Plus className="h-4 w-4" />
          תבנית חדשה
        </Button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 md:flex-row md:items-center md:justify-between">
        <div className="relative w-full md:max-w-xs">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="חיפוש לפי שם או תוכן..."
            className="h-10 pe-9"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700 select-none cursor-pointer">
          <Switch checked={activeOnly} onCheckedChange={(v) => setActiveOnly(v)} />
          פעילות בלבד
        </label>
      </div>

      {/* Table / states */}
      {loading ? (
        <div className="space-y-2">
          <div className="h-12 rounded-lg bg-slate-100 animate-pulse" />
          <div className="h-12 rounded-lg bg-slate-100 animate-pulse" />
        </div>
      ) : templates.length === 0 ? (
        <EmptyState onCreate={openCreate} />
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
          לא נמצאו תבניות התואמות לחיפוש.
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          {/* מובייל (<md) — כרטיס לכל תבנית. שם ותוכן זקוקים לרוחב מלא;
              בטבלה הם נדחסים לצד תגית סטטוס ושני כפתורי פעולה. אותם
              handlers בדיוק (openEdit / setDeleteTarget) — אין לוגיקה כפולה. */}
          <ul className="space-y-2 p-3 roomy:hidden">
            {filtered.map((t) => (
              <li
                key={t.id}
                className={cn(
                  'rounded-xl border border-slate-200 bg-white p-3 shadow-soft-xs',
                  !t.is_active && 'opacity-60',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-[14.5px] font-bold text-slate-900">{t.name}</span>
                  <span className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold',
                    t.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500',
                  )}>
                    <span className={cn('h-1.5 w-1.5 rounded-full', t.is_active ? 'bg-emerald-500' : 'bg-slate-400')} />
                    {t.is_active ? 'פעיל' : 'מושבת'}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-3 text-[12.5px] text-slate-600">{t.content}</p>
                <div className="mt-2 flex items-center justify-end gap-1 border-t border-slate-100 pt-2">
                  <Button type="button" variant="ghost" size="icon" onClick={() => openEdit(t)} aria-label="עריכה">
                    <Pencil className="h-4 w-4" />
                  </Button>
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
                </div>
              </li>
            ))}
          </ul>

          <Table className="hidden roomy:table">
            <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
              <TableRow className="bg-slate-50 hover:bg-slate-50">
                <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">שם התבנית</TableHead>
                <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">תוכן</TableHead>
                <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">סטטוס</TableHead>
                <TableHead className="h-11 px-4 text-end text-sm font-semibold text-slate-500">פעולות</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => (
                <TableRow
                  key={t.id}
                  className={cn('border-b border-slate-100 hover:bg-slate-50 h-12', !t.is_active && 'opacity-60')}
                >
                  <TableCell className="px-4 py-3 text-start text-sm font-bold text-slate-900">{t.name}</TableCell>
                  <TableCell className="px-4 py-3 text-start text-sm text-slate-600 max-w-md truncate">
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
                  <TableCell className="px-4 py-3 text-end">
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
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-200 bg-white p-12 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-full bg-blue-50 text-blue-600">
        <MessageSquareText className="h-6 w-6" />
      </span>
      <h3 className="text-base font-semibold text-slate-900">טרם נוצרו תבניות</h3>
      <p className="text-sm text-muted-foreground">צור תבנית ראשונה כדי להתחיל לשלוח הודעות מהירות.</p>
      <Button type="button" onClick={onCreate} className="mt-2 gap-2">
        <Plus className="h-4 w-4" />
        תבנית חדשה
      </Button>
    </div>
  );
}
