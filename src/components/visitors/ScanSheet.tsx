'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, IdCard, Loader2, ScanLine, X, Info } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import type { OcrField, OcrResponse } from '@/lib/visitors/model';
import { CropEditor } from './CropEditor';
import { VisitorForm } from './VisitorForm';
import {
  blobFromBase64, EMPTY_FORM, formFromOcr, lowConfidenceFields, toPayload, validateForm,
  type FormErrors, type VisitorFormValues,
} from './format';

// The create flow of one scan, opened by the screen's "סרוק תעודה" once a photo
// exists: photo → CROP (the guard fits a frame around the document, in the browser)
// → OCR (the server normalises the CROPPED photo and Claude reads it) → a form
// pre-filled from the document, every field editable → "שמור". The uncropped photo
// never leaves the phone (the one exception is a file the browser cannot draw — a
// HEIC outside Safari — which is sent to /api/visitors/prepare to be turned into a
// JPEG, and is not stored). The cropped photo reaches Storage only on the last click;
// closing before it leaves nothing.
//
// Sheet, not Dialog (DESIGN §12): a create form always opens in the side panel,
// which on a phone is the whole screen.

interface Props {
  /** The photo the guard just took; null = closed. */
  file: File | null;
  /** An object URL of that photo, for the crop step to draw (the parent owns and revokes it). */
  previewUrl: string | null;
  onClose: () => void;
  onSaved: () => void;
  /** Take another photo (the photo could not be opened). */
  onRetake: () => void;
}

type Phase = 'crop' | 'preparing' | 'reading' | 'ready' | 'unreadable';

export function ScanSheet({ file, previewUrl, onClose, onSaved, onRetake }: Props) {
  const [phase, setPhase] = useState<Phase>('crop');
  // A file the browser could not draw, as the server turned it into a JPEG (see onLoadError).
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const fallbackRef = useRef<string | null>(null);
  // What the guard framed: the only picture that is read and stored.
  const [cropped, setCropped] = useState<Blob | null>(null);
  const [problem, setProblem] = useState('');
  const [ocrOk, setOcrOk] = useState(true);
  const [imageB64, setImageB64] = useState('');
  const [imageType, setImageType] = useState('image/webp');
  const [values, setValues] = useState<VisitorFormValues>(EMPTY_FORM);
  const [low, setLow] = useState<ReadonlySet<OcrField>>(new Set());
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);

  const open = file !== null;

  // The server's JPEG of a file the browser cannot draw lives as long as this sheet; closing it also
  // abandons a /prepare that is still on its way (its blob URL would otherwise never be freed).
  const prepareCtl = useRef<AbortController | null>(null);
  useEffect(() => () => {
    prepareCtl.current?.abort();
    if (fallbackRef.current) URL.revokeObjectURL(fallbackRef.current);
  }, []);

  // Step 2 — normalise + read the CROPPED photo. The parent gives every new photo a new `key`,
  // so this component starts from the 'crop' state each time — nothing to reset here.
  useEffect(() => {
    // `open` is part of the condition: a sheet closed during the last moments of the crop must not
    // send the abandoned photo to the OCR (and closing mid-read aborts the request).
    if (!cropped || !open) return;
    const ctl = new AbortController();

    (async () => {
      try {
        const fd = new FormData();
        fd.append('image', cropped, 'scan.jpg');
        const r = await fetch('/api/visitors/ocr', { method: 'POST', body: fd, credentials: 'include', signal: ctl.signal });
        const data = (await r.json().catch(() => ({}))) as Partial<OcrResponse> & { error?: string };
        if (!r.ok || !data.fields || !data.image_base64) {
          setProblem(data.error ?? 'לא ניתן לפתוח את התמונה — צלם שוב');
          setPhase('unreadable');
          return;
        }
        setImageB64(data.image_base64);
        setImageType(data.image_type ?? 'image/webp');
        setOcrOk(data.ok === true);
        setValues(formFromOcr(data.fields));
        setLow(lowConfidenceFields({ fields: data.fields, confidence: data.confidence ?? {} }));
        setPhase('ready');
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setProblem('החיבור נכשל — בדוק את הקליטה ונסה שוב');
        setPhase('unreadable');
      }
    })();
    return () => ctl.abort();
  }, [cropped, open]);

  // The browser could not draw the photo (a HEIC outside Safari, a format it lacks). The server
  // already owns a decoder for it: send the file once, get an upright JPEG back, crop THAT. If even
  // that cannot be drawn there is nothing more to try — say so.
  async function onLoadError() {
    if (!file || fallbackUrl) {
      setProblem('לא ניתן לפתוח את התמונה — צלם שוב');
      setPhase('unreadable');
      return;
    }
    setPhase('preparing');
    const ctl = new AbortController();
    prepareCtl.current = ctl;
    try {
      const fd = new FormData();
      fd.append('image', file, file.name || 'scan.jpg');
      const r = await fetch('/api/visitors/prepare', { method: 'POST', body: fd, credentials: 'include', signal: ctl.signal });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        setProblem(data.error ?? 'לא ניתן לפתוח את התמונה — צלם שוב');
        setPhase('unreadable');
        return;
      }
      const url = URL.createObjectURL(await r.blob());
      fallbackRef.current = url;
      setFallbackUrl(url);
      setPhase('crop');
    } catch (e) {
      if ((e as Error).name === 'AbortError') return; // the sheet was closed: nothing to show
      setProblem('החיבור נכשל — בדוק את הקליטה ונסה שוב');
      setPhase('unreadable');
    }
  }

  function onCropped(blob: Blob) {
    if (!open) return; // closed while the canvas was being encoded
    setCropped(blob);
    setPhase('reading');
  }

  useEscapeKey(open && !confirmCloseOpen, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (saving) return;
    // A read photo is unsaved work: closing it deserves a second tap. Before the OCR there is
    // nothing yet to lose (the crop is a few seconds of work and the photo can be retaken).
    if (phase === 'ready') setConfirmCloseOpen(true);
    else onClose();
  }

  function patch(p: Partial<VisitorFormValues>) {
    setValues((v) => ({ ...v, ...p }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(p) as (keyof VisitorFormValues)[]) delete next[k];
      return next;
    });
  }

  async function save() {
    const found = validateForm(values);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      toast.error('חסרים פרטים חובה');
      return;
    }
    setSaving(true);
    try {
      const fd = new FormData();
      // The photo is the compressed one the OCR step returned, posted back unchanged; its name is the
      // camera's own with the new extension (IMG_0001.HEIC → IMG_0001.webp).
      const base = ((file?.name ?? '').replace(/\.[^.]+$/, '') || 'scan').slice(0, 120);
      fd.append('image', blobFromBase64(imageB64, imageType), `${base}.${imageType === 'image/jpeg' ? 'jpg' : 'webp'}`);
      fd.append('data', JSON.stringify(toPayload(values)));
      const r = await fetch('/api/visitors', { method: 'POST', body: fd, credentials: 'include' });
      const data = (await r.json().catch(() => ({}))) as { error?: string; duplicate?: boolean };
      if (!r.ok) throw new Error(data.error ?? 'שמירת הסריקה נכשלה');
      toast.success(data.duplicate ? 'הסריקה כבר נשמרה הרגע — לא נוצרה כפילות' : 'הסריקה נשמרה');
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
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
                <SheetTitle className="text-2xl font-bold text-white">סריקת תעודה</SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {phase === 'crop'
                    ? 'סמן את התעודה בלבד ולחץ „המשך”.'
                    : phase === 'preparing' || phase === 'reading'
                      ? (phase === 'reading' ? 'קורא את התעודה…' : 'מכין את התמונה…')
                      : 'בדוק את הפרטים, מלא חדר / צ׳יפ / טלפון ושמור.'}
                </p>
              </div>
              <button
                type="button" onClick={requestClose} aria-label="סגור" disabled={saving}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50 disabled:opacity-60"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          {phase === 'crop' && open ? (
            <CropEditor
              src={fallbackUrl ?? previewUrl ?? ''} initial="auto"
              confirmLabel="המשך" cancelLabel="צלם שוב"
              onConfirm={onCropped} onCancel={onRetake} onLoadError={() => void onLoadError()}
            />
          ) : (
          <>
          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            {(phase === 'reading' || phase === 'preparing') && (
              <div role="status" aria-live="polite" className="flex flex-col items-center gap-4 rounded-lg border border-slate-200 bg-white p-8 text-center">
                <Loader2 className="h-9 w-9 animate-spin text-brand" aria-hidden />
                <div className="text-lg font-bold text-slate-900">{phase === 'reading' ? 'קורא את התעודה…' : 'מכין את התמונה…'}</div>
                <div className="text-sm text-slate-500">זה לוקח כמה שניות. אפשר לא לסגור את החלון.</div>
              </div>
            )}

            {phase === 'unreadable' && (
              <div role="alert" className="flex flex-col items-center gap-4 rounded-lg border border-red-200 bg-red-50 p-8 text-center">
                <AlertTriangle className="h-9 w-9 text-red-500" aria-hidden />
                <div className="text-lg font-bold text-slate-900">{problem}</div>
                <Button type="button" onClick={onRetake} className="gap-2">
                  <ScanLine className="h-4 w-4" aria-hidden />
                  צלם שוב
                </Button>
              </div>
            )}

            {phase === 'ready' && (
              <div className="space-y-4">
                {ocrOk ? (
                  <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>הפרטים נקראו מהתעודה. בדוק מול הצילום ותקן לפני שמירה{low.size > 0 ? ' — שדות מסומנים בצהוב נקראו בביטחון נמוך' : ''}.</span>
                  </div>
                ) : (
                  <div role="alert" className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>לא הצלחנו לקרוא את התעודה אוטומטית — מלא את הפרטים ידנית מהצילום.</span>
                  </div>
                )}

                {/* eslint-disable-next-line @next/next/no-img-element -- a one-off data: URL of the cropped photo; next/image cannot optimise it */}
                <img
                  src={`data:${imageType};base64,${imageB64}`} alt="צילום התעודה"
                  className="mx-auto max-h-72 w-full rounded-lg border border-slate-200 bg-white object-contain"
                />

                <Section title="פרטי המסמך" icon={IdCard} iconTone="blue">
                  <div className="py-2">
                    <VisitorForm values={values} onChange={patch} errors={errors} lowConfidence={low} disabled={saving} />
                  </div>
                </Section>
              </div>
            )}
          </div>

          <PanelFooter
            onClose={requestClose}
            onSave={() => void save()}
            saveDisabled={phase !== 'ready' || saving}
            saveLabel={saving ? 'שומר…' : 'שמור'}
          />
          </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת בלי לשמור את הסריקה?</AlertDialogTitle>
            <AlertDialogDescription>הצילום והפרטים לא יישמרו. אפשר לסרוק שוב בכל עת.</AlertDialogDescription>
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
    </>
  );
}
