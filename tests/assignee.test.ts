import { describe, it, expect } from 'vitest';
import { coerceAssignees } from '@/lib/validation/assignee';

const U1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const U2 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const S1 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('coerceAssignees — mixed many-to-many handler model', () => {
  it('absent key → null (PATCH partial: leave the junction untouched)', () => {
    expect(coerceAssignees({ title: 'x' })).toBeNull();
  });

  it('explicit null / [] → ok with empty set (clear all)', () => {
    expect(coerceAssignees({ assignees: null })).toEqual({ ok: true, assignees: [] });
    expect(coerceAssignees({ assignees: [] })).toEqual({ ok: true, assignees: [] });
  });

  it('accepts a MIX of users and suppliers together', () => {
    const r = coerceAssignees({
      assignees: [
        { assignee_type: 'user', id: U1 },
        { assignee_type: 'supplier', id: S1 },
        { assignee_type: 'user', id: U2 },
      ],
    });
    expect(r).toEqual({
      ok: true,
      assignees: [
        { assignee_type: 'user', id: U1 },
        { assignee_type: 'supplier', id: S1 },
        { assignee_type: 'user', id: U2 },
      ],
    });
  });

  it('de-duplicates identical (kind,id) pairs', () => {
    const r = coerceAssignees({
      assignees: [
        { assignee_type: 'user', id: U1 },
        { assignee_type: 'user', id: U1 },
      ],
    });
    expect(r && r.ok).toBe(true);
    if (r && r.ok) expect(r.assignees).toEqual([{ assignee_type: 'user', id: U1 }]);
  });

  it('keeps same id under different kinds (user vs supplier are distinct)', () => {
    const r = coerceAssignees({
      assignees: [
        { assignee_type: 'user', id: U1 },
        { assignee_type: 'supplier', id: U1 },
      ],
    });
    expect(r && r.ok).toBe(true);
    if (r && r.ok) expect(r.assignees).toHaveLength(2);
  });

  it('rejects a non-array assignees', () => {
    const r = coerceAssignees({ assignees: 'nope' });
    expect(r).toEqual({ ok: false, error: 'invalid_assignees' });
  });

  it('rejects a bad kind', () => {
    const r = coerceAssignees({ assignees: [{ assignee_type: 'robot', id: U1 }] });
    expect(r).toEqual({ ok: false, error: 'invalid_assignee_type' });
  });

  it('rejects a non-uuid id', () => {
    const r = coerceAssignees({ assignees: [{ assignee_type: 'user', id: 'not-a-uuid' }] });
    expect(r).toEqual({ ok: false, error: 'invalid_assignee_id' });
  });

  it('rejects a non-object item', () => {
    const r = coerceAssignees({ assignees: ['nope'] });
    expect(r).toEqual({ ok: false, error: 'invalid_assignee_item' });
  });
});
