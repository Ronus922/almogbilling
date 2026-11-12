import { describe, expect, it } from 'vitest';
import { findPaidTransaction, flattenGrowCallback, flattenGrowJson, growSafeText } from '@/lib/grow/client';

// Grow's callback body (R/server-to-server-callback) and the verification
// rule: only statusCode 2 ("שולם") with exactly the order's total counts.

describe('flattenGrowCallback — form fields, flat or nested', () => {
  it('reads data[...] keys and customFields', () => {
    const out = flattenGrowCallback([
      ['status', '1'],
      ['err', ''],
      ['data[processId]', '332002'],
      ['data[processToken]', 'tok'],
      ['data[status]', 'שולם'],
      ['data[statusCode]', '2'],
      ['data[customFields][cField1]', 'order-1'],
    ]);
    expect(out.processId).toBe('332002');
    expect(out.processToken).toBe('tok');
    expect(out.statusCode).toBe('2');
    expect(out.cField1).toBe('order-1');
    // The envelope's "status: 1" never overwrites data's own status.
    expect(out.status).toBe('שולם');
  });

  it('keeps the nested field even when the envelope comes after it', () => {
    const out = flattenGrowCallback([['data[status]', 'שולם'], ['status', '1']]);
    expect(out.status).toBe('שולם');
  });

  it('reads flat keys', () => {
    expect(flattenGrowCallback([['processId', '1'], ['transactionId', '9']])).toEqual({ processId: '1', transactionId: '9' });
  });
});

describe('flattenGrowJson', () => {
  it('reads the JSON shape of the docs', () => {
    const out = flattenGrowJson({
      err: '',
      status: '1',
      data: { processId: '332002', sum: '269', customFields: { cField1: 'x' } },
    });
    expect(out).toMatchObject({ processId: '332002', sum: '269', cField1: 'x' });
  });
});

describe('findPaidTransaction', () => {
  const tx = (statusCode: number, sum: number) => ({ transactionId: 't', transactionToken: 'k', asmachta: 'a', statusCode, sum });
  it('needs statusCode 2 and the exact total', () => {
    expect(findPaidTransaction([tx(2, 170)], 170)).not.toBeNull();
    expect(findPaidTransaction([tx(0, 170)], 170)).toBeNull();
    expect(findPaidTransaction([tx(2, 100)], 170)).toBeNull();
    expect(findPaidTransaction([tx(9, 170), tx(2, 170)], 170)?.statusCode).toBe(2);
  });
});

describe('growSafeText — no special characters in a parameter', () => {
  it('keeps Hebrew letters, digits and spaces', () => {
    expect(growSafeText('הזמנה 1001 כרטיסי כניסה למעלית')).toBe('הזמנה 1001 כרטיסי כניסה למעלית');
    expect(growSafeText(`דנה "כהן" <script>`)).toBe('דנה כהן script');
  });
});
