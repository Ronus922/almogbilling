import { describe, expect, it } from 'vitest';
import {
  DELETABLE,
  SAFETY_MAX_FRACTION,
  SAFETY_MIN_ABSOLUTE,
  STAGED_MAX_AGE_H,
  classify,
  dbRefsLookBroken,
  exceedsSafetyLimit,
  planBucket,
  waMediaKeyFromUrl,
  type ClassifiedObject,
  type DbRef,
} from '@/lib/storage/cleanup';

// Frozen clock — never Date.now() inside an assertion.
const NOW = new Date('2026-09-16T06:00:00Z');
const H = 3600_000;

function ref(over: Partial<DbRef> = {}): DbRef {
  return {
    key: 'k',
    table: 'wa_campaign_attachments',
    column: 'object_key',
    rowId: 'r1',
    bound: false,
    createdAt: new Date(NOW.getTime() - 48 * H),
    ...over,
  };
}

describe('classify — what an object is decides whether it can ever be deleted', () => {
  it('no DB row anywhere → zombie (the campaign-deleted case)', () => {
    expect(classify({ key: 'a.png' }, [], NOW)).toBe('zombie');
  });

  it('one bound ref wins over any number of unbound ones → linked, never touched', () => {
    expect(classify({ key: 'a.png' }, [ref(), ref({ bound: true })], NOW)).toBe('linked');
  });

  it('all refs unbound and old → staged_old (the upload that was never sent)', () => {
    expect(classify({ key: 'a.png' }, [ref()], NOW)).toBe('staged_old');
  });

  it('one fresh unbound ref keeps the whole object staged — a compose window may be open', () => {
    expect(classify({ key: 'a.png' }, [ref(), ref({ createdAt: NOW })], NOW)).toBe('staged');
  });

  it('is exact at the 24h boundary', () => {
    const justOld = new Date(NOW.getTime() - STAGED_MAX_AGE_H * H - 1000);
    const justFresh = new Date(NOW.getTime() - STAGED_MAX_AGE_H * H + 1000);
    expect(classify({ key: 'a' }, [ref({ createdAt: justOld })], NOW)).toBe('staged_old');
    expect(classify({ key: 'a' }, [ref({ createdAt: justFresh })], NOW)).toBe('staged');
  });

  it('fail-safe: an unknown timestamp can never make a set "all old"', () => {
    expect(classify({ key: 'a' }, [ref({ createdAt: null })], NOW)).toBe('staged');
    expect(classify({ key: 'a' }, [ref(), ref({ createdAt: null })], NOW)).toBe('staged');
  });

  it('the _trash/ prefix is checked BEFORE bound — parking a live object there would reclassify it', () => {
    expect(classify({ key: '_trash/a.png' }, [ref({ bound: true })], NOW)).toBe('trash');
  });

  it('only zombie and staged_old are ever deletable', () => {
    expect([...DELETABLE].sort()).toEqual(['staged_old', 'zombie']);
    for (const c of ['linked', 'staged', 'trash'] as const) expect(DELETABLE).not.toContain(c);
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

  it('a sweep of at most SAFETY_MIN_ABSOLUTE is exempt — on a 4-object bucket every fraction is noise', () => {
    // 1 of 4 = 25% would otherwise block a legitimate single delete.
    expect(exceedsSafetyLimit(1, 4)).toBe(false);
    expect(exceedsSafetyLimit(SAFETY_MIN_ABSOLUTE, 6)).toBe(false);
    // …but past the floor the fraction rules again.
    expect(exceedsSafetyLimit(SAFETY_MIN_ABSOLUTE + 1, 7)).toBe(true);
  });

  it('the real production shape: 1 zombie of 43 issue-attachments passes', () => {
    expect(exceedsSafetyLimit(1, 43)).toBe(false);
  });

  it('the failure it exists for: a broken query making everything look deletable', () => {
    expect(exceedsSafetyLimit(43, 43)).toBe(true);
    expect(SAFETY_MAX_FRACTION).toBe(0.2);
  });
});

describe('dbRefsLookBroken — the sharper guard the fraction brake only approximates', () => {
  it('objects but zero DB pointers = a query returned nothing', () => {
    expect(dbRefsLookBroken(43, 0)).toBe(true);
  });

  it('an empty bucket is fine, and so is any bucket that produced pointers', () => {
    expect(dbRefsLookBroken(0, 0)).toBe(false);
    expect(dbRefsLookBroken(43, 42)).toBe(false);
  });
});

function obj(key: string, category: ClassifiedObject['category'], sizeBytes = 100): ClassifiedObject {
  return {
    bucket: 'issue-attachments',
    key,
    sizeBytes,
    createdAt: NOW,
    updatedAt: NOW,
    category,
    refs: [],
  };
}

describe('planBucket — the delete list is resolved once and is exact', () => {
  it('selects only zombie and staged_old, and leaves live content alone', () => {
    const objects = [
      obj('live.png', 'linked'),
      obj('fresh.png', 'staged'),
      obj('old.png', 'staged_old'),
      obj('ghost.png', 'zombie'),
      obj('_trash/x.png', 'trash'),
    ];
    const p = planBucket('issue-attachments', objects, 4);
    expect(p.blocked).toBeNull();
    expect(p.toDelete.map((o) => o.key).sort()).toEqual(['ghost.png', 'old.png']);
    expect(p.bytes).toBe(200);
  });

  it('a blocked bucket reports an EMPTY delete list, so a caller ignoring `blocked` still deletes nothing', () => {
    const objects = Array.from({ length: 50 }, (_, i) => obj(`z${i}.png`, 'zombie'));
    const p = planBucket('issue-attachments', objects, 1);
    expect(p.blocked).toBe('safety_fraction');
    expect(p.toDelete).toEqual([]);
    expect(p.bytes).toBe(0);
  });

  it('the missing-refs guard trips even when the count is under the fraction floor', () => {
    // 2 objects, both zombies, zero refs: the fraction floor alone would allow it.
    const p = planBucket('whatsapp-attachments', [obj('a', 'zombie'), obj('b', 'zombie')], 0);
    expect(exceedsSafetyLimit(2, 2)).toBe(false); // floor would have passed it
    expect(p.blocked).toBe('db_refs_missing'); // …the sharper guard does not
    expect(p.toDelete).toEqual([]);
  });

  it('an all-linked bucket plans nothing and is not blocked', () => {
    const p = planBucket('whatsapp-media', [obj('a', 'linked'), obj('b', 'linked')], 2);
    expect(p.blocked).toBeNull();
    expect(p.toDelete).toEqual([]);
  });
});

describe('waMediaKeyFromUrl', () => {
  it('extracts the key from a relative and an absolute proxy URL', () => {
    expect(waMediaKeyFromUrl('/api/public/wa-media/a/b.png')).toBe('a/b.png');
    expect(waMediaKeyFromUrl('https://x.example/api/public/wa-media/a/b.png?v=2')).toBe('a/b.png');
  });

  it('percent-decodes each segment', () => {
    expect(waMediaKeyFromUrl('/api/public/wa-media/a%20b/c%2Bd.png')).toBe('a b/c+d.png');
  });

  it('returns null for anything that is not ours — Green API media must never be selected', () => {
    expect(waMediaKeyFromUrl('https://do-media-7107.fra1.digitaloceanspaces.com/x.jpg')).toBeNull();
    expect(waMediaKeyFromUrl('/api/files/documents/a.pdf')).toBeNull();
    expect(waMediaKeyFromUrl(null)).toBeNull();
    expect(waMediaKeyFromUrl('/api/public/wa-media/')).toBeNull();
  });
});
