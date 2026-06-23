import { NextResponse } from 'next/server';
import { requirePermission, requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { verifyPassword } from '@/lib/auth/password';
import { queryOne } from '@/lib/db';
import { createImportRun, type ImportMode } from '@/lib/db/importRuns';
import { runImport } from '@/lib/import/runner';
import { MAX_EXCEL_BYTES } from '@/lib/excel/workbook';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let actor: Actor;
  try {
    actor = await requirePermission('import', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const file = form.get('file');
  const modeRaw = String(form.get('mode') ?? '');
  const mode: ImportMode | null =
    modeRaw === 'merge' || modeRaw === 'replace' ? modeRaw : null;

  if (!(file instanceof File) || !mode) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'file_required' }, { status: 400 });
  }
  if (file.size > MAX_EXCEL_BYTES) {
    return NextResponse.json({ error: 'file_too_large' }, { status: 400 });
  }
  // ExcelJS reads .xlsx only (legacy .xls dropped with the xlsx→exceljs migration).
  if (!(file.name || '').toLowerCase().endsWith('.xlsx')) {
    return NextResponse.json({ error: 'invalid_file_type' }, { status: 400 });
  }

  if (mode === 'replace') {
    // Destructive replace requires admin (super_admin/admin) in addition to import:edit.
    try {
      await requireAdmin();
    } catch (err) {
      const r = authErrorResponse(err);
      if (r) return r;
      throw err;
    }

    // Extra factor: re-authenticate with the actor's own password.
    const adminPassword = String(form.get('adminPassword') ?? '');
    if (!adminPassword) {
      return NextResponse.json({ error: 'password_required' }, { status: 400 });
    }
    const userRow = await queryOne<{ password_hash: string }>(
      `select password_hash from public.users where id = $1`,
      [actor.id],
    );
    if (!userRow) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    const ok = await verifyPassword(adminPassword, userRow.password_hash);
    if (!ok) {
      return NextResponse.json({ error: 'invalid_password' }, { status: 400 });
    }
  }

  const buffer = await file.arrayBuffer();
  const runId = await createImportRun(mode, actor.id);

  // Fire-and-forget; the function never throws (errors recorded into import_runs row).
  void runImport(buffer, mode, runId);

  return NextResponse.json({ runId });
}
