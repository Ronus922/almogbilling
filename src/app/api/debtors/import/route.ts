import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { verifyPassword } from '@/lib/auth/password';
import { queryOne } from '@/lib/db';
import { createImportRun, type ImportMode } from '@/lib/db/importRuns';
import { runImport } from '@/lib/import/runner';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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

  if (mode === 'replace') {
    const adminPassword = String(form.get('adminPassword') ?? '');
    if (!adminPassword) {
      return NextResponse.json({ error: 'password_required' }, { status: 400 });
    }
    const userRow = await queryOne<{ password_hash: string }>(
      `select password_hash from public.users where id = $1`,
      [session.user.id],
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
  const runId = await createImportRun(mode, session.user.id);

  // Fire-and-forget; the function never throws (errors recorded into import_runs row).
  void runImport(buffer, mode, runId);

  return NextResponse.json({ runId });
}
