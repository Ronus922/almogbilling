import { describe, expect, it } from 'vitest';
import {
  DELETABLE,
  SAFETY_MAX_FRACTION,
  SAFETY_MIN_ABSOLUTE,
  STAGED_MAX_AGE_H,
  ZOMBIE_MIN_AGE_H,
  classify,
  classifyBucket,
  dbRefsLookBroken,
  exceedsSafetyLimit,
  isBillingBucket,
  planBucket,
  refsMatchedNothing,
  storageRefFromUrl,
  isStagedRefTable,
  rowsToMarkDeleted,
  STAGED_REF_TABLES,
  waMediaKeyFromUrl,
  type ClassifiedObject,
  type DbRef,
  type StorageObject,
} from '@/lib/storage/cleanup';

// Frozen clock — never Date.now() inside an assertion.
const NOW = new Date('2026-09-16T06:00:00Z');
const H = 3600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * H);

function ref(over: Partial<DbRef> = {}): DbRef {
  return {
    key: 'k',
    table: 'wa_campaign_attachments',
    column: 'object_key',
    rowId: 'r1',
    bound: false,
    createdAt: ago(48),
    ...over,
  };
}

const OLD = { key: 'a.png', createdAt: ago(48) };

describe('classify — what an object is decides whether it can ever be deleted', () => {
  it('no DB row anywhere, and old enough → zombie (the campaign-deleted case)', () => {
    expect(classify(OLD, [], NOW)).toBe('zombie');
  });

  it('one bound ref wins over any number of unbound ones → linked, never touched', () => {
    expect(classify(OLD, [ref(), ref({ bound: true })], NOW)).toBe('linked');
  });

  it('all refs unbound and old → staged_old (the upload that was never sent)', () => {
    expect(classify(OLD, [ref()], NOW)).toBe('staged_old');
  });

  it('one fresh unbound ref keeps the whole object staged — a compose window may be open', () => {
    expect(classify(OLD, [ref(), ref({ createdAt: NOW })], NOW)).toBe('staged');
  });

  it('is exact at the 24h staged boundary', () => {
    expect(classify(OLD, [ref({ createdAt: ago(STAGED_MAX_AGE_H + 0.001) })], NOW)).toBe('staged_old');
    expect(classify(OLD, [ref({ createdAt: ago(STAGED_MAX_AGE_H - 0.001) })], NOW)).toBe('staged');
  });

  it('fail-safe: an unknown ref timestamp can never make a set "all old"', () => {
    expect(classify(OLD, [ref({ createdAt: null })], NOW)).toBe('staged');
    expect(classify(OLD, [ref(), ref({ createdAt: null })], NOW)).toBe('staged');
  });

  it('the _trash/ prefix is checked BEFORE bound — parking a live object there would reclassify it', () => {
    expect(classify({ key: '_trash/a.png', createdAt: ago(48) }, [ref({ bound: true })], NOW)).toBe('trash');
  });

  it('only zombie and staged_old are ever deletable', () => {
    expect([...DELETABLE].sort()).toEqual(['staged_old', 'zombie']);
    for (const c of ['linked', 'staged', 'zombie_fresh', 'trash'] as const) expect(DELETABLE).not.toContain(c);
  });
});

describe('classify — the zombie age floor closes the upload race', () => {
  // Every upload path writes the OBJECT first and its DB row a moment later, so
  // a brand-new object with no row is far more likely to be in flight than dead.
  it('a seconds-old object with no DB row is zombie_fresh, NOT zombie', () => {
    expect(classify({ key: 'a.png', createdAt: new Date(NOW.getTime() - 2000) }, [], NOW)).toBe('zombie_fresh');
  });

  it('is exact at the ZOMBIE_MIN_AGE_H boundary', () => {
    expect(classify({ key: 'a', createdAt: ago(ZOMBIE_MIN_AGE_H + 0.001) }, [], NOW)).toBe('zombie');
    expect(classify({ key: 'a', createdAt: ago(ZOMBIE_MIN_AGE_H - 0.001) }, [], NOW)).toBe('zombie_fresh');
  });

  it('an object whose age is unknown is never a zombie', () => {
    expect(classify({ key: 'a', createdAt: null }, [], NOW)).toBe('zombie_fresh');
  });

  it('a clock skew that puts createdAt in the future still does not delete', () => {
    expect(classify({ key: 'a', createdAt: new Date(NOW.getTime() + 10 * H) }, [], NOW)).toBe('zombie_fresh');
  });
});

describe('exceedsSafetyLimit — the 20% circuit breaker', () => {
  it('is strict at exactly 20%: 20.0% passes, a hair over trips', () => {
    expect(exceedsSafetyLimit(20, 100)).toBe(false);
    expect(exceedsSafetyLimit(21, 100)).toBe(true);
  });

  it('an empty bucket is never a breach (0 of 0)', () => {
    expect(exceedsSafetyLimit(0, 0)).toBe(false);
  });

  it('exactly one object is exempt — on a 4-object bucket a single delete is 25%', () => {
    expect(SAFETY_MIN_ABSOLUTE).toBe(1);
    expect(exceedsSafetyLimit(1, 4)).toBe(false);
  });

  it('the exemption caps the blast radius at ONE object: two of four still trips', () => {
    expect(exceedsSafetyLimit(2, 4)).toBe(true);
    // the whole of a five-object bucket can never go in one run
    expect(exceedsSafetyLimit(5, 5)).toBe(true);
  });

  it('the real production shape: 1 zombie of 43 issue-attachments passes', () => {
    expect(exceedsSafetyLimit(1, 43)).toBe(false);
  });

  it('the failure it exists for: a broken query making everything look deletable', () => {
    expect(exceedsSafetyLimit(43, 43)).toBe(true);
    expect(SAFETY_MAX_FRACTION).toBe(0.2);
  });
});

describe('dbRefsLookBroken / refsMatchedNothing — the two sharper guards', () => {
  it('objects but zero DB pointers = a query returned nothing', () => {
    expect(dbRefsLookBroken(43, 0)).toBe(true);
    expect(dbRefsLookBroken(0, 0)).toBe(false);
    expect(dbRefsLookBroken(43, 42)).toBe(false);
  });

  it('plenty of pointers but not one matches = a key-format change', () => {
    expect(refsMatchedNothing(5, 5, 0)).toBe(true);
    expect(refsMatchedNothing(5, 5, 1)).toBe(false);
    expect(refsMatchedNothing(0, 5, 0)).toBe(false);
    expect(refsMatchedNothing(5, 0, 0)).toBe(false); // that is dbRefsLookBroken's case
  });
});

function obj(key: string, category: ClassifiedObject['category'], sizeBytes = 100): ClassifiedObject {
  return { bucket: 'issue-attachments', key, sizeBytes, createdAt: ago(48), updatedAt: NOW, category, refs: [] };
}
const input = (objects: ClassifiedObject[], refCount: number, matchedRefs = refCount, unknown = false) => ({
  objects,
  refCount,
  matchedRefs,
  sawUnknownBucketValues: unknown,
});

describe('planBucket — the delete list is resolved once and is exact', () => {
  it('selects only zombie and staged_old, and leaves live content alone', () => {
    // 2 deletable out of 20 = 10%, comfortably under the 20% brake.
    const objects = [
      ...Array.from({ length: 16 }, (_, i) => obj(`live${i}.png`, 'linked')),
      obj('fresh.png', 'staged'),
      obj('new.png', 'zombie_fresh'),
      obj('old.png', 'staged_old'),
      obj('ghost.png', 'zombie'),
      obj('_trash/x.png', 'trash'),
    ];
    const p = planBucket('issue-attachments', input(objects, 17));
    expect(p.blocked).toBeNull();
    expect(p.toDelete.map((o) => o.key).sort()).toEqual(['ghost.png', 'old.png']);
    expect(p.bytes).toBe(200);
  });

  it('a blocked bucket reports an EMPTY delete list, so a caller ignoring `blocked` deletes nothing', () => {
    const objects = Array.from({ length: 50 }, (_, i) => obj(`z${i}.png`, 'zombie'));
    const p = planBucket('issue-attachments', input(objects, 1));
    expect(p.blocked).toBe('safety_fraction');
    expect(p.toDelete).toEqual([]);
  });

  it('…but a blocked bucket KEEPS its candidates, which is the evidence the dry run exists to collect', () => {
    const objects = Array.from({ length: 50 }, (_, i) => obj(`z${i}.png`, 'zombie'));
    const p = planBucket('issue-attachments', input(objects, 1));
    expect(p.candidates).toHaveLength(50);
    expect(p.candidates[0].key).toBe('z0.png');
  });

  it('the missing-refs guard trips even when the count is under the exemption floor', () => {
    const p = planBucket('whatsapp-attachments', input([obj('a', 'zombie')], 0));
    expect(exceedsSafetyLimit(1, 1)).toBe(false); // the floor alone would have allowed it
    expect(p.blocked).toBe('db_refs_missing'); // …the sharper guard does not
    expect(p.toDelete).toEqual([]);
  });

  it('a key-format change (refs healthy, none matching) blocks the bucket', () => {
    const objects = Array.from({ length: 5 }, (_, i) => obj(`a${i}`, 'zombie'));
    const p = planBucket('whatsapp-attachments', input(objects, 5, 0));
    expect(p.blocked).toBe('db_refs_matched_nothing');
    expect(p.toDelete).toEqual([]);
  });

  it('an unrecognised bucket name anywhere in the DB stops every bucket', () => {
    const p = planBucket('documents', input([obj('ghost', 'zombie')], 10, 10, true));
    expect(p.blocked).toBe('unknown_bucket_values');
    expect(p.toDelete).toEqual([]);
  });

  it('an all-linked bucket plans nothing and is not blocked', () => {
    const p = planBucket('whatsapp-media', input([obj('a', 'linked'), obj('b', 'linked')], 2));
    expect(p.blocked).toBeNull();
    expect(p.toDelete).toEqual([]);
  });
});

describe('classifyBucket — matchedRefs is what the third guard reads', () => {
  const stored = (key: string): StorageObject => ({
    bucket: 'documents',
    key,
    sizeBytes: 10,
    createdAt: ago(48),
    updatedAt: NOW,
  });

  it('counts refs that point at an object actually present, and reports the rest as orphan rows', () => {
    const r = classifyBucket(
      'documents',
      [stored('a'), stored('b')],
      [ref({ key: 'a', bound: true }), ref({ key: 'gone', bound: true })],
      NOW,
    );
    expect(r.matchedRefs).toBe(1);
    expect(r.orphanRows.map((o) => o.key)).toEqual(['gone']);
    expect(r.objects.find((o) => o.key === 'a')?.category).toBe('linked');
    expect(r.objects.find((o) => o.key === 'b')?.category).toBe('zombie');
  });
});

describe('storageRefFromUrl — both live proxy shapes, and nothing else', () => {
  it('the public wa-media proxy resolves to whatsapp-media', () => {
    expect(storageRefFromUrl('/api/public/wa-media/a/b.png')).toEqual({ bucket: 'whatsapp-media', key: 'a/b.png' });
    expect(storageRefFromUrl('https://x.example/api/public/wa-media/a/b.png?v=2')).toEqual({
      bucket: 'whatsapp-media',
      key: 'a/b.png',
    });
  });

  it('the authenticated /api/files proxy resolves to the bucket it names', () => {
    // 3 production chat_messages rows carry exactly this shape.
    expect(storageRefFromUrl('/api/files/whatsapp-attachments/dd64a926.pdf')).toEqual({
      bucket: 'whatsapp-attachments',
      key: 'dd64a926.pdf',
    });
    expect(storageRefFromUrl('/api/files/documents/tenant/42/x.pdf')).toEqual({
      bucket: 'documents',
      key: 'tenant/42/x.pdf',
    });
  });

  it('percent-decodes each segment', () => {
    expect(storageRefFromUrl('/api/public/wa-media/a%20b/c%2Bd.png')?.key).toBe('a b/c+d.png');
  });

  it('refuses a bucket outside the billing allowlist — another project must never be touched', () => {
    expect(storageRefFromUrl('/api/files/invoice-files/x.pdf')).toBeNull();
    expect(isBillingBucket('invoice-files')).toBe(false);
  });

  it('returns null for anything that is not ours — Green API media must never be selected', () => {
    expect(storageRefFromUrl('https://do-media-7107.fra1.digitaloceanspaces.com/x.jpg')).toBeNull();
    expect(storageRefFromUrl(null)).toBeNull();
    expect(storageRefFromUrl('/api/public/wa-media/')).toBeNull();
    expect(storageRefFromUrl('/api/files/documents')).toBeNull();
  });

  it('waMediaKeyFromUrl stays narrow: only the wa-media shape', () => {
    expect(waMediaKeyFromUrl('/api/public/wa-media/a.png')).toBe('a.png');
    expect(waMediaKeyFromUrl('/api/files/whatsapp-attachments/a.pdf')).toBeNull();
  });
});

describe('rowsToMarkDeleted — which attachment rows are stamped after a delete', () => {
  const staged = (key: string, refs: DbRef[]): ClassifiedObject => ({
    ...obj(key, 'staged_old'),
    refs,
  });

  it('collects the row ids of every staged_old object, grouped by table', () => {
    const got = rowsToMarkDeleted([
      staged('a.pdf', [ref({ key: 'a.pdf', rowId: 'c1', table: 'wa_campaign_attachments' })]),
      staged('b.pdf', [ref({ key: 'b.pdf', rowId: 'm1', table: 'wa_message_attachments' })]),
      staged('c.pdf', [ref({ key: 'c.pdf', rowId: 'c2', table: 'wa_campaign_attachments' })]),
    ]);
    expect(got.get('wa_campaign_attachments')).toEqual(['c1', 'c2']);
    expect(got.get('wa_message_attachments')).toEqual(['m1']);
  });

  it('NEVER marks a zombie — it has no row, so a match would be someone else\'s', () => {
    const zombie = { ...obj('z.png', 'zombie'), refs: [ref({ key: 'z.png', rowId: 'ghost' })] };
    expect(rowsToMarkDeleted([zombie]).size).toBe(0);
  });

  it('ignores the categories that are never deleted', () => {
    for (const category of ['linked', 'staged', 'zombie_fresh', 'trash'] as const) {
      const o = { ...obj('x.pdf', category), refs: [ref({ key: 'x.pdf', rowId: 'r9' })] };
      expect(rowsToMarkDeleted([o]).size).toBe(0);
    }
  });

  it('de-duplicates a row id that two refs of the same object produce', () => {
    const got = rowsToMarkDeleted([
      staged('a.pdf', [
        ref({ key: 'a.pdf', rowId: 'c1' }),
        ref({ key: 'a.pdf', rowId: 'c1' }),
      ]),
    ]);
    expect(got.get('wa_campaign_attachments')).toEqual(['c1']);
  });

  it('marks nothing when nothing was removed', () => {
    expect(rowsToMarkDeleted([]).size).toBe(0);
  });

  it('THROWS on a ref from any other table rather than guessing which row to touch', () => {
    const o = staged('d.pdf', [ref({ key: 'd.pdf', rowId: 'x1', table: 'documents' })]);
    expect(() => rowsToMarkDeleted([o])).toThrow(/unexpected table documents/);
  });

  it('only the staged attachment tables are accepted', () => {
    expect(STAGED_REF_TABLES).toEqual(['wa_campaign_attachments', 'wa_message_attachments', 'fin_documents']);
    expect(isStagedRefTable('fin_documents')).toBe(true);
    expect(isStagedRefTable('wa_message_attachments')).toBe(true);
    expect(isStagedRefTable('chat_messages')).toBe(false);
  });
});
