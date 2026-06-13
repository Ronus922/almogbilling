import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { fetchBllinkTenants, mapBllinkTenantToContact } from '@/lib/bllink/client';
import { upsertContactAndLinkDebtor } from '@/lib/db/contacts';
import type { ContactWritableFields } from '@/lib/types/contacts';

export const runtime = 'nodejs';
export const maxDuration = 300;

// The only columns this sync owns — Track A's upsert drops everything else, so
// manual fields (notes, tags, address, emails, primary-contact flags) are never
// clobbered by Bllink data.
const SYNC_ALLOWED_FIELDS = [
  'apartment_number',
  'owner_name',
  'owner_phone',
  'tenant_name',
  'tenant_phone',
];

/**
 * POST /api/sync/contacts — pull Bllink residents (tenants endpoint) into the
 * contacts table and link each to its debtor. Admin only. Distinct from the
 * existing /api/sync/bllink debts sync — this writes contacts, not debt data.
 */
export async function POST() {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  if (!process.env.BLLINK_USERNAME || !process.env.BLLINK_PASSWORD) {
    return NextResponse.json(
      { ok: false, error: 'BLLINK credentials not configured' },
      { status: 500 },
    );
  }

  const startedAt = Date.now();

  try {
    const rows = await fetchBllinkTenants();

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const totalRows = rows.length;
    const failedRows: Array<{ apartment_number?: string; error: string }> = [];

    // Sequential on purpose: keep DB transactions off the connection pool's
    // limit and preserve row order for predictable logging.
    for (const row of rows) {
      const mapped = mapBllinkTenantToContact(row);
      if (!mapped.apartment_number) {
        skipped++;
        continue;
      }
      try {
        const { created: wasCreated } = await upsertContactAndLinkDebtor(
          mapped as Partial<ContactWritableFields> & { apartment_number: string },
          { allowedFields: SYNC_ALLOWED_FIELDS },
        );
        if (wasCreated) created++;
        else updated++;
      } catch (e) {
        failed++;
        failedRows.push({
          apartment_number: mapped.apartment_number,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return NextResponse.json({
      ok: true,
      summary: {
        totalRows,
        created,
        updated,
        skipped,
        failed,
        durationMs: Date.now() - startedAt,
      },
      failedSample: failedRows.slice(0, 20),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
