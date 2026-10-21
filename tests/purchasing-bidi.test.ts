import { describe, expect, it } from 'vitest';
import { toVisual, wrapLogical } from '@/lib/purchasing/bidi';

const rev = (s: string) => Array.from(s).reverse().join('');

describe('toVisual (RTL paragraph for jsPDF)', () => {
  it('reverses a pure Hebrew string', () => {
    expect(toVisual('שלום עולם')).toBe(rev('שלום עולם'));
  });

  it('keeps digits in order inside Hebrew text, runs laid out right-to-left', () => {
    // logical: "סה״כ 12"  → page shows 12 at the LEFT of the word
    expect(toVisual('סה״כ 12')).toBe(`12 ${rev('סה״כ')}`);
  });

  it('does not mirror a phone number, a date or an amount', () => {
    expect(toVisual('טל׳ 04-8123456')).toBe(`04-8123456 ${rev('טל׳')}`);
    expect(toVisual('תאריך 21/10/2026')).toBe(`21/10/2026 ${rev('תאריך')}`);
    expect(toVisual('₪1,250.00')).toBe('₪1,250.00');
  });

  it('keeps an e-mail address and an English word intact', () => {
    expect(toVisual('מייל: info@almog.co.il')).toBe(`info@almog.co.il ${rev('מייל:')}`);
    expect(toVisual('חברת Almog בע״מ')).toBe(`${rev('בע״מ')} Almog ${rev('חברת')}`);
  });

  it('keeps a percent sign after its number', () => {
    expect(toVisual('מע״מ 18%')).toBe(`18% ${rev('מע״מ')}`);
  });

  it('mirrors brackets inside a Hebrew run', () => {
    expect(toVisual('(בדיקה)')).toBe(rev('(בדיקה)').replace(/[()]/g, (c) => (c === '(' ? ')' : '(')));
  });

  it('leaves an empty string alone', () => {
    expect(toVisual('')).toBe('');
  });
});

describe('wrapLogical', () => {
  const measure = (s: string) => s.length;
  it('wraps on spaces and keeps explicit newlines', () => {
    expect(wrapLogical('aaa bbb ccc', measure, 7)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapLogical('a\n\nb', measure, 10)).toEqual(['a', '', 'b']);
  });
  it('breaks a token wider than the box', () => {
    expect(wrapLogical('abcdefghij', measure, 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
});
