import { NextResponse } from 'next/server';
import { writeFile } from 'node:fs/promises';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { createContactsImportRun, runContactsImport } from '@/lib/contacts/import-runner';

export const runtime = 'nodejs';

// POST /api/contacts/import — contacts:edit. Accepts an .xlsx/.xls residents file,
// creates the import run, kicks off the async runner, and returns the runId
// immediately (merge-only; no mode parameter is exposed).
export async function POST(req: Request) {
  let actor: Actor;
  try {
    actor = await requirePermission('contacts', 'edit');
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
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'file_required' }, { status: 400 });
  }
  // mime is unreliable — gate on the extension.
  const name = file.name || '';
  const lower = name.toLowerCase();
  if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
    return NextResponse.json({ error: 'invalid_file_type' }, { status: 400 });
  }

  const runId = await createContactsImportRun(name, actor.id);
  const filePath = `/tmp/billing-contacts-import-${runId}.xlsx`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(filePath, buffer);

  // Fire-and-forget; the runner never throws (errors recorded on the run row).
  void runContactsImport(runId, filePath);

  return NextResponse.json({ runId }, { status: 201 });
}
