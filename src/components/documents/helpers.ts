import {
  File as FileIcon,
  FileText,
  FileImage,
  FileSpreadsheet,
  type LucideIcon,
} from 'lucide-react';

/** Icon + DESIGN tone for a file, derived from its mime type. */
export function fileMeta(mime: string | null): { Icon: LucideIcon; tone: string } {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return { Icon: FileImage, tone: 'bg-violet-100 text-violet-600' };
  if (m === 'application/pdf') return { Icon: FileText, tone: 'bg-rose-100 text-rose-600' };
  if (m.includes('spreadsheet') || m.includes('ms-excel') || m === 'text/csv') {
    return { Icon: FileSpreadsheet, tone: 'bg-emerald-100 text-emerald-600' };
  }
  if (m.includes('word') || m === 'text/plain') return { Icon: FileText, tone: 'bg-blue-100 text-blue-600' };
  return { Icon: FileIcon, tone: 'bg-slate-100 text-slate-600' };
}

/** Human-readable file size. null/0 → '—'. */
export function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const n = v >= 10 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${n} ${units[i]}`;
}

/** Short he-IL date (dd/mm/yyyy). Empty on parse failure. */
export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Intl.DateTimeFormat('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(t));
}

/** Maps an API error code to a short Hebrew toast message (DESIGN §13). */
export function documentErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'invalid_file_type':
      return 'סוג קובץ לא נתמך';
    case 'file_too_large':
      return 'הקובץ גדול מדי (מקסימום 25MB)';
    case 'storage_not_configured':
      return 'האחסון אינו מוגדר — חסר מפתח שירות. פנה למנהל המערכת';
    case 'upload_failed':
      return 'העלאת הקובץ נכשלה';
    case 'folder_not_found':
    case 'parent_not_found':
      return 'התיקייה לא נמצאה';
    case 'folder_cycle':
      return 'לא ניתן להעביר תיקייה לתוך עצמה';
    case 'name_required':
    case 'file_name_required':
      return 'יש להזין שם';
    case 'name_too_long':
    case 'file_name_too_long':
      return 'השם ארוך מדי';
    default:
      return code ? `הפעולה נכשלה: ${code}` : 'הפעולה נכשלה';
  }
}
