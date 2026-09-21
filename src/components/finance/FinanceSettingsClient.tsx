'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, Cloud, Eye, Pencil, Plus, RefreshCw, Tags, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { FIN_KIND_LABEL_PLURAL, FIN_KINDS, FIN_SECTION_LABEL, type FinKind } from '@/lib/constants/finance';
import type { DriveBackupStats, DriveConnectionPublic, FinCategory, FinanceSettings } from '@/lib/types/finance';
import { CategorySheet } from './CategorySheet';

// /finance/settings — three cards in the settings column pattern
// (src/app/(app)/settings/page.tsx): categories per kind, the Google Drive
// connection, and the residents-documents switch.

export interface DriveStatusPayload {
  connection: DriveConnectionPublic;
  stats: DriveBackupStats;
  expectedAccount: string;
  oauthConfigured: boolean;
}

const DRIVE_ERROR_TEXT: Record<string, string> = {
  unavailable: 'Google OAuth לא מוגדר בשרת (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)',
  denied: 'ההרשאה נדחתה בחשבון Google',
  state: 'האימות פג או לא תואם — נסה שוב',
  exchange: 'החלפת הקוד מול Google נכשלה — ודא שה-redirect URI רשום ב-OAuth client ב-GCP',
  no_refresh_token: 'Google לא החזיר refresh token. הסר את ההרשאה של האפליקציה בחשבון Google (myaccount.google.com/permissions) וחבר שוב',
  no_email: 'לא התקבל מייל מאומת מ-Google',
};

interface SheetState { open: boolean; kind: FinKind; category: FinCategory | null }

const cardCls = 'ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-6';

function CardHeader({ icon: Icon, tone, title, subtitle, action }: {
  icon: React.ComponentType<{ className?: string }>; tone: string; title: string; subtitle: string; action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full', tone)}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

export function FinanceSettingsClient({
  categories: initialCategories, drive: initialDrive, settings: initialSettings, canEdit, driveNotice,
}: {
  categories: FinCategory[];
  drive: DriveStatusPayload;
  settings: FinanceSettings;
  canEdit: boolean;
  driveNotice: { status: string | null; reason: string | null };
}) {
  const router = useRouter();
  const [categories, setCategories] = useState(initialCategories);
  const [sheet, setSheet] = useState<SheetState>({ open: false, kind: 'expense', category: null });
  const [sheetKey, setSheetKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<FinCategory | null>(null);
  const [drive, setDrive] = useState(initialDrive);
  const [retrying, setRetrying] = useState(false);
  const [settings, setSettings] = useState(initialSettings);
  const [savingSettings, setSavingSettings] = useState(false);

  // The OAuth callback lands here with ?drive=connected|error — one toast,
  // then the query string is dropped so a refresh does not repeat it.
  useEffect(() => {
    if (!driveNotice.status) return;
    if (driveNotice.status === 'connected') toast.success('Google Drive חובר בהצלחה');
    else toast.error(DRIVE_ERROR_TEXT[driveNotice.reason ?? ''] ?? 'חיבור Google Drive נכשל');
    router.replace('/finance/settings');
  }, [driveNotice.status, driveNotice.reason, router]);

  const byKind = (kind: FinKind) => categories.filter((c) => c.kind === kind).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'he'));

  function openCreate(kind: FinKind) {
    setSheetKey((k) => k + 1);
    setSheet({ open: true, kind, category: null });
  }
  function openEdit(c: FinCategory) {
    setSheetKey((k) => k + 1);
    setSheet({ open: true, kind: c.kind, category: c });
  }
  function upsertLocal(c: FinCategory) {
    setCategories((list) => (list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c]));
  }

  async function toggleActive(c: FinCategory, next: boolean) {
    const before = categories;
    setCategories((list) => list.map((x) => (x.id === c.id ? { ...x, is_active: next } : x)));
    try {
      const r = await fetch(`/api/finance/categories/${c.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ is_active: next }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'עדכון נכשל');
      toast.success(next ? 'הסעיף הופעל' : 'הסעיף הושבת');
    } catch (err) {
      setCategories(before);
      toast.error((err as Error).message);
    }
  }

  async function move(c: FinCategory, dir: -1 | 1) {
    const list = byKind(c.kind);
    const idx = list.findIndex((x) => x.id === c.id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= list.length) return;
    const next = [...list];
    [next[idx], next[j]] = [next[j], next[idx]];
    const before = categories;
    const reindexed = new Map(next.map((x, i) => [x.id, i]));
    setCategories((all) => all.map((x) => (reindexed.has(x.id) ? { ...x, sort_order: reindexed.get(x.id)! } : x)));
    try {
      const r = await fetch('/api/finance/categories/order', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ ids: next.map((x) => x.id) }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'שינוי הסדר נכשל');
    } catch (err) {
      setCategories(before);
      toast.error((err as Error).message);
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      const r = await fetch(`/api/finance/categories/${target.id}`, { method: 'DELETE', credentials: 'include' });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'מחיקה נכשלה');
      setCategories((list) => list.filter((x) => x.id !== target.id));
      toast.success('הסעיף נמחק');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function refreshDrive() {
    try {
      const r = await fetch('/api/finance/drive/status', { credentials: 'include' });
      if (r.ok) setDrive((await r.json()) as DriveStatusPayload);
    } catch { /* keep what we have */ }
  }
  async function retryDrive() {
    setRetrying(true);
    try {
      const r = await fetch('/api/finance/drive/retry', { method: 'POST', credentials: 'include' });
      const data = (await r.json().catch(() => ({}))) as { error?: string; processed?: number; done?: number; failed?: number };
      if (!r.ok) throw new Error(data.error ?? 'הניסיון החוזר נכשל');
      if ((data.processed ?? 0) === 0) toast.info('אין קבצים שממתינים לגיבוי');
      else if ((data.failed ?? 0) === 0) toast.success(`${data.done} קבצים גובו ל-Google Drive`);
      else toast.warning(`גובו ${data.done}, נכשלו ${data.failed} — ראה סיבה באייקון ליד הקובץ`);
      await refreshDrive();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  async function saveSettings(next: boolean) {
    const before = settings;
    setSettings((s) => ({ ...s, show_documents_to_residents: next }));
    setSavingSettings(true);
    try {
      const r = await fetch('/api/finance/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ show_documents_to_residents: next }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; settings?: FinanceSettings };
      if (!r.ok || !data.settings) throw new Error(data.error ?? 'שמירה נכשלה');
      setSettings(data.settings);
      toast.success(next ? 'הצגת מסמכים לדיירים הופעלה' : 'הצגת מסמכים לדיירים כבויה');
    } catch (err) {
      setSettings(before);
      toast.error((err as Error).message);
    } finally {
      setSavingSettings(false);
    }
  }

  const conn = drive.connection;
  const wrongAccount = conn.connected && conn.email !== drive.expectedAccount;
  const retryable = drive.stats.pending + drive.stats.failed + drive.stats.exhausted;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900">סעיפים והגדרות</h1>
        <p className="mt-1 text-sm text-muted-foreground">שקיפות כספית — הגדרות המודול. אדמין בלבד.</p>
      </div>

      {/* ── Categories ─────────────────────────────────────────────────── */}
      <Card className={cardCls}>
        <CardHeader icon={Tags} tone="bg-blue-50 text-blue-600" title="סעיפים" subtitle="סעיפי ההכנסה וההוצאה שמוצעים בטופס ההזנה. סעיף שיש לו שורות לא נמחק — רק מושבת." />
        <div className="mt-6 space-y-6">
          {FIN_KINDS.map((kind) => {
            const list = byKind(kind);
            return (
              <div key={kind} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-baseline gap-2 text-base font-semibold text-slate-800">
                    {FIN_KIND_LABEL_PLURAL[kind]}
                    <span className="font-num text-xs font-medium tabular-nums text-slate-400">{list.length}</span>
                  </h3>
                  {canEdit && (
                    <Button type="button" variant="outline" size="sm" onClick={() => openCreate(kind)} className="gap-1.5">
                      <Plus className="h-4 w-4" /> סעיף חדש
                    </Button>
                  )}
                </div>
                {list.length === 0 ? (
                  <p className="py-2 text-center text-xs text-slate-400">אין סעיפי {FIN_KIND_LABEL_PLURAL[kind]} עדיין.</p>
                ) : (
                  <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                    {list.map((c, i) => (
                      <li key={c.id} className={cn('flex flex-wrap items-center gap-2 p-3 sm:flex-nowrap', !c.is_active && 'bg-slate-50/60')}>
                        <div className="min-w-0 flex-1">
                          <p className={cn('truncate text-sm font-semibold', c.is_active ? 'text-slate-900' : 'text-slate-400 line-through')}>{c.name}</p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                            <span className={cn('rounded-full px-2 py-0.5 font-semibold', c.section === 'renovation_fund' ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-600')}>
                              {FIN_SECTION_LABEL[c.section]}
                            </span>
                            {c.is_hot_water && <span className="rounded-full bg-sky-50 px-2 py-0.5 font-semibold text-sky-700">מים חמים</span>}
                            <span className="font-num tabular-nums">{c.entries_count} שורות</span>
                          </p>
                        </div>
                        {canEdit && (
                          <div className="flex items-center gap-1">
                            <Tooltip>
                              <TooltipTrigger render={<span className="block" />}>
                                <label className="flex h-11 cursor-pointer select-none items-center px-1">
                                  <Switch checked={c.is_active} onCheckedChange={(v) => void toggleActive(c, v)} aria-label={c.is_active ? 'השבת' : 'הפעל'} />
                                </label>
                              </TooltipTrigger>
                              <TooltipContent>{c.is_active ? 'פעיל — לחץ להשבתה' : 'מושבת — לחץ להפעלה'}</TooltipContent>
                            </Tooltip>
                            <button type="button" onClick={() => void move(c, -1)} disabled={i === 0} aria-label="הזז למעלה" className="grid h-11 w-11 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30">
                              <ArrowUp className="h-4 w-4" />
                            </button>
                            <button type="button" onClick={() => void move(c, 1)} disabled={i === list.length - 1} aria-label="הזז למטה" className="grid h-11 w-11 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30">
                              <ArrowDown className="h-4 w-4" />
                            </button>
                            <button type="button" onClick={() => openEdit(c)} aria-label="עריכה" className="grid h-11 w-11 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-blue-600">
                              <Pencil className="h-4 w-4" />
                            </button>
                            <Tooltip>
                              <TooltipTrigger render={<span className="block" />}>
                                <button
                                  type="button"
                                  onClick={() => setDeleteTarget(c)}
                                  disabled={c.entries_count > 0}
                                  aria-label="מחיקה"
                                  className="grid h-11 w-11 place-items-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>{c.entries_count > 0 ? 'יש שורות בסעיף — ניתן להשבית בלבד' : 'מחיקה'}</TooltipContent>
                            </Tooltip>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── Google Drive ───────────────────────────────────────────────── */}
      <Card className={cardCls}>
        <CardHeader icon={Cloud} tone="bg-emerald-50 text-emerald-600" title="גיבוי ל-Google Drive" subtitle={`כל קובץ מצורף מועתק ברקע לתיקייה "ALMOG — קבלות" / שנה / חודש בחשבון ${drive.expectedAccount}.`} />
        <div className="mt-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-sm text-slate-600">
              <span className={cn('h-1.5 w-1.5 rounded-full', conn.connected ? 'bg-emerald-500' : 'bg-slate-400')} />
              {conn.connected ? (
                <>מחובר: <span dir="ltr" className="font-num font-semibold text-slate-900">{conn.email}</span></>
              ) : 'לא מחובר'}
            </span>
            {canEdit && (
              <Tooltip>
                <TooltipTrigger render={<span className="block" />}>
                  {/* A real navigation to the OAuth start route (not a Next page) —
                      an anchor, so the browser follows the 302 to Google. */}
                  <Button
                    disabled={!drive.oauthConfigured}
                    render={<a href={drive.oauthConfigured ? '/api/finance/drive/start' : undefined} />}
                    className="gap-2"
                  >
                    <Cloud className="h-4 w-4" /> {conn.connected ? 'חבר מחדש' : 'חבר Google Drive'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{drive.oauthConfigured ? `יש להתחבר כ-${drive.expectedAccount}` : 'Google OAuth לא מוגדר בשרת'}</TooltipContent>
              </Tooltip>
            )}
          </div>
          {wrongAccount && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              חובר חשבון אחר (<span dir="ltr" className="font-num">{conn.email}</span>). החשבון המיועד לגיבוי הוא{' '}
              <span dir="ltr" className="font-num font-semibold">{drive.expectedAccount}</span> — לחץ „חבר מחדש” ובחר אותו.
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4 text-sm">
            <dl className="flex flex-wrap gap-x-5 gap-y-1">
              <div className="flex items-baseline gap-1.5"><dt className="text-slate-500">גובו</dt><dd className="font-num font-bold tabular-nums text-emerald-700">{drive.stats.done}</dd></div>
              <div className="flex items-baseline gap-1.5"><dt className="text-slate-500">ממתינים</dt><dd className="font-num font-bold tabular-nums text-amber-700">{drive.stats.pending}</dd></div>
              <div className="flex items-baseline gap-1.5"><dt className="text-slate-500">נכשלו</dt><dd className="font-num font-bold tabular-nums text-red-600">{drive.stats.failed + drive.stats.exhausted}</dd></div>
            </dl>
            {canEdit && (
              <Button type="button" variant="outline" size="sm" onClick={() => void retryDrive()} disabled={retrying || retryable === 0} className="gap-1.5">
                <RefreshCw className={cn('h-4 w-4', retrying && 'animate-spin')} /> {retrying ? 'מנסה…' : 'נסה שוב'}
              </Button>
            )}
          </div>
          <p className="text-[12px] text-slate-500">כשל בגיבוי אינו מונע שמירה. כל קובץ מנוסה עד 5 פעמים — אוטומטית בכל שמירה חדשה, או כאן ב„נסה שוב”.</p>
        </div>
      </Card>

      {/* ── Residents documents switch ─────────────────────────────────── */}
      <Card className={cardCls}>
        <CardHeader icon={Eye} tone="bg-violet-50 text-violet-600" title="מסמכים לדיירים" subtitle="האם בעלי הדירות יראו את הקבצים המצורפים בפורטל (ייבנה בשלב הבא)." />
        <div className="mt-6 space-y-3">
          <label className="flex cursor-pointer select-none items-center gap-3 text-sm font-medium text-slate-800">
            <Switch
              size="lg"
              checked={settings.show_documents_to_residents}
              onCheckedChange={(v) => void saveSettings(v)}
              disabled={!canEdit || savingSettings}
            />
            הצג מסמכים לדיירים
          </label>
          <p className="text-[12px] text-slate-500">
            כבוי כברירת מחדל. בשלב זה ההגדרה רק נשמרת — האכיפה תיבנה יחד עם פורטל בעלי הדירות.
          </p>
          <p className="text-[12px] font-semibold text-amber-700">שים לב: שם הספק מופיע על המסמך עצמו.</p>
        </div>
      </Card>

      <CategorySheet
        key={sheetKey}
        open={sheet.open}
        kind={sheet.kind}
        category={sheet.category}
        onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))}
        onSaved={upsertLocal}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את הסעיף?</AlertDialogTitle>
            <AlertDialogDescription>{deleteTarget ? `הסעיף «${deleteTarget.name}» יימחק לצמיתות.` : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()} className="bg-destructive text-white hover:bg-destructive/90">מחק</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
