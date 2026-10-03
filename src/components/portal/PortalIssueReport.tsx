'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  PORTAL_ISSUE_AREA_MAX, PORTAL_ISSUE_DESCRIPTION_MAX, PORTAL_ISSUE_LOCATION_CHIPS, PORTAL_ISSUE_LOCATION_MAX,
  PORTAL_ISSUE_MAX_IMAGES, PORTAL_IMAGE_MESSAGES, PORTAL_URGENCIES, PORTAL_URGENCY_DEFAULT,
  urgencyLabel, validatePortalIssueReport,
  type PortalIssueField, type PortalIssueReceipt, type PortalUrgency,
} from '@/lib/portal/issueReport';
import { prepareImage } from '@/lib/portal/imagePrep';
import {
  BackIcon, CameraIcon, CheckIcon, CloseIcon, ErrorIcon, ImageIcon, LayersIcon, PinIcon, PlusIcon, SendIcon, UploadIcon,
} from './PortalIcons';

// "דיווח על תקלה" — the owner's fault report (ref/issue-report-form.md, states
// 01–04; the HTML/PNG beside it are the visual reference). Styles: the
// `.pir-*` block of portal-report.css, under `.portal-skin`.
//
// Departures from the reference, decided 03/10/2026 and binding over it:
//   • photos only (no video), up to 5; the counter reads "2/5 תמונות";
//   • state 04 has ONE button, "חזרה לדף הבית", and no tracking, no WhatsApp:
//     "חברת הניהול קיבלה את הדיווח ותטפל בו בהקדם.";
//   • no apartment field — the server takes it from the session.
//
// Behaviour the reference implies but a static mock cannot show:
//   • validation runs on submit; from then on a field that has shown an error
//     re-validates live as it changes. The banner counts what is still wrong;
//     the page scrolls to the first error and focuses it;
//   • the send button LOOKS disabled (#DCE2FF) while a required field is empty
//     and nothing was attempted yet (state 01), but it stays tappable — that
//     tap is how state 03 is reached. It is truly disabled only while a photo
//     is being compressed or the report is being sent;
//   • the "+" tile opens a short "צילום / גלריה" choice; two inputs, because
//     on iOS `capture` hides the gallery: one with capture="environment", one
//     with multiple and no capture. Both reset after every pick.

type Values = { location: string; area: string; description: string };
type Photo = { key: string; file: File | null; url: string | null };

const EMPTY: Values = { location: '', area: '', description: '' };
/** Focusable fields in screen order — the first error gets the focus. */
const FIELD_ORDER = ['location', 'area', 'description'] as const;

function bannerText(n: number): string {
  return n === 1 ? 'יש למלא שדה חובה אחד' : `יש למלא ${n} שדות חובה`;
}

function photosText(n: number): string {
  if (n === 0) return 'ללא';
  return n === 1 ? 'תמונה 1' : `${n} תמונות`;
}

const URGENCY_CLASS: Record<PortalUrgency, string> = { regular: 'u-l', medium: 'u-m', urgent: 'u-h' };

export function PortalIssueReport() {
  const router = useRouter();
  const [values, setValues] = useState<Values>(EMPTY);
  const [urgency, setUrgency] = useState<PortalUrgency>(PORTAL_URGENCY_DEFAULT);
  const [attempted, setAttempted] = useState(false);
  const [shown, setShown] = useState<ReadonlySet<PortalIssueField>>(new Set());
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<PortalIssueReceipt | null>(null);

  // The photo list is also read after an await (a compression finishing), so
  // it lives in a ref that every change goes through, mirrored to state.
  const photosRef = useRef<Photo[]>([]);
  const commitPhotos = (next: Photo[]) => {
    photosRef.current = next;
    setPhotos(next);
  };

  const locationRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    for (const p of photosRef.current) if (p.url) URL.revokeObjectURL(p.url);
  }, []);

  const check = validatePortalIssueReport({ ...values, urgency });
  const live = check.ok ? {} : check.errors;
  const errorOf = (f: PortalIssueField) => (shown.has(f) ? live[f] : undefined);
  const shownErrors = FIELD_ORDER.filter((f) => errorOf(f)).length;

  const processing = photos.some((p) => p.file === null);
  const requiredEmpty = !values.location.trim() || !values.description.trim();
  const looksDisabled = processing || (!attempted && requiredEmpty);

  function set<K extends keyof Values>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  // ── Photos ────────────────────────────────────────────────────────────────

  async function addFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    setPicking(false);
    const room = Math.max(0, PORTAL_ISSUE_MAX_IMAGES - photosRef.current.length);
    const take = files.slice(0, room);
    setPhotoError(files.length > take.length ? PORTAL_IMAGE_MESSAGES.tooMany : null);
    if (take.length === 0) return;

    const pending = take.map((src) => ({ src, key: crypto.randomUUID() }));
    commitPhotos([...photosRef.current, ...pending.map(({ key }) => ({ key, file: null, url: null }))]);

    // One at a time: a phone decoding five 12MP photos at once runs out of memory.
    for (const { src, key } of pending) {
      const r = await prepareImage(src);
      if (!photosRef.current.some((p) => p.key === key)) continue; // removed meanwhile
      if (r.ok) {
        const url = URL.createObjectURL(r.file);
        commitPhotos(photosRef.current.map((p) => (p.key === key ? { key, file: r.file, url } : p)));
      } else {
        commitPhotos(photosRef.current.filter((p) => p.key !== key));
        setPhotoError(r.error);
      }
    }
  }

  function removePhoto(key: string) {
    const gone = photosRef.current.find((p) => p.key === key);
    if (gone?.url) URL.revokeObjectURL(gone.url);
    commitPhotos(photosRef.current.filter((p) => p.key !== key));
    setPhotoError(null);
  }

  function openPicker(which: 'camera' | 'gallery') {
    setPicking(false);
    (which === 'camera' ? cameraRef : galleryRef).current?.click();
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  function focusField(f: (typeof FIELD_ORDER)[number]) {
    const el = { location: locationRef, area: areaRef, description: descriptionRef }[f].current;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus({ preventScroll: true });
  }

  function reveal(errors: Partial<Record<PortalIssueField, string>>) {
    const fields = Object.keys(errors) as PortalIssueField[];
    setShown((prev) => new Set([...prev, ...fields]));
    const first = FIELD_ORDER.find((f) => errors[f]);
    if (first) focusField(first);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || processing) return;
    setAttempted(true);
    const v = validatePortalIssueReport({ ...values, urgency });
    if (!v.ok) {
      reveal(v.errors);
      return;
    }

    setSubmitting(true);
    const body = new FormData();
    body.append('location', values.location);
    body.append('area', values.area);
    body.append('description', values.description);
    body.append('urgency', urgency);
    for (const p of photosRef.current) if (p.file) body.append('images', p.file);

    try {
      const res = await fetch('/api/portal/issues', { method: 'POST', body, credentials: 'include' });
      if (res.status === 401) {
        router.replace('/portal/login');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        report?: PortalIssueReceipt;
        error?: string;
        errors?: Partial<Record<PortalIssueField, string>>;
        message?: string;
      };
      if (res.ok && data.report) {
        setReceipt(data.report);
        window.scrollTo({ top: 0 });
        return;
      }
      if (data.error === 'invalid_fields' && data.errors) reveal(data.errors);
      else if (data.message) setPhotoError(data.message);
      else toast.error('שליחת הדיווח נכשלה. נסו שוב בעוד רגע.');
    } catch {
      toast.error('שליחת הדיווח נכשלה. בדקו את החיבור ונסו שוב.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── 04 · sent ─────────────────────────────────────────────────────────────

  if (receipt) {
    const where = receipt.area ? `${receipt.location} · ${receipt.area}` : receipt.location;
    return (
      <div className="portal-skin">
        <div className="pir">
          <div className="pir-done">
            <span className="pir-ci"><CheckIcon /></span>
            <h1>הדיווח התקבל</h1>
            <p>חברת הניהול קיבלה את הדיווח ותטפל בו בהקדם.</p>
            <dl className="pir-tk">
              <div><dt>מספר קריאה</dt><dd className="num">#{receipt.ticketNumber}</dd></div>
              <div><dt>מיקום</dt><dd>{where}</dd></div>
              <div><dt>דחיפות</dt><dd className={URGENCY_CLASS[receipt.urgency]}>{urgencyLabel(receipt.urgency)}</dd></div>
              <div><dt>תמונות</dt><dd>{photosText(receipt.imageCount)}</dd></div>
            </dl>
            <div className="pir-done-foot">
              <Link href="/portal" className="pir-btn on">חזרה לדף הבית</Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 01–03 · the form ──────────────────────────────────────────────────────

  const locErr = errorOf('location');
  const areaErr = errorOf('area');
  const descErr = errorOf('description');
  const count = photos.length;

  return (
    <div className="portal-skin">
      <div className="pir">
        <header className="pir-hd">
          <Link href="/portal" className="pir-icb" aria-label="חזרה לדף הבית"><BackIcon /></Link>
          <div className="pir-tt">
            <h1>דיווח על תקלה</h1>
            <small>פתיחת קריאת שירות</small>
          </div>
        </header>

        <form id="pir-form" className="pir-body" noValidate onSubmit={onSubmit}>
          {attempted && shownErrors > 0 && (
            <div className="pir-banner" role="alert"><ErrorIcon />{bannerText(shownErrors)}</div>
          )}

          <div className="pir-fld">
            <label className="pir-lb" htmlFor="pir-location">
              <span>מיקום<span className="req" aria-hidden>*</span></span>
            </label>
            <div className={cn('pir-inp', values.location && 'fill', locErr && 'err')}>
              <span className="ic"><PinIcon /></span>
              <input
                ref={locationRef}
                id="pir-location"
                value={values.location}
                onChange={(e) => set('location', e.target.value)}
                maxLength={PORTAL_ISSUE_LOCATION_MAX}
                placeholder="למשל: לובי, חדר מדרגות, חניון"
                autoComplete="off"
                enterKeyHint="next"
                required
                aria-invalid={!!locErr}
                aria-describedby={locErr ? 'pir-location-err' : undefined}
              />
            </div>
            {!values.location && (
              <div className="pir-sugg">
                {PORTAL_ISSUE_LOCATION_CHIPS.map((c) => (
                  <button key={c} type="button" onClick={() => set('location', c)}>{c}</button>
                ))}
              </div>
            )}
            {locErr && <div className="pir-help e" id="pir-location-err"><ErrorIcon />{locErr}</div>}
          </div>

          <div className="pir-fld">
            <label className="pir-lb" htmlFor="pir-area">קומה / אזור</label>
            <div className={cn('pir-inp', values.area && 'fill', areaErr && 'err')}>
              <span className="ic"><LayersIcon /></span>
              <input
                ref={areaRef}
                id="pir-area"
                value={values.area}
                onChange={(e) => set('area', e.target.value)}
                maxLength={PORTAL_ISSUE_AREA_MAX}
                placeholder="למשל: קומה 3, ליד דירה 12"
                autoComplete="off"
                enterKeyHint="next"
                aria-invalid={!!areaErr}
                aria-describedby={areaErr ? 'pir-area-err' : undefined}
              />
            </div>
            {areaErr && <div className="pir-help e" id="pir-area-err"><ErrorIcon />{areaErr}</div>}
          </div>

          <div className="pir-fld">
            <label className="pir-lb" htmlFor="pir-description">
              <span>תיאור התקלה<span className="req" aria-hidden>*</span></span>
            </label>
            <div className={cn('pir-inp ta', values.description && 'fill', descErr && 'err')}>
              <textarea
                ref={descriptionRef}
                id="pir-description"
                value={values.description}
                onChange={(e) => set('description', e.target.value)}
                maxLength={PORTAL_ISSUE_DESCRIPTION_MAX}
                placeholder="מה קרה? ממתי? האם זה מסוכן?"
                required
                aria-invalid={!!descErr}
                aria-describedby={descErr ? 'pir-description-err' : 'pir-description-help'}
              />
            </div>
            {descErr ? (
              <div className="pir-help e" id="pir-description-err"><ErrorIcon />{descErr}</div>
            ) : (
              <div className="pir-help" id="pir-description-help">
                <span>{values.description ? '' : 'ככל שהתיאור מפורט יותר, הטיפול מהיר יותר'}</span>
                <span className="num">{values.description.length}/{PORTAL_ISSUE_DESCRIPTION_MAX}</span>
              </div>
            )}
          </div>

          <div className="pir-fld">
            <div className="pir-lb" id="pir-urgency-label">דחיפות</div>
            <div className="pir-urg" role="radiogroup" aria-labelledby="pir-urgency-label">
              {PORTAL_URGENCIES.map((u) => (
                <button
                  key={u.key}
                  type="button"
                  role="radio"
                  aria-checked={urgency === u.key}
                  className={cn(URGENCY_CLASS[u.key], urgency === u.key && 'on')}
                  onClick={() => setUrgency(u.key)}
                >
                  <i aria-hidden />{u.label}
                </button>
              ))}
            </div>
          </div>

          <div className="pir-sec">
            <div className="pir-lb">
              <span>תמונות</span>
              <small><span className="num">{count}/{PORTAL_ISSUE_MAX_IMAGES}</span> תמונות</small>
            </div>

            {count === 0 ? (
              <div className="pir-med">
                <button type="button" className="pir-tile" onClick={() => openPicker('camera')}>
                  <span className="ti"><CameraIcon /></span>צילום תמונה
                </button>
                <button type="button" className="pir-tile" onClick={() => openPicker('gallery')}>
                  <span className="ti"><UploadIcon /></span>בחירה מהגלריה
                </button>
              </div>
            ) : (
              <>
                <div className="pir-thumbs">
                  {photos.map((p, i) => (
                    <span key={p.key} className={cn('pir-th', (p.file === null || submitting) && 'busy')}>
                      {p.url
                        // eslint-disable-next-line @next/next/no-img-element -- a local object URL; next/image cannot optimise it
                        ? <img src={p.url} alt={`תמונה ${i + 1}`} />
                        : <ImageIcon />}
                      {(p.file === null || submitting) && <span className="spin" role="status" aria-label={p.file === null ? 'מעבד תמונה' : 'שולח'} />}
                      {!submitting && (
                        <button type="button" className="x" aria-label={`הסרת תמונה ${i + 1}`} onClick={() => removePhoto(p.key)}>
                          <CloseIcon />
                        </button>
                      )}
                    </span>
                  ))}
                  {count < PORTAL_ISSUE_MAX_IMAGES && (
                    <button
                      type="button"
                      className="pir-th add"
                      aria-label="הוספת תמונה"
                      aria-expanded={picking}
                      aria-controls="pir-pick"
                      disabled={submitting}
                      onClick={() => setPicking((o) => !o)}
                    >
                      <PlusIcon />
                    </button>
                  )}
                </div>
                {picking && count < PORTAL_ISSUE_MAX_IMAGES && (
                  <div className="pir-pick" id="pir-pick">
                    <button type="button" onClick={() => openPicker('camera')}><CameraIcon />צילום</button>
                    <button type="button" onClick={() => openPicker('gallery')}><UploadIcon />גלריה</button>
                  </div>
                )}
              </>
            )}
            {photoError && <div className="pir-help e" role="alert"><ErrorIcon />{photoError}</div>}

            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }}
            />
            <input
              ref={galleryRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }}
            />
          </div>
        </form>

        <footer className="pir-foot">
          <button
            type="submit"
            form="pir-form"
            className={cn('pir-btn', looksDisabled ? 'dis' : 'on')}
            disabled={processing || submitting}
          >
            {submitting ? <><span className="spin" />שולח…</> : <>{!looksDisabled && <SendIcon />}שליחת הדיווח</>}
          </button>
        </footer>
      </div>
    </div>
  );
}
