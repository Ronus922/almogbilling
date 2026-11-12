import { describe, expect, it } from 'vitest';
import { pageCount, pageRange, pageWindow, parsePage, type PageSlot } from '@/lib/pagination';

// The arithmetic under <Pagination> and under the portal log's paging (12/11/2026): which
// rows a page shows, how many pages there are, which numbers the control draws.

describe('parsePage', () => {
  it('is the number for a positive integer', () => {
    expect(parsePage('1')).toBe(1);
    expect(parsePage('7')).toBe(7);
  });
  it('is page 1 for anything else', () => {
    for (const raw of [null, undefined, '', '0', '-3', 'abc', ' ']) {
      expect(parsePage(raw), String(raw)).toBe(1);
    }
  });
  it('reads the leading integer like the rest of the query parsing', () => {
    expect(parsePage('3.9')).toBe(3);
  });
  it('is capped, so page × size can never overflow the bigint OFFSET', () => {
    expect(parsePage('99999999999999999999')).toBe(100_000);
    expect(100_000 * 50).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('pageCount', () => {
  it('rounds up and is 0 for an empty result', () => {
    expect(pageCount(0, 50)).toBe(0);
    expect(pageCount(1, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(398, 50)).toBe(8);
  });
});

describe('pageRange — the "מציג 51–100 מתוך 398" caption', () => {
  it('is the 1-based inclusive range of the page', () => {
    expect(pageRange(1, 50, 398)).toEqual({ from: 1, to: 50 });
    expect(pageRange(2, 50, 398)).toEqual({ from: 51, to: 100 });
    expect(pageRange(8, 50, 398)).toEqual({ from: 351, to: 398 });
  });
  it('ends at the total on a short last page, and on a single short page', () => {
    expect(pageRange(3, 50, 120)).toEqual({ from: 101, to: 120 });
    expect(pageRange(1, 50, 7)).toEqual({ from: 1, to: 7 });
  });
  it('is 0–0 for an empty result and never runs past the total', () => {
    expect(pageRange(1, 50, 0)).toEqual({ from: 0, to: 0 });
    expect(pageRange(9, 50, 398)).toEqual({ from: 398, to: 398 });
  });
});

describe('pageWindow — the numbered buttons', () => {
  const nums = (slots: PageSlot[]) => slots.filter((s): s is number => typeof s === 'number');

  it('shows every number up to 7 pages, none above', () => {
    expect(pageWindow(1, 0)).toEqual([]);
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('near the start: 1 2 3 4 5 … N', () => {
    for (const p of [1, 2, 3, 4]) expect(pageWindow(p, 8), `page ${p}`).toEqual([1, 2, 3, 4, 5, 'gap-end', 8]);
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5, 'gap-end', 20]);
  });

  it('near the end: 1 … N-4 … N', () => {
    for (const p of [17, 18, 19, 20]) expect(pageWindow(p, 20), `page ${p}`).toEqual([1, 'gap-start', 16, 17, 18, 19, 20]);
    expect(pageWindow(5, 8)).toEqual([1, 'gap-start', 4, 5, 6, 7, 8]);
  });

  it('in the middle: 1 … p-1 p p+1 … N', () => {
    expect(pageWindow(10, 20)).toEqual([1, 'gap-start', 9, 10, 11, 'gap-end', 20]);
    expect(pageWindow(5, 20)).toEqual([1, 'gap-start', 4, 5, 6, 'gap-end', 20]);
    expect(pageWindow(16, 20)).toEqual([1, 'gap-start', 15, 16, 17, 'gap-end', 20]);
  });

  it('is always exactly 7 slots above 7 pages, always holds the first, the last and the current page', () => {
    for (const count of [8, 9, 12, 50, 400]) {
      for (let page = 1; page <= count; page++) {
        const w = pageWindow(page, count);
        expect(w, `${page}/${count}`).toHaveLength(7);
        expect(w[0]).toBe(1);
        expect(w[6]).toBe(count);
        expect(nums(w)).toContain(page);
        // ascending, no repeats, and the keys of the two gap markers never collide
        expect(nums(w)).toEqual([...new Set(nums(w))].sort((a, b) => a - b));
        expect(new Set(w).size).toBe(w.length);
      }
    }
  });

  it('clamps a page outside 1…N instead of drawing a window without it', () => {
    expect(pageWindow(0, 20)).toEqual(pageWindow(1, 20));
    expect(pageWindow(99, 20)).toEqual(pageWindow(20, 20));
  });
});
