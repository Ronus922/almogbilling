// Usage:
//   npx tsx scripts/clean-phone-fields.ts            # DRY-RUN (prints 20 before/after, writes nothing)
//   npx tsx scripts/clean-phone-fields.ts --apply    # backup → clean → report
//
// One-shot data migration (see supabase/migrations/015_phone_cleanup.sql for the
// schema/backup columns). Normalises debtors.phone_owner / phone_tenant to a
// single clean local number each, using the SAME shared helpers as the import
// and Bllink-sync entry points — so existing rows match what new imports write.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { Client } from 'pg';
import { splitOwnerTenantPhones, cleanPhoneField } from '../src/lib/whatsapp';

const APPLY = process.argv.includes('--apply');
const PREVIEW = 20;

// One-shot script: prefer DIRECT_URL (session pooler 5432), like the other scripts.
const connectionString = process.env.DIRECT_URL;
if (!connectionString) {
  console.error('Missing DIRECT_URL in .env.local');
  process.exit(1);
}

interface Row {
  id: string;
  apartment_number: string;
  phone_owner: string | null;
  phone_tenant: string | null;
}

/** Derive the clean {owner, tenant} from the current fields, using shared helpers.
 *  The owner field may be compound ("X (בעלים) Y (שוכר/ת)") — split it; a separate
 *  tenant-field number is cleaned and kept as the tenant when not already set. */
function computeClean(
  phoneOwner: string | null,
  phoneTenant: string | null,
): { owner: string | null; tenant: string | null } {
  const split = splitOwnerTenantPhones(phoneOwner);
  let owner = split.owner;
  let tenant = split.tenant;
  if (!tenant) {
    const t = cleanPhoneField(phoneTenant);
    if (t && t !== owner) tenant = t;
  }
  return { owner, tenant };
}

const norm = (v: string | null): string | null => (v && v.length ? v : null);
const changed = (a: string | null, b: string | null): boolean => norm(a) !== norm(b);

async function main(): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<Row>(
      `select id, apartment_number, phone_owner, phone_tenant
         from public.debtors
        order by apartment_number`,
    );

    const updates: Array<{ row: Row; to: { owner: string | null; tenant: string | null } }> = [];
    for (const r of rows) {
      const to = computeClean(r.phone_owner, r.phone_tenant);
      if (changed(r.phone_owner, to.owner) || changed(r.phone_tenant, to.tenant)) {
        updates.push({ row: r, to });
      }
    }

    // Safety: a row that loses a REAL (non-zero) number to both-null is a parse
    // gap worth reviewing before applying — scan the WHOLE dataset, not the preview.
    const suspicious = updates.filter(
      (u) =>
        u.to.owner === null &&
        u.to.tenant === null &&
        /[1-9]/.test(`${u.row.phone_owner ?? ''}${u.row.phone_tenant ?? ''}`),
    );

    console.log(`Total debtors:          ${rows.length}`);
    console.log(`Rows that would change: ${updates.length}`);
    console.log(`Both-null results:      ${updates.filter((u) => !u.to.owner && !u.to.tenant).length} (placeholders/empty)`);
    console.log(`⚠ Suspicious (real number lost): ${suspicious.length}`);
    for (const u of suspicious) {
      console.log(`    apt ${u.row.apartment_number}: owner=${JSON.stringify(u.row.phone_owner)} tenant=${JSON.stringify(u.row.phone_tenant)}`);
    }
    console.log(`\nPreview (first ${Math.min(PREVIEW, updates.length)}):`);
    for (const u of updates.slice(0, PREVIEW)) {
      console.log(`  apt ${u.row.apartment_number}:`);
      console.log(`    owner : ${JSON.stringify(u.row.phone_owner)}  →  ${JSON.stringify(u.to.owner)}`);
      console.log(`    tenant: ${JSON.stringify(u.row.phone_tenant)}  →  ${JSON.stringify(u.to.tenant)}`);
    }

    if (!APPLY) {
      console.log('\nDRY-RUN — nothing written. Re-run with --apply to backup + clean.');
      return;
    }

    console.log('\nApplying…');
    // Backup columns are added by migration 015; ensure-exists here is defensive.
    await client.query(`alter table public.debtors add column if not exists phone_owner_raw_backup text`);
    await client.query(`alter table public.debtors add column if not exists phone_tenant_raw_backup text`);
    const bk = await client.query(
      `update public.debtors
          set phone_owner_raw_backup  = phone_owner,
              phone_tenant_raw_backup = phone_tenant
        where phone_owner_raw_backup is null
          and phone_tenant_raw_backup is null`,
    );
    console.log(`Backed up ${bk.rowCount} rows into phone_*_raw_backup.`);

    let applied = 0;
    for (const u of updates) {
      await client.query(
        `update public.debtors set phone_owner = $2, phone_tenant = $3 where id = $1`,
        [u.row.id, u.to.owner, u.to.tenant],
      );
      applied++;
    }
    console.log(`Updated ${applied} rows.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
