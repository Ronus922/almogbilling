import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { compressVisitorImage } from '@/lib/visitors/image';
import { convertStoredWebp, type PhotoStore } from '@/lib/visitors/convertStored';

// The one-off conversion of stored WebP photos to the final JPEG (09/11/2026), against a REAL
// database and a stand-in Storage: what it changes, what it never touches, and what it does when
// something goes wrong half-way. Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL).
// Every row it creates is removed by the exact id it recorded (CLAUDE.md iron rule 12).
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;
/** ONE connection for the converter: its begin / update / commit must share a session. */
let conn: PoolClient;
const RUN = Date.now().toString(36);
const scanIds: string[] = [];

/** A Storage in memory that remembers what was uploaded and removed, and can be told to misbehave. */
function makeStore(objects: Map<string, Buffer>, opts: { failUpload?: boolean; refuseRemove?: Set<string> } = {}) {
  const log = { uploaded: [] as string[], removed: [] as string[] };
  const store: PhotoStore = {
    async download(key) { return objects.get(key) ?? null; },
    async upload(key, bytes) {
      if (opts.failUpload) throw new Error('storage down');
      objects.set(key, bytes);
      log.uploaded.push(key);
    },
    async remove(key) {
      log.removed.push(key);
      if (opts.refuseRemove?.has(key)) return false;
      objects.delete(key);
      return true;
    },
  };
  return { store, log };
}

async function webpPhoto(w = 1800, h = 1200): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } }).webp({ quality: 80 }).toBuffer();
}

async function seedScan(key: string, bytes: number | null): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into public.visitor_scans (document_type, document_number, first_name, last_name, date_of_birth,
       image_object_key, image_bytes, scanned_by_name)
     values ('id_card', '123456789', 'דוד', $1, '1990-05-17', $2, $3, 'בודק') returning id`,
    [`VCV${RUN}`, key, bytes],
  );
  scanIds.push(r.rows[0]!.id);
  return r.rows[0]!.id;
}
const rowOf = async (id: string) =>
  (await pool.query<{ image_object_key: string; image_bytes: number | null }>(`select image_object_key, image_bytes from public.visitor_scans where id = $1`, [id])).rows[0]!;

function deps(store: PhotoStore, over: Partial<Parameters<typeof convertStoredWebp>[0]> = {}) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      db: { query: (t: string, p?: unknown[]) => conn.query(t, p) },
      store,
      compress: compressVisitorImage,
      newKey: (ext: string) => `${randomUUID()}.${ext}`,
      log: (l: string) => { lines.push(l); },
      ...over,
    } as Parameters<typeof convertStoredWebp>[0],
  };
}

beforeAll(async () => {
  if (!TEST_URL) return;
  pool = new Pool({ connectionString: TEST_URL, max: 3 });
  conn = await pool.connect();
});

// A row a test leaves ending in .webp (a failure it provoked on purpose) must not be seen by the next test.
afterEach(async () => {
  if (!pool || scanIds.length === 0) return;
  await pool.query(
    `update public.visitor_scans set image_object_key = replace(image_object_key, '.webp', '.parked')
      where id = any($1::uuid[]) and image_object_key ~* '\.webp$'`,
    [scanIds],
  );
});

afterAll(async () => {
  if (!pool) return;
  conn.release();
  if (scanIds.length > 0) {
    await pool.query(`delete from public.audit_log where entity_type = 'visitor_scan' and entity_id = any($1::text[])`, [scanIds]);
    await pool.query(`delete from public.visitor_scans where id = any($1::uuid[])`, [scanIds]);
  }
  await pool.end();
});

d('convertStoredWebp', () => {
  it('dry run (the default) reports what it would convert and changes nothing', async () => {
    const key = `${randomUUID()}.webp`;
    const id = await seedScan(key, 111);
    const objects = new Map([[key, await webpPhoto()]]);
    const { store, log } = makeStore(objects);
    const { deps: dp, lines } = deps(store);

    const report = await convertStoredWebp(dp, { apply: false });

    expect(report.dryRun).toBe(true);
    expect(report.found).toBeGreaterThanOrEqual(1);
    expect(report.converted).toBe(0);
    expect(lines.some((l) => l.includes(id))).toBe(true);
    expect(log.uploaded).toHaveLength(0);
    expect(log.removed).toHaveLength(0);
    expect(await rowOf(id)).toEqual({ image_object_key: key, image_bytes: 111 });
  });

  it('converts a WebP row: a JPEG under 300KB, the row repointed, the WebP removed, one audit row, nothing deleted', async () => {
    const key = `${randomUUID()}.webp`;
    const id = await seedScan(key, 1);
    const objects = new Map([[key, await webpPhoto()]]);
    const { store, log } = makeStore(objects);
    const { deps: dp } = deps(store);

    const report = await convertStoredWebp(dp, { apply: true });

    expect(report.converted).toBeGreaterThanOrEqual(1);
    expect(report.failed).toEqual([]);
    const after = await rowOf(id);
    expect(after.image_object_key).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(after.image_object_key).not.toBe(key);
    const jpeg = objects.get(after.image_object_key)!;
    expect(jpeg).toBeDefined();
    expect((await sharp(jpeg).metadata()).format).toBe('jpeg');
    expect(jpeg.length).toBeLessThanOrEqual(300 * 1024);
    expect(after.image_bytes).toBe(jpeg.length);
    expect(objects.has(key)).toBe(false); // the WebP object is gone
    expect(log.removed).toContain(key);
    // the row, with every other field, is still there
    const full = (await pool.query(`select first_name, last_name, document_number from public.visitor_scans where id = $1`, [id])).rows[0];
    expect(full).toMatchObject({ first_name: 'דוד', last_name: `VCV${RUN}`, document_number: '123456789' });
    const audit = await pool.query(`select action, actor_user_id, metadata from public.audit_log where entity_type = 'visitor_scan' and entity_id = $1`, [id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: 'image_converted', actor_user_id: null });
    expect(audit.rows[0].metadata).toMatchObject({ old_object_key: key, new_object_key: after.image_object_key, new_image_bytes: jpeg.length });
  });

  it('never touches a row that is already a JPEG, and a second run finds nothing to do', async () => {
    const jpegKey = `${randomUUID()}.jpg`;
    const id = await seedScan(jpegKey, 4242);
    const objects = new Map([[jpegKey, await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } }).jpeg().toBuffer()]]);
    const { store, log } = makeStore(objects);
    await convertStoredWebp(deps(store).deps, { apply: true });
    expect(await rowOf(id)).toEqual({ image_object_key: jpegKey, image_bytes: 4242 });
    expect(log.removed).not.toContain(jpegKey);

    const again = await convertStoredWebp(deps(store).deps, { apply: true });
    expect(again.found).toBe(0);
    expect(again.converted).toBe(0);
  });

  it('a missing object is reported and the row is left exactly as it was', async () => {
    const key = `${randomUUID()}.webp`;
    const id = await seedScan(key, 5);
    const { store } = makeStore(new Map());
    const report = await convertStoredWebp(deps(store).deps, { apply: true });
    expect(report.failed).toContainEqual({ id, key, reason: 'object_missing' });
    expect(await rowOf(id)).toEqual({ image_object_key: key, image_bytes: 5 });
  });

  it('an unreadable object is reported, the row and the object stay', async () => {
    const key = `${randomUUID()}.webp`;
    const id = await seedScan(key, 6);
    const objects = new Map([[key, Buffer.from('this is not a picture')]]);
    const { store, log } = makeStore(objects);
    const report = await convertStoredWebp(deps(store).deps, { apply: true });
    expect(report.failed).toContainEqual({ id, key, reason: 'unreadable' });
    expect(await rowOf(id)).toEqual({ image_object_key: key, image_bytes: 6 });
    expect(objects.has(key)).toBe(true);
    expect(log.uploaded).toHaveLength(0);
  });

  it('a failed upload leaves the row and the WebP alone', async () => {
    const key = `${randomUUID()}.webp`;
    const id = await seedScan(key, 7);
    const objects = new Map([[key, await webpPhoto()]]);
    const { store } = makeStore(objects, { failUpload: true });
    const report = await convertStoredWebp(deps(store).deps, { apply: true });
    expect(report.failed).toContainEqual({ id, key, reason: 'upload_failed' });
    expect(await rowOf(id)).toEqual({ image_object_key: key, image_bytes: 7 });
    expect(objects.has(key)).toBe(true);
  });

  it('a row replaced meanwhile (its key no longer the one read) is left alone and the spare JPEG is removed again', async () => {
    const key = `${randomUUID()}.webp`;
    const id = await seedScan(key, 8);
    const elsewhere = `${randomUUID()}.jpg`;
    const objects = new Map([[key, await webpPhoto()]]);
    const { store, log } = makeStore(objects);
    // Someone re-crops the photo between the read of the row and the update: the store's upload is the moment.
    const racing: PhotoStore = {
      ...store,
      async upload(k, b, ct) {
        await store.upload(k, b, ct);
        await pool.query(`update public.visitor_scans set image_object_key = $2 where id = $1`, [id, elsewhere]);
      },
    };
    const report = await convertStoredWebp(deps(racing).deps, { apply: true });
    expect(report.failed).toContainEqual({ id, key, reason: 'row_changed' });
    expect((await rowOf(id)).image_object_key).toBe(elsewhere); // the other writer's key stands
    expect(log.uploaded).toHaveLength(1);
    expect(log.removed).toContain(log.uploaded[0]); // our spare JPEG is cleaned up
    expect(log.removed).not.toContain(elsewhere);
    expect(objects.has(key)).toBe(true); // and the WebP it started from is not removed either
    expect((await pool.query(`select 1 from public.audit_log where entity_type = 'visitor_scan' and entity_id = $1`, [id])).rows).toHaveLength(0);
  });

  it('if the old WebP cannot be removed the row is already right: it is reported as left over, not as a failure', async () => {
    const key = `${randomUUID()}.webp`;
    const id = await seedScan(key, 9);
    const objects = new Map([[key, await webpPhoto()]]);
    const { store } = makeStore(objects, { refuseRemove: new Set([key]) });
    const report = await convertStoredWebp(deps(store).deps, { apply: true });
    expect(report.failed.filter((f) => f.id === id)).toEqual([]);
    expect(report.leftoverOldKeys).toContain(key);
    expect((await rowOf(id)).image_object_key).toMatch(/\.jpg$/);
  });
});
