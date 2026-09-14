// WhatsApp BROADCAST attachments — the single source of truth for what may be
// attached to a campaign ("תפוצה חדשה") and how big it may be. Isomorphic on
// purpose: the compose screen pre-checks with it and the upload route enforces
// it (the server is authoritative). Kept apart from src/lib/whatsapp-attachment.ts,
// which is the older single-file policy of the debtor card (10MB, 7 extensions).
//
// Where the numbers come from:
//   • Per-kind caps (images / video / audio 16 MB, up to 10 files, 100 MB per
//     broadcast) are the PRODUCT rule of this feature — "like regular WhatsApp".
//   • Green API (green-api.com docs, read 14/09/2026): every file method
//     (uploadFile / sendFileByUpload / sendFileByUrl) accepts up to 100 MB per
//     file; a caption is at most 1024 chars; the link uploadFile returns is
//     valid for 15 days. Green publishes no per-media-type limits.
//   • The self-hosted Supabase Storage on this box caps an object at 50 MB
//     (FILE_SIZE_LIMIT=52428800 in /opt/supabase/docker/docker-compose.yml and
//     client_max_body_size 50M on the Supabase nginx vhost). That is the
//     binding limit for documents today — raising it is an infra change to the
//     shared Supabase, not an app change. When it is raised, bump
//     STORAGE_MAX_BYTES and the document cap follows. The billing vhost itself
//     (client_max_body_size, /etc/nginx/sites-available/billing) must stay
//     above the largest single upload + multipart overhead (set to 120M).

const MB = 1024 * 1024;

export type WhatsAppAttachmentKind = 'image' | 'video' | 'audio' | 'document';

/** Green API: per-file ceiling on every file method. */
export const GREEN_API_MAX_FILE_BYTES = 100 * MB;
/** Self-hosted Supabase Storage FILE_SIZE_LIMIT (see header). */
export const STORAGE_MAX_BYTES = 50 * MB;

export const WHATSAPP_ATTACHMENT_LIMITS = {
  /** Files per broadcast. */
  maxFiles: 10,
  /** Sum of all files in one broadcast. */
  maxTotalBytes: 100 * MB,
  /** Text sent as the file caption (single-file broadcasts) — Green API cap. */
  captionMaxChars: 1024,
  /** Lifetime of the link Green API `uploadFile` returns. */
  greenApiUrlLifetimeDays: 15,
  kinds: {
    image:    { label: 'תמונות',  maxBytes: 16 * MB, exts: ['jpg', 'jpeg', 'png', 'webp'] },
    video:    { label: 'וידאו',   maxBytes: 16 * MB, exts: ['mp4', '3gp'] },
    audio:    { label: 'אודיו',   maxBytes: 16 * MB, exts: ['mp3', 'ogg', 'm4a'] },
    // WhatsApp allows 100 MB, but the lower storage cap wins (see header).
    document: { label: 'מסמכים', maxBytes: Math.min(100 * MB, GREEN_API_MAX_FILE_BYTES, STORAGE_MAX_BYTES),
                exts: ['pdf', 'xlsx', 'xls', 'csv', 'docx', 'doc', 'pptx', 'txt', 'zip'] },
  },
} as const satisfies {
  maxFiles: number; maxTotalBytes: number; captionMaxChars: number; greenApiUrlLifetimeDays: number;
  kinds: Record<WhatsAppAttachmentKind, { label: string; maxBytes: number; exts: readonly string[] }>;
};

/** Extension → canonical MIME (what we store and tell Green API) + the MIME
 *  values browsers are known to report for it. Browsers are flaky for Office /
 *  CSV / audio, so the extension is the authoritative signal and the reported
 *  MIME only has to be consistent with it (or empty / octet-stream). */
const EXT_MIME: Record<string, { canonical: string; accepted: readonly string[] }> = {
  jpg:  { canonical: 'image/jpeg', accepted: ['image/jpeg', 'image/pjpeg'] },
  jpeg: { canonical: 'image/jpeg', accepted: ['image/jpeg', 'image/pjpeg'] },
  png:  { canonical: 'image/png',  accepted: ['image/png'] },
  webp: { canonical: 'image/webp', accepted: ['image/webp'] },
  mp4:  { canonical: 'video/mp4',  accepted: ['video/mp4', 'application/mp4'] },
  '3gp': { canonical: 'video/3gpp', accepted: ['video/3gpp', 'audio/3gpp'] },
  mp3:  { canonical: 'audio/mpeg', accepted: ['audio/mpeg', 'audio/mp3', 'audio/x-mpeg'] },
  ogg:  { canonical: 'audio/ogg',  accepted: ['audio/ogg', 'application/ogg', 'video/ogg'] },
  m4a:  { canonical: 'audio/mp4',  accepted: ['audio/mp4', 'audio/x-m4a', 'audio/m4a'] },
  pdf:  { canonical: 'application/pdf', accepted: ['application/pdf'] },
  xlsx: { canonical: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          accepted: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
  xls:  { canonical: 'application/vnd.ms-excel', accepted: ['application/vnd.ms-excel'] },
  csv:  { canonical: 'text/csv', accepted: ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'] },
  docx: { canonical: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          accepted: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  doc:  { canonical: 'application/msword', accepted: ['application/msword'] },
  pptx: { canonical: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          accepted: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] },
  txt:  { canonical: 'text/plain', accepted: ['text/plain'] },
  zip:  { canonical: 'application/zip', accepted: ['application/zip', 'application/x-zip-compressed', 'application/x-zip', 'multipart/x-zip'] },
};

/** Lower-case extension without the dot, or '' when none. */
export function attachmentExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** The kind an extension belongs to, or null when it is not allowed. */
export function attachmentKind(ext: string): WhatsAppAttachmentKind | null {
  for (const kind of Object.keys(WHATSAPP_ATTACHMENT_LIMITS.kinds) as WhatsAppAttachmentKind[]) {
    if ((WHATSAPP_ATTACHMENT_LIMITS.kinds[kind].exts as readonly string[]).includes(ext)) return kind;
  }
  return null;
}

/** Canonical MIME for an allowed extension (what is stored / sent), or null. */
export function canonicalMime(ext: string): string | null {
  return EXT_MIME[ext]?.canonical ?? null;
}

/** `accept` attribute for the file input — every allowed extension. */
export const WHATSAPP_ATTACHMENT_ACCEPT = Object.keys(EXT_MIME).map((e) => `.${e}`).join(',');

/** Human list of what is allowed, for helper texts and error messages. */
export const WHATSAPP_ATTACHMENT_TYPES_LABEL =
  'PDF, Excel/CSV, Word, PowerPoint, TXT, ZIP · תמונות (JPG/PNG/WEBP) · וידאו (MP4/3GP) · אודיו (MP3/OGG/M4A)';

export function formatMb(bytes: number): string {
  const mb = bytes / MB;
  return `${mb >= 10 || Number.isInteger(mb) ? Math.round(mb) : Math.round(mb * 10) / 10}MB`;
}

export interface AttachmentCandidate {
  name: string;
  size: number;
  /** Browser-reported MIME ('' when unknown). */
  type?: string;
}

/** Validate ONE file against the type / MIME / size rules. Returns a Hebrew
 *  error, or null when acceptable. Pure — same result on client and server. */
export function validateBroadcastAttachment(file: AttachmentCandidate): string | null {
  const ext = attachmentExt(file.name);
  const kind = ext ? attachmentKind(ext) : null;
  if (!kind) {
    return `סוג הקובץ אינו נתמך («${file.name}»). מותר: ${WHATSAPP_ATTACHMENT_TYPES_LABEL}`;
  }
  const mime = (file.type ?? '').trim().toLowerCase();
  if (mime && mime !== 'application/octet-stream' && !EXT_MIME[ext].accepted.includes(mime)) {
    return `תוכן הקובץ «${file.name}» אינו תואם לסיומת ${ext.toUpperCase()}`;
  }
  if (file.size <= 0) return `הקובץ «${file.name}» ריק`;
  const { label, maxBytes } = WHATSAPP_ATTACHMENT_LIMITS.kinds[kind];
  if (file.size > maxBytes) {
    return `${label} עד ${formatMb(maxBytes)} — «${file.name}» שוקל ${formatMb(file.size)}`;
  }
  return null;
}

/** Validate the broadcast-level rules (count + total size) for adding `next`
 *  on top of `existing`. Returns a Hebrew error, or null. */
export function validateBroadcastAttachmentSet(
  existing: ReadonlyArray<{ size: number }>,
  next: ReadonlyArray<{ size: number }> = [],
): string | null {
  const count = existing.length + next.length;
  if (count > WHATSAPP_ATTACHMENT_LIMITS.maxFiles) {
    return `ניתן לצרף עד ${WHATSAPP_ATTACHMENT_LIMITS.maxFiles} קבצים לתפוצה`;
  }
  const total = [...existing, ...next].reduce((s, f) => s + f.size, 0);
  if (total > WHATSAPP_ATTACHMENT_LIMITS.maxTotalBytes) {
    return `סך הקבצים המצורפים חורג מ-${formatMb(WHATSAPP_ATTACHMENT_LIMITS.maxTotalBytes)}`;
  }
  return null;
}
