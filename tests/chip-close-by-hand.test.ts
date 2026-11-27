import { describe, expect, it } from 'vitest';
import { closeByHandStep } from '@/lib/chipOrders/model';

// "סגירה ידנית" (27/11/2026): the one rule of the window and the server for
// when a stuck "ביטול וזיכוי" may be closed by hand, and at which step.

const base = { cancel_requested: true, cancel_completed: false, cancel_failed_step: null, refund_status: null, refunded_at: null, document_failed: false } as const;

describe('closeByHandStep', () => {
  it('Morning refused a document of the order (it is failed) → the credit step; Morning merely not connected, or a document waiting its turn → null', () => {
    const credit = { ...base, cancel_failed_step: 'credit', refund_status: 'refunded', refunded_at: '2026-11-27T08:00:00Z' } as const;
    expect(closeByHandStep({ ...credit, document_failed: true })).toBe('credit');
    expect(closeByHandStep({ ...credit, document_failed: false })).toBeNull();
  });
  it('the refund step needs a person (no answer, refused, or more than one charge — manual_required, nothing recorded) → the refund step', () => {
    expect(closeByHandStep({ ...base, cancel_failed_step: 'refund', refund_status: 'manual_required' })).toBe('refund');
  });
  it('anything a retry may still settle, a run that never started or finished → null', () => {
    expect(closeByHandStep({ ...base, cancel_failed_step: 'refund' })).toBeNull(); // PayPlus could not be asked / not configured
    expect(closeByHandStep({ ...base, cancel_failed_step: 'refund', refund_status: 'partial', refunded_at: '2026-11-27T08:00:00Z' })).toBeNull();
    expect(closeByHandStep({ ...base, cancel_failed_step: 'cancel' })).toBeNull();
    expect(closeByHandStep({ ...base })).toBeNull();
    expect(closeByHandStep({ ...base, cancel_requested: false, cancel_failed_step: 'credit' })).toBeNull();
    expect(closeByHandStep({ ...base, cancel_completed: true, cancel_failed_step: 'credit' })).toBeNull();
  });
});
