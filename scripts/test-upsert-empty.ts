// scripts/test-upsert-empty.ts — verifies upsertContactByApartment merge rules
// when called DIRECTLY (the Track B sync path, bypassing the HTTP validation
// layer). Two behaviours under test:
//   1. allowedFields whitelist — fields outside it (notes, tags) are untouched.
//   2. empty owner_phone ('') must NOT clobber an existing phone.
//
// Run: npx tsx --tsconfig scripts/tsconfig.scripts.json scripts/test-upsert-empty.ts
//
// Uses the app's own pool (@/lib/db reads DATABASE_URL); the server-only guard
// is stubbed via scripts/tsconfig.scripts.json.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });
loadEnv({ path: '.env.local', override: true });

import {
  createContact,
  upsertContactByApartment,
  listContacts,
  getContactById,
  deleteContact,
} from '@/lib/db/contacts';

const APT = '999';

function check(label: string, actual: unknown, expected: unknown): boolean {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}` +
      (ok ? '' : ` — expected ${JSON.stringify(expected)}`),
  );
  return ok;
}

async function main(): Promise<number> {
  // 0) clean slate — drop any leftover apartment 999 from a previous run.
  for (const c of (await listContacts({ search: APT })).filter((x) => x.apartment_number === APT)) {
    await deleteContact(c.id);
  }

  // 1) seed a manual contact with an owner_phone + manual notes/tags.
  const seeded = await createContact(
    {
      apartment_number: APT,
      owner_name: 'בעלים ידני',
      owner_phone: '0501234567',
      notes: 'הערה ידנית',
      tags: ['ראשי'],
    },
    null,
  );
  console.log(`seeded contact id=${seeded.id} apt=${seeded.apartment_number}`);

  // 2) simulate a Bllink upsert: new owner_name, EMPTY owner_phone, new tenant —
  //    scoped to only the owner/tenant name+phone columns.
  const { contact, created } = await upsertContactByApartment(
    {
      apartment_number: APT,
      owner_name: 'בעלים מ-Bllink',
      owner_phone: '', // empty — must NOT overwrite the existing phone
      tenant_name: 'שוכר חדש',
    },
    {
      allowedFields: [
        'apartment_number',
        'owner_name',
        'owner_phone',
        'tenant_name',
        'tenant_phone',
      ],
    },
  );

  // 3) assert against the freshly-persisted row.
  const fresh = await getContactById(contact.id);
  if (!fresh) {
    console.error('FATAL: contact vanished after upsert');
    return 1;
  }

  console.log('after upsert:');
  let pass = 0;
  let fail = 0;
  const tally = (ok: boolean) => (ok ? pass++ : fail++);

  tally(check('created flag (was an update)', created, false));
  tally(check('owner_name overwritten', fresh.owner_name, 'בעלים מ-Bllink'));
  tally(check("owner_phone preserved (empty '' did NOT clobber)", fresh.owner_phone, '0501234567'));
  tally(check('tenant_name added', fresh.tenant_name, 'שוכר חדש'));
  tally(check('notes untouched (not in allowedFields)', fresh.notes, 'הערה ידנית'));
  tally(check('tags untouched (not in allowedFields)', fresh.tags, ['ראשי']));

  // 4) cleanup.
  await deleteContact(fresh.id);
  console.log('cleaned up apartment 999.');

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  return fail === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
