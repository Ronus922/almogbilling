import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { commitParkingImport, previewParkingImport } from '@/lib/parking/importRunner';
import { importErrorFromThrown } from '@/lib/excel/import-errors';
import { MAX_EXCEL_BYTES } from '@/lib/excel/workbook';

export const runtime = 'nodejs';

// POST /api/parking/import — ADMIN ONLY (super_admin | admin).
//
// A stricter guard than the rest of the module, which runs on parking:edit: an
// import rewrites the whole lot in one action, so it is not the same privilege
// as editing one spot. The page hides the button for non-admins rather than
// showing it and rejecting the click.
//
// multipart/form-data: file=<xlsx>, mode=preview|commit.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'הבקשה אינה תקינה', code: 'invalid_request' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'לא נבחר קובץ', code: 'file_required' }, { status: 400 });
  }
  if (file.size > MAX_EXCEL_BYTES) {
    return NextResponse.json({ error: 'הקובץ גדול מדי (מקסימום 10MB)', code: 'file_too_large' }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    return NextResponse.json(
      { error: 'פורמט הקובץ אינו נתמך. שמור כ-.xlsx ונסה שוב.', code: 'invalid_file_type' },
      { status: 400 },
    );
  }

  const mode = String(form.get('mode') ?? 'preview');
  if (mode !== 'preview' && mode !== 'commit') {
    return NextResponse.json({ error: 'מצב ייבוא לא נתמך', code: 'invalid_mode' }, { status: 400 });
  }

  try {
    const buffer = await file.arrayBuffer();
    if (mode === 'preview') {
      return NextResponse.json({ mode, ...(await previewParkingImport(buffer)) });
    }
    const result = await commitParkingImport(buffer, actor.id);
    // A commit that wrote nothing because the file still has problems is not a
    // success — say so, rather than reporting "0 נוספו" as though it worked.
    if (result.inserted === 0 && result.updated === 0
      && (result.errors.length > 0
        || result.duplicateSpotNumbers.length > 0
        || result.unknownApartments.length > 0)) {
      return NextResponse.json(
        { mode, ...result, error: 'הייבוא לא בוצע — יש לתקן את השגיאות בקובץ', code: 'import_has_errors' },
        { status: 400 },
      );
    }
    return NextResponse.json({ mode, ...result });
  } catch (err) {
    console.error('[POST /api/parking/import]', err);
    return NextResponse.json({ error: importErrorFromThrown(err), code: 'import_failed' }, { status: 400 });
  }
}
