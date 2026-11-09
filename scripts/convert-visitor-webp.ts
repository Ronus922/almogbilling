// scripts/convert-visitor-webp.ts - one-off: stored document photos saved as WebP -> JPEG.
//
//   npx tsx --tsconfig scripts/tsconfig.scripts.json scripts/convert-visitor-webp.ts            # DRY RUN (default)
//   npx tsx --tsconfig scripts/tsconfig.scripts.json scripts/convert-visitor-webp.ts --apply    # convert
//
// The unreleased 09/11/2026 build stored `<uuid>.webp`; the final form is a JPEG (a photo that has
// to open on any computer and travel to the police or a court). Each `.webp` row goes through the
// same pipeline as a new scan, its row is pointed at the new `<uuid>.jpg` (image_object_key,
// image_bytes) in one transaction with an `image_converted` audit row, and the WebP object is
// removed. NO ROW IS EVER DELETED. Safe to re-run: it only looks at rows that still end in .webp.
// The logic and its safety notes: src/lib/visitors/convertStored.ts.
//
// Reads DATABASE_URL / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the environment
// (systemd EnvironmentFile) or .env.local. Prints bare UUIDs and byte counts only - no names.
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { compressVisitorImage } from '../src/lib/visitors/image';
import { convertStoredWebp, type PhotoStore } from '../src/lib/visitors/convertStored';
import { storageClient } from './storage-audit';

dotenv.config({ path: '.env.local', quiet: true });

const BUCKET = 'visitor-ids';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const db = new Client({ connectionString: url });
  // An idle disconnect would otherwise be an unhandled 'error' event and kill the process mid-row.
  db.on('error', (err) => console.error('database connection error:', err.message));
  await db.connect();

  const sc = storageClient();
  const store: PhotoStore = {
    async download(key) {
      const { data, error } = await sc.from(BUCKET).download(key);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async upload(key, bytes, contentType) {
      const { error } = await sc.from(BUCKET).upload(key, bytes, { contentType, upsert: false });
      if (error) throw new Error(error.message);
    },
    async remove(key) {
      const { error } = await sc.from(BUCKET).remove([key]);
      return !error;
    },
  };

  try {
    const report = await convertStoredWebp(
      { db, store, compress: compressVisitorImage, newKey: (ext) => `${randomUUID()}.${ext}`, log: (line) => console.log(line) },
      { apply },
    );
    console.log(JSON.stringify(report, null, 2));
    if (!apply && report.found > 0) console.log('(dry run - nothing was changed; re-run with --apply)');
    if (report.failed.length > 0 || report.leftoverOldKeys.length > 0) process.exitCode = 2;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
