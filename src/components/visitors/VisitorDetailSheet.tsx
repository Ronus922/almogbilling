'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Camera, FileText, IdCard, Maximize2, StickyNote, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { DOCUMENT_TYPE_LABELS, type VisitorScan } from '@/lib/visitors/model';
import { ImageViewer } from './ImageViewer';
import { VisitorForm } from './VisitorForm';
import {
  formatBirthDate, formatStamp, formFromScan, fullName, toPayload, validateForm,
  type FormErrors, type VisitorFormValues,
} from './format';

// One saved scan. Desktop: the details on the right, the document photo on the
// left; phone: the photo under the details. What the viewer may change is the
// server's rule (VISITOR_*_ROLES) mirrored here, never the other way round:
//   admin / super admin : every field + delete
//   guard               : the notes, with their own "שמור הערות"
//   everyone else       : read only
// Always a Sheet (DESIGN §12) — it is a details/edit panel, not a confirmation.

export interface DetailCaps {
  /** Edit every field and delete. */
  canManage: boolean;
  /** Write the notes. */
  canEditNotes: boolean;
}

interface Props {
  scan: VisitorScan;
  open: boolean;
  caps: DetailCaps;
  onClose: () => void;
  onChanged: (scan: VisitorScan) => void;
  onDeleted: (id: string) => void;
}

function Row({ label, children, ltr }: { label: string; children: React.ReactNode; ltr?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-3 last:border-b-0">
      <dt className="shrink-0 text-sm text-slate-500">{label}</dt>
      <dd dir={ltr ? 'ltr' : undefined} className={`min-w-0 break-words text-end text-base font-semibold text-slate-900 ${ltr ? 'tabular-nums' : ''}`}>
        {children}
      </dd>
    </div>
  );
}

/** Only the fields whose text actually changed — keeps the audit row honest. */
function changedFields(before: VisitorFormValues, after: VisitorFormValues): Record<string, string> {
  const b = toPayload(before);
  const a = toPayload(after);
  return Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== b[k]));
}

export function VisitorDetailSheet({ scan, open, caps, onClose, onChanged, onDeleted }: Props) {
  const initial = formFromScan(scan);
  const [values, setValues] = useState<VisitorFormValues>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const dirty = Object.keys(changedFields(initial, values)).length > 0;
  const notesOnly = !caps.canManage && caps.canEditNotes;
  // Unsaved edits (an admin's fields, a guard's notes) deserve a second tap before they are lost (DESIGN §12).
  const unsaved = (caps.canManage || notesOnly) && dirty;

  function requestClose() {
    if (saving || deleting) return;
    if (unsaved) setConfirmCloseOpen(true);
    else onClose();
  }

  // Base UI's own Esc did not work in this project (see useEscapeKey): each layer registers
  // its own, innermost first.
  useEscapeKey(open && !viewerOpen && !confirmDeleteOpen && !confirmCloseOpen, requestClose);
  useEscapeKey(viewerOpen && !confirmDeleteOpen, () => setViewerOpen(false));
  useEscapeKey(confirmDeleteOpen, () => setConfirmDeleteOpen(false));
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  async function patch(body: Record<string, string>, success: string) {
    setSaving(true);
    try {
      const r = await fetch(`/api/visitors/${scan.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; scan?: VisitorScan };
      if (!r.ok || !data.scan) throw new Error(data.error ?? 'העדכון נכשל');
      toast.success(success);
      onChanged(data.scan);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function saveAll() {
    const found = validateForm(values);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      toast.error('חסרים פרטים חובה');
      return;
    }
    const body = changedFields(initial, values);
    if (Object.keys(body).length === 0) {
      toast.message('אין שינויים לשמירה');
      return;
    }
    void patch(body, 'השינויים נשמרו');
  }

  async function remove() {
    setDeleting(true);
    try {
      const r = await fetch(`/api/visitors/${scan.id}`, { method: 'DELETE', credentials: 'include' });
      const data = (await r.json().catch(() => ({}))) as { error?: string; photo_removed?: boolean };
      if (!r.ok) throw new Error(data.error ?? 'המחיקה נכשלה');
      if (data.photo_removed === false) {
        // The row is gone, but Storage refused to drop the photo of an ID document. Say so —
        // the key is in the audit row and the server log for a manual removal.
        toast.warning('הרשומה נמחקה, אבל צילום התעודה לא נמחק מהאחסון — דווח למנהל המערכת', { duration: 12000 });
      } else {
        toast.success('הסריקה נמחקה');
      }
      setConfirmDeleteOpen(false);
      onDeleted(scan.id);
    } catch (e) {
      toast.error((e as Error).message);
      setConfirmDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); }}>
        <SheetContent
          side="left" dir="rtl" showCloseButton={false}
          className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="truncate text-2xl font-bold text-white">{fullName(scan)}</SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {DOCUMENT_TYPE_LABELS[scan.document_type]} · נסרק {formatStamp(scan.created_at)}
                </p>
              </div>
              <button
                type="button" onClick={requestClose} aria-label="סגור"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            <div className="space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-5 lg:space-y-0">
              {/* Right (RTL start): the details */}
              <div className="space-y-4">
                {caps.canManage ? (
                  <Section title="פרטי המסמך" icon={IdCard} iconTone="blue">
                    <div className="py-2">
                      <VisitorForm values={values} errors={errors} disabled={saving}
                        onChange={(p) => { setValues((v) => ({ ...v, ...p })); setErrors({}); }} />
                    </div>
                  </Section>
                ) : (
                  <>
                    <Section title="פרטי המסמך" icon={IdCard} iconTone="blue">
                      <dl data-visitor-details className="py-1">
                        <Row label="סוג המסמך">{DOCUMENT_TYPE_LABELS[scan.document_type]}</Row>
                        <Row label="מספר מסמך" ltr>{scan.document_number}</Row>
                        <Row label="שם פרטי">{scan.first_name}</Row>
                        <Row label="שם משפחה">{scan.last_name}</Row>
                        <Row label="תאריך לידה" ltr>{formatBirthDate(scan.date_of_birth)}</Row>
                        <Row label="לאום">{scan.nationality ?? '—'}</Row>
                        <Row label="טלפון" ltr>{scan.phone ?? '—'}</Row>
                        <Row label="מספר חדר">{scan.room_number ?? '—'}</Row>
                        <Row label="מספר צ׳יפ" ltr>{scan.chip_number ?? '—'}</Row>
                      </dl>
                    </Section>
                    <Section title="הערות" icon={StickyNote} iconTone="amber">
                      <div className="space-y-3 py-2">
                        {notesOnly ? (
                          <>
                            <Label htmlFor="v-notes" className="sr-only">הערות</Label>
                            <Textarea id="v-notes" value={values.notes} rows={4} maxLength={2000} disabled={saving}
                              onChange={(e) => setValues((v) => ({ ...v, notes: e.target.value }))} className="min-h-24" />
                            <Button type="button" disabled={saving || values.notes.trim() === (scan.notes ?? '')}
                              onClick={() => void patch({ notes: values.notes.trim() }, 'ההערות נשמרו')}>
                              {saving ? 'שומר…' : 'שמור הערות'}
                            </Button>
                          </>
                        ) : (
                          <p className="whitespace-pre-wrap break-words text-base text-slate-900">{scan.notes ?? '—'}</p>
                        )}
                      </div>
                    </Section>
                  </>
                )}

                <Section title="תיעוד" icon={FileText} iconTone="slate">
                  <dl className="py-1">
                    <Row label="נסרק ע״י">{scan.scanned_by_name ?? '—'}</Row>
                    <Row label="תאריך ושעה" ltr>{formatStamp(scan.created_at)}</Row>
                  </dl>
                </Section>
              </div>

              {/* Left (RTL end): the photo of the document */}
              <Section title="צילום התעודה" icon={Camera} iconTone="violet"
                headerSlot={(
                  <Button type="button" variant="outline" onClick={() => setViewerOpen(true)} className="gap-1.5">
                    <Maximize2 className="h-3.5 w-3.5" aria-hidden />
                    מסך מלא
                  </Button>
                )}>
                <div className="py-2">
                  <button type="button" onClick={() => setViewerOpen(true)} aria-label="פתח את הצילום במסך מלא"
                    className="block w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a private, session-gated proxy path; next/image would fetch it unauthenticated */}
                    <img src={scan.image_url} alt={`צילום התעודה של ${fullName(scan)}`} data-visitor-photo
                      className="h-auto w-full object-contain" />
                  </button>
                </div>
              </Section>
            </div>
          </div>

          <ImageViewer open={viewerOpen} src={scan.image_url} alt={`צילום התעודה של ${fullName(scan)}`} onClose={() => setViewerOpen(false)} />

          {caps.canManage ? (
            <PanelFooter
              onClose={requestClose} onSave={saveAll}
              saveDisabled={saving || !dirty} saveLabel={saving ? 'שומר…' : 'שמור שינויים'}
              onDelete={() => setConfirmDeleteOpen(true)} deleteLabel="מחק סריקה"
            />
          ) : (
            <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button type="button" variant="outline" onClick={requestClose}>סגור</Button>
            </footer>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת בלי לשמור את השינויים?</AlertDialogTitle>
            <AlertDialogDescription>מה שערכת לא יישמר.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setConfirmCloseOpen(false); onClose(); }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את הסריקה של {fullName(scan)}?</AlertDialogTitle>
            <AlertDialogDescription>
              הרשומה וצילום התעודה יימחקו לצמיתות. אי אפשר לשחזר.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void remove()} disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? 'מוחק…' : 'מחק'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
